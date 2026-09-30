import type { Hex } from "viem"
import { z } from "zod"
import { fakeEvidenceFor } from "../../../host-agent/test/support/fake-gpu-tool.ts"
import { fakeQuoteValid } from "../../../host-agent/test/support/fake-tsm.ts"

/** Fake services for machines with no TDX or GPU. Neither one checks anything a real verifier checks beyond the fake HMACs. */

const PORTS = 1_000

function serveInRange(handler: (req: Request) => Promise<Response> | Response) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = Number(process.env.OFFPEAK_TEST_PORT_BASE ?? 37_000) + Math.floor(Math.random() * PORTS)
    try {
      return { server: Bun.serve({ port, hostname: "127.0.0.1", fetch: handler }), port }
    } catch (err) {
      if ((err as { code?: string }).code !== "EADDRINUSE") throw err
    }
  }
  throw new Error("no free port in range")
}

/** A DCAP service: its one job here is the fake signature, plus whatever TCB status a test asks for. */
export function startFakeDcap(state: { tcbStatus: string; down?: boolean } = { tcbStatus: "UpToDate" }) {
  const seen: Hex[] = []
  const { server, port } = serveInRange(async (req) => {
    if (state.down) return new Response("down", { status: 503 })
    const { quote } = z.object({ quote: z.string() }).parse(await req.json())
    seen.push(quote as Hex)
    return Response.json({ verified: fakeQuoteValid(quote as Hex), tcbStatus: state.tcbStatus })
  })
  return { url: `http://127.0.0.1:${port}/verify`, state, seen, stop: () => server.stop(true) }
}

const unsigned = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fake`

const gpuBody = z.looseObject({ nonce: z.string(), evidence_list: z.array(z.object({ evidence: z.string() })).min(1) })

/** NVIDIA's service as this code reads it: a JWT row, with the overall result in its claims. */
export function startFakeGpuService(state: { result: boolean; down?: boolean; nonceOverride?: string } = { result: true }) {
  const { server, port } = serveInRange(async (req) => {
    if (state.down) return new Response("down", { status: 503 })
    const body = gpuBody.parse(await req.json())
    const genuine = body.evidence_list[0]!.evidence === fakeEvidenceFor(body.nonce)
    return Response.json([["JWT", unsigned({ "x-nvidia-overall-att-result": state.result && genuine, eat_nonce: state.nonceOverride ?? body.nonce })], {}])
  })
  return { url: `http://127.0.0.1:${port}/attest/gpu`, state, stop: () => server.stop(true) }
}
