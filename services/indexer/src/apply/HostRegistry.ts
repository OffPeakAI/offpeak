import type { Db } from "@offpeak/common"
import type { ChainEvent } from "./index.ts"

const addr = (v: unknown) => String(v).toLowerCase()

async function touchHost(tx: Db, host: string) {
  await tx.query("INSERT INTO chain.hosts (address) VALUES ($1) ON CONFLICT DO NOTHING", [host])
}

async function setServing(tx: Db, e: ChainEvent) {
  const { imageDigest, gpuClass, modelDigests, maxTps, probationEnds, attestationRef } = e.args
  const host = addr(e.args.host)
  await touchHost(tx, host)
  await tx.query(
    `UPDATE chain.hosts SET image_digest = $1, gpu_class = $2, attestation_ref = $3, probation_ends = $4 WHERE address = $5`,
    [imageDigest, gpuClass, attestationRef, probationEnds, host],
  )
  await tx.query("DELETE FROM chain.host_models WHERE host = $1", [host])
  const digests = modelDigests as string[]
  const capacities = maxTps as number[]
  for (let i = 0; i < digests.length; i++) {
    await tx.query("INSERT INTO chain.host_models (host, digest, max_tps) VALUES ($1,$2,$3)", [host, digests[i], capacities[i]])
  }
}

/** The credits a withdrawal paid are the oldest open ones already released at that block. */
async function markWithdrawn(tx: Db, host: string, amount: bigint, blockTs: number) {
  const open = await tx.query<{ id: string; amount: string }>(
    `SELECT id, amount FROM chain.host_credits WHERE host = $1 AND state = 'open' AND releasable_at <= $2 ORDER BY id`,
    [host, blockTs],
  )
  let left = amount
  for (const row of open.rows) {
    if (left <= 0n) break
    await tx.query("UPDATE chain.host_credits SET state = 'withdrawn' WHERE id = $1", [row.id])
    left -= BigInt(row.amount)
  }
}

export async function applyHostRegistry(tx: Db, e: ChainEvent) {
  const args = e.args
  switch (e.event) {
    case "HostRegistered":
    case "ServingUpdated":
      await setServing(tx, e)
      return
    case "EndpointUpdated": {
      const host = addr(args.host)
      await touchHost(tx, host)
      await tx.query("UPDATE chain.hosts SET endpoint_hash = $1 WHERE address = $2", [args.endpointHash, host])
      return
    }
    case "BondChanged": {
      const host = addr(args.host)
      await touchHost(tx, host)
      await tx.query("UPDATE chain.hosts SET bond_usdg = $1, bond_ofpk = $2 WHERE address = $3", [args.bondUsdg, args.bondOfpk, host])
      return
    }
    case "HostStatusChanged": {
      const host = addr(args.host)
      await touchHost(tx, host)
      await tx.query("UPDATE chain.hosts SET status = $1 WHERE address = $2", [args.status, host])
      await tx.query(
        `INSERT INTO chain.host_status_log (host, ts, seq, status) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [host, e.blockTs, e.blockNumber * 100_000n + BigInt(e.logIndex), args.status],
      )
      return
    }
    case "HostStruck":
      await tx.query("UPDATE chain.hosts SET strikes = $1 WHERE address = $2", [args.strikes, addr(args.host)])
      return
    case "ChallengesChanged":
      await tx.query("UPDATE chain.hosts SET open_challenges = $1 WHERE address = $2", [args.openChallenges, addr(args.host)])
      return
    case "CreditsAccrued":
    case "RewardsAccrued": {
      const reward = e.event === "RewardsAccrued"
      await tx.query(
        `INSERT INTO chain.host_credits (host, kind, hour, amount, accrued_at, releasable_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [addr(args.host), reward ? "reward" : "credit", reward ? 0 : args.hour, args.amount, e.blockTs, args.releasableAt],
      )
      return
    }
    case "CreditsClawedBack":
      await tx.query(
        `UPDATE chain.host_credits SET state = 'clawed'
         WHERE host = $1 AND hour = $2 AND state = 'open' AND releasable_at > $3`,
        [addr(args.host), args.hour, e.blockTs],
      )
      return
    case "CreditsWithdrawn":
      await markWithdrawn(tx, addr(args.host), BigInt(args.amount as string), e.blockTs)
      return
  }
}
