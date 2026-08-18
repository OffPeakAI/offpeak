export function serveMetrics(metrics: Metrics, port: number) {
  Bun.serve({ port, fetch: () => new Response(metrics.render(), { headers: { "content-type": "text/plain" } }) })
}

/** Prometheus text metrics, served at /metrics by each service. */
export class Metrics {
  private values = new Map<string, number>()

  set(name: string, value: number) {
    this.values.set(name, value)
  }

  inc(name: string, by = 1) {
    this.values.set(name, (this.values.get(name) ?? 0) + by)
  }

  get(name: string) {
    return this.values.get(name) ?? 0
  }

  render() {
    return [...this.values].map(([name, value]) => `${name} ${value}`).join("\n") + "\n"
  }
}
