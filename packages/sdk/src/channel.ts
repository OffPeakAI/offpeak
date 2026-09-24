import { ChannelManagerAbi } from "@offpeak/abis"
import { CHAIN_ID, CHANNEL_MIN_LIFETIME_S, channelAuthHeader, coopCloseTypes, domain, voucherTypes, type Micro, type UsageEnvelope } from "@offpeak/shared"
import { bytesToHex, decodeFunctionData, encodeAbiParameters, erc20Abi, keccak256, type Address, type Hex, type PublicClient, type WalletClient } from "viem"
import { z } from "zod"
import { OffpeakError, addressSchema, assertChain, bytes32Schema, digitsSchema, errorFrom, hexSchema, nowSeconds, type ClientContext, type Signer } from "./core.ts"
import { overMaxPrice, type MaxPrice } from "./verify.ts"

const MIN_DEPOSIT_MICRO = 1_000_000n
const CLOSE_DEADLINE_S = 600
const SEEN_TIMEOUT_MS = 15_000
const SEEN_POLL_MS = 250
const RECEIPT_POLL_MS = 250
const STATUS_OPEN = 1

const channelView = z.object({ deposit: digitsSchema, claimed: digitsSchema, cumulative: digitsSchema, owed: digitsSchema, latestSeq: digitsSchema, status: z.number().int(), expiry: digitsSchema })

const closeReply = z.object({ routerSig: hexSchema, to: addressSchema, data: hexSchema, value: z.literal("0"), chainId: z.coerce.number().int() })

export type ChannelConfig = {
  deposit?: Micro
  expirySeconds?: number
  /** An open channel to use instead of opening one. */
  id?: string
  /** The `seq` and `cumulative` you kept from `snapshot()` for that channel. */
  known?: { seq: bigint; cumulative: Micro }
  /** Sign a voucher after each response. On unless you call `.voucher()` yourself. */
  autoVoucher?: boolean
}

export type VoucherReceipt = { seq: bigint; cumulative: Micro; sig: Hex; delivered: boolean }

export type ChannelSnapshot = {
  id: Hex
  deposit: Micro
  expiry: number
  seq: bigint
  /** The highest cumulative amount signed so far. */
  signed: Micro
  /** The total this client could match to verified usage records. */
  verified: Micro
  /** Owed amounts the router reported that are not signed yet. */
  unsigned: Micro[]
  /** Why vouchers stopped, until `.voucher(owed)` settles it. */
  refused: string | null
}

export type CloseResult =
  | { mode: "cooperative"; channelId: Hex; txHash: Hex; finalCumulative: Micro }
  | { mode: "challenge"; channelId: Hex; txHash: Hex; finalCumulative: Micro; challengeEndsAt: number; reason: string; notice: string }

type Active = {
  id: Hex
  deposit: Micro
  expiry: number
  seq: bigint
  signed: Micro
  accepted: Micro
  verified: Micro
  reported: Micro[]
  outbox: VoucherReceipt | null
  counted: Set<string>
  inFlight: number
  refused: string | null
}

export type Ticket = { channel: Active; voucher: VoucherReceipt | null; cap?: MaxPrice }

export type Finished = { owed?: Micro; envelope?: UsageEnvelope; delivered: boolean; voucherRefused?: boolean }

const encodeVoucher = (v: VoucherReceipt) => Buffer.from(JSON.stringify({ seq: v.seq.toString(), cumulative: v.cumulative.toString(), sig: v.sig })).toString("base64url")

export class Channels {
  private active: Active | null = null
  private starting: Promise<Active> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private auto: boolean

  constructor(
    private ctx: ClientContext,
    private config: ChannelConfig | undefined,
  ) {
    this.auto = config?.autoVoucher ?? true
  }

  /** True when requests should pay from a channel. */
  get inUse() {
    return Boolean(this.active || this.config?.id || this.config?.deposit)
  }

  snapshot(): ChannelSnapshot | null {
    const ch = this.active
    if (!ch) return null
    return { id: ch.id, deposit: ch.deposit, expiry: ch.expiry, seq: ch.seq, signed: ch.signed, verified: ch.verified, unsigned: ch.reported.filter((owed) => owed > ch.signed), refused: ch.refused }
  }

