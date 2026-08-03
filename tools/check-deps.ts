// Checks every locked package: no malware report, hash matches the registry, not pulled, old enough, no new install script.
const MIN_AGE_DAYS = 7
const ALLOWED_SCRIPTS = new Set(["bufferutil", "esbuild", "fsevents", "keccak", "msgpackr-extract", "secp256k1", "utf-8-validate"])

const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text()) as { packages: Record<string, unknown[]> }
const locked = new Map<string, { name: string; version: string; integrity: string }>()
for (const entry of Object.values(lock.packages)) {
  const id = entry[0] as string
  const at = id.lastIndexOf("@")
  const version = id.slice(at + 1)
  if (version.startsWith("workspace:")) continue
  const integrity = entry.find((part) => typeof part === "string" && /^sha(1|256|512)-/.test(part)) as string | undefined
  locked.set(id, { name: id.slice(0, at), version, integrity: integrity ?? "" })
}
const packages = [...locked.values()]

const problems: string[] = []
for (let i = 0; i < packages.length; i += 500) {
  const batch = packages.slice(i, i + 500)
  const res = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: batch.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })) }),
  })
  if (!res.ok) throw new Error(`osv: ${res.status}`)
  const data = (await res.json()) as { results: { vulns?: { id: string }[] }[] }
  data.results.forEach((row, j) => {
    for (const vuln of row.vulns ?? []) {
      if (vuln.id.startsWith("MAL-")) problems.push(`malware report ${vuln.id}: ${batch[j]!.name}@${batch[j]!.version}`)
    }
  })
}

const names = [...new Set(packages.map((p) => p.name))]
const metadata = new Map<string, { time: Record<string, string>; versions: Record<string, { dist: { integrity: string }; scripts?: Record<string, string> }> }>()
let next = 0
await Promise.all(
  Array.from({ length: 16 }, async () => {
    while (next < names.length) {
      const name = names[next++]!
      const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`)
      if (!res.ok) throw new Error(`registry ${name}: ${res.status}`)
      metadata.set(name, (await res.json()) as never)
    }
  }),
)

const now = Date.now()
for (const p of packages) {
  const id = `${p.name}@${p.version}`
  const meta = metadata.get(p.name)!
  const published = meta.versions[p.version]
  if (!published) {
    problems.push(`no longer on the registry: ${id}`)
    continue
  }
  if (!p.integrity) problems.push(`no hash in bun.lock: ${id}`)
  else if (published.dist.integrity !== p.integrity) problems.push(`hash differs from the registry: ${id}`)
  const days = (now - Date.parse(meta.time[p.version]!)) / 86_400_000
  if (days < MIN_AGE_DAYS) problems.push(`only ${days.toFixed(1)} days old: ${id}`)
  const scripts = published.scripts ?? {}
  if ((scripts.preinstall || scripts.install || scripts.postinstall) && !ALLOWED_SCRIPTS.has(p.name)) problems.push(`new install script: ${id}`)
}

console.log(`checked ${packages.length} locked packages, ${problems.length} problems`)
for (const problem of problems) console.log(`  ${problem}`)
if (problems.length) process.exit(1)