  /**
   * Opens a channel from your own wallet. `expiry` is a unix time at least 6 hours away.
   * The deposit stays yours except for what your vouchers cover.
   */
  async open(deposit: Micro, expiry: number | bigint): Promise<{ channelId: Hex; txHash: Hex; deposit: Micro; expiry: number }> {
    const signer = this.needSigner()
    const { reader, writer } = this.chain()
    this.checkBook()
    z.bigint().parse(deposit)
    const until = Number(expiry)
    if (!Number.isSafeInteger(until)) throw new OffpeakError("bad_channel", "expiry must be a unix time in seconds")
    if (deposit < MIN_DEPOSIT_MICRO) throw new OffpeakError("bad_channel", `Deposit must be at least ${MIN_DEPOSIT_MICRO} µUSDG`)
    if (until < nowSeconds() + CHANNEL_MIN_LIFETIME_S) throw new OffpeakError("bad_channel", "A channel must last at least 6 hours")
    if (this.active) throw new OffpeakError("channel_active", "A channel is already in use. Close it first.")
    await assertChain(writer)
    const manager = this.ctx.book.contract("ChannelManager")
    const usdg = this.ctx.book.contract("USDG")
    const account = writer.account!
    const allowance = await reader.readContract({ address: usdg, abi: erc20Abi, functionName: "allowance", args: [signer.address, manager] })
    if (allowance < deposit) await this.send(reader, writer, usdg, erc20Abi, "approve", [manager, deposit])
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const channelId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [account.address, salt]))
    const txHash = await this.send(reader, writer, manager, ChannelManagerAbi, "open", [deposit, BigInt(until), salt])
    this.active = this.fresh(channelId, deposit, until, 0n, 0n)
    await this.awaitRouter(channelId)
    return { channelId, txHash, deposit, expiry: until }
  }

  /**
   * Picks up an open channel, read from the chain. Pass the `seq` and `cumulative` you kept from
   * `snapshot()` when you have them. Debt from before this attach is never signed by itself, because
   * nothing here can check it: the router's `owed` shows under `unsigned`, and only `.voucher(owed)` takes it.
   */
  async attach(channelId: string, known?: { seq: bigint; cumulative: Micro }): Promise<ChannelSnapshot> {
    const signer = this.needSigner()
    this.checkBook()
    if (this.active) throw new OffpeakError("channel_active", "A channel is already in use. Close it first.")
    const id = bytes32Schema.parse(channelId)
    const reader = this.ctx.chain.reader()
    if (!reader) throw new OffpeakError("no_rpc", "Attaching to a channel reads it from the chain, which needs an RPC URL")
    const onChain = await reader.readContract({ address: this.ctx.book.contract("ChannelManager"), abi: ChannelManagerAbi, functionName: "channelView", args: [id] })
    if (onChain.status !== STATUS_OPEN) throw new OffpeakError("channel_not_open", "Channel is not open")
    if (onChain.payer.toLowerCase() !== signer.address) throw new OffpeakError("not_your_channel", "This wallet is not the channel's payer")
    const view = await this.read(id)
    if (!view) throw new OffpeakError("unknown_channel", "Router does not know this channel")
    const heard = BigInt(view.latestSeq) > onChain.lastSeq ? BigInt(view.latestSeq) : onChain.lastSeq
    const seq = known && known.seq > heard ? known.seq : heard
    const signed = known && known.cumulative > onChain.claimed ? known.cumulative : onChain.claimed
    const ch = this.fresh(id, onChain.deposit, Number(onChain.expiry), seq, signed)
    const owed = BigInt(view.owed)
    if (owed > signed) ch.reported.push(owed)
    this.active = ch
    return this.snapshot()!
  }

  /**
   * With no argument, signs and sends what the verified records cover. With `owed`, you take the
   * router's number yourself, past what this client could check, up to the deposit.
   */
  async voucher(owed?: Micro): Promise<VoucherReceipt | null> {
    const ch = this.current()
    return this.serial(async () => {
      const verified = ch.verified
      if (owed !== undefined) {
        z.bigint().parse(owed)
        if (owed <= ch.signed) throw new OffpeakError("bad_voucher", "A voucher must raise the cumulative amount")
        if (owed > ch.deposit) throw new OffpeakError("bad_voucher", "A voucher cannot pass the deposit")
        if (owed > ch.verified) ch.verified = owed
        ch.reported.push(owed)
        ch.refused = null
      }
      await this.signLatest(ch)
      const receipt = ch.outbox
      if (!receipt) return null
      try {
        await this.deliver(ch, receipt, true)
      } catch (err) {
        // A refused figure must not stay behind as headroom for the next `owed`.
        if (ch.outbox === null) ch.verified = verified
        throw err
      }
      return receipt
    })
  }

  /**
   * Ends the channel with the router's agreement and your own transaction. If the router refuses, or its
   * answer does not hold up, it sends `requestClose` instead and the result says so. That path keeps the
   * deposit locked for the 2-hour challenge period.
   */
  async close(): Promise<CloseResult> {
    const ch = this.current()
    const { reader, writer } = this.chain()
    if (ch.inFlight > 0) throw new OffpeakError("channel_busy", "Requests are still running on this channel")
    await assertChain(writer)
    await this.serial(async () => {
      await this.signLatest(ch)
      if (ch.outbox) await this.deliver(ch, ch.outbox, false)
    })
    const finalCumulative = ch.signed
    const together = await this.closeTogether(ch, finalCumulative, reader, writer)
    if ("txHash" in together) {
      this.active = null
      return { mode: "cooperative", channelId: ch.id, txHash: together.txHash, finalCumulative }
    }
    const manager = this.ctx.book.contract("ChannelManager")
    const txHash = await this.send(reader, writer, manager, ChannelManagerAbi, "requestClose", [ch.id]).catch(() => {
      throw new OffpeakError("close_failed", `Cooperative close did not go through (${together.refused}), and requestClose failed too`)
    })
    const view = await reader.readContract({ address: manager, abi: ChannelManagerAbi, functionName: "channelView", args: [ch.id] })
    this.active = null
    const challengeEndsAt = Number(view.challengeEndsAt)
    return {
      mode: "challenge",
      channelId: ch.id,
      txHash,
      finalCumulative,
      challengeEndsAt,
      reason: together.refused,
      notice: `Cooperative close did not go through (${together.refused}). requestClose was sent instead, so the deposit stays locked until the challenge period ends at ${new Date(challengeEndsAt * 1000).toISOString()}.`,
    }
  }

  /** Headers for one paid request. Each call makes a new proof, so a retry never replays one. */
  async begin(body: string, cap?: MaxPrice): Promise<{ ticket: Ticket; headers: Record<string, string> }> {
    const ch = await this.ready()
    const headers: Record<string, string> = { "x-offpeak-channel": ch.id, "x-offpeak-channel-auth": await this.proof(ch, body) }
    if (ch.outbox) headers["x-offpeak-voucher"] = encodeVoucher(ch.outbox)
    ch.inFlight += 1
    return { ticket: { channel: ch, voucher: ch.outbox, cap }, headers }
  }

  /** Takes what a response reported. Any voucher waits until the record behind it checks out. */
  async finish(ticket: Ticket, done: Finished) {
    const ch = ticket.channel
    await this.serial(async () => {
      ch.inFlight -= 1
      if (ticket.voucher && ticket.voucher === ch.outbox && (done.delivered || done.voucherRefused)) {
        ticket.voucher.delivered = done.delivered
        ch.outbox = null
        if (done.delivered) ch.accepted = ticket.voucher.cumulative
        else ch.signed = ch.accepted
      }
      // The caller already has its answer. A voucher that fails here shows in `snapshot()`, and the credit limit stops further spend.
      try {
        if (done.envelope) await this.count(ch, done.envelope, ticket.cap)
        if (done.owed !== undefined) ch.reported.push(done.owed)
        if (!this.auto) return
        await this.signLatest(ch)
        if (ch.outbox) await this.deliver(ch, ch.outbox, false)
      } catch (err) {
        ch.refused ??= `Voucher not signed: ${err instanceof Error ? err.message : "wallet error"}`
      }
    })
  }

  private async ready(): Promise<Active> {
    if (this.active) return this.active
    this.starting ??= this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(): Promise<Active> {
    const { config } = this
    if (config?.id) await this.attach(config.id, config.known)
    else if (config?.deposit) await this.open(config.deposit, nowSeconds() + (config.expirySeconds ?? CHANNEL_MIN_LIFETIME_S * 2))
    if (!this.active) throw new OffpeakError("no_channel", "No channel is open")
    return this.active
  }

  private fresh(id: Hex, deposit: Micro, expiry: number, seq: bigint, owed: Micro): Active {
    return { id, deposit, expiry, seq, signed: owed, accepted: owed, verified: owed, reported: [], outbox: null, counted: new Set(), inFlight: 0, refused: null }
  }

  private current(): Active {
    if (!this.active) throw new OffpeakError("no_channel", "No channel is open")
    return this.active
  }

  /** Vouchers depend on verifying records, so nothing is paid for until that is possible. */
  private checkBook() {
    this.ctx.book.contract("ChannelManager")
    this.ctx.book.contract("UsageLedger")
    this.ctx.book.routerSigner()
  }

  private needSigner(): Signer {
    if (!this.ctx.signer) throw new OffpeakError("no_wallet", "Channels need a wallet")
    return this.ctx.signer
  }

  private chain(): { reader: PublicClient; writer: WalletClient } {
    const reader = this.ctx.chain.reader()
    const writer = this.ctx.chain.writer()
    if (!reader || !writer?.account) throw new OffpeakError("no_rpc", "Opening or closing a channel needs a wallet and an RPC URL")
    return { reader, writer }
  }

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async send(reader: PublicClient, writer: WalletClient, address: Address, abi: unknown, functionName: string, args: unknown[]) {
    const account = writer.account!
    const hash = await writer.writeContract({ account, chain: writer.chain ?? null, address, abi, functionName, args } as never)
    const receipt = await reader.waitForTransactionReceipt({ hash, pollingInterval: RECEIPT_POLL_MS })
    if (receipt.status !== "success") throw new OffpeakError("tx_reverted", `${functionName} transaction reverted`)
    return hash
  }

  private async read(id: Hex) {
    const res = await this.ctx.fetch(`${this.ctx.baseURL}/v1/channels/${id}`)
    if (res.status === 404) return null
    if (!res.ok) throw await errorFrom(res)
    return channelView.parse(await res.json())
  }

  /** The router learns of a channel through the indexer, a moment after the transaction lands. */
  private async awaitRouter(id: Hex) {
    const end = performance.now() + SEEN_TIMEOUT_MS
    while (performance.now() < end) {
      if (await this.read(id).catch(() => null)) return
      await new Promise((resolve) => setTimeout(resolve, SEEN_POLL_MS))
    }
    throw new OffpeakError("channel_not_seen", "Channel is open on chain, but the router has not seen it yet", undefined, { channelId: id })
  }
