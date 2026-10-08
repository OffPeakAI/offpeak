# Running a host

The host agent and vLLM share one network namespace. vLLM listens on loopback, so the agent is the only way in. The agent speaks plain HTTP, and it has no TLS of its own.

## What you must put in front

Your public `endpoint` in `host.yaml` must be `https://`, and boot refuses anything else outside local. Run a TLS proxy on the same machine that serves that name and forwards to the agent.

The proxy must:

- Terminate TLS with a certificate for your `endpoint`, and forward to `127.0.0.1:8790`, or the port you set.
- Leave the `X-Offpeak-Req` and `X-Offpeak-Audit` headers unchanged, because every request is signed.
- Allow request bodies up to 12 MB.
- Not buffer responses, because streams arrive token by token.
- Keep a request open for at least 600 seconds with no bytes moving, because the GPU may queue it.

Keep the agent's port closed to everything but the proxy. `deploy/host/compose.yaml` publishes it on `127.0.0.1` only, and `listen.host` in `host.yaml` must be loopback outside local. Inside the container the agent binds its own interface through `OFFPEAK_AGENT_BIND`, which reaches nothing but that loopback port.

The agent turns away anything without a valid signature before it reads the body, and a socket with no signed request on it closes after 30 seconds. A proxy with its own request and connection limits still helps, because it stops abuse before it reaches this machine.

## Night jobs

Night jobs bill a locked price that can sit outside the hour's band. A host agrees to that per model with `nightJobs: true` in `host.yaml`. Without it the agent refuses such a record with `night_jobs_off`, and the request is served unbilled.

`GET /offpeak/v1/info` lists those models in `nightJobModels`. The router must send night jobs only to a host that lists the model, and must not count `night_jobs_off` against the host.

## Your signed log

`dataDir/signed` holds every record you signed, for 30 days. It is your own evidence in a dispute, so back it up. Each entry reaches the disk before the signature leaves the agent. After a crash the last line may be cut short. It stays in the file on a line of its own, and readers should skip a line that does not parse.
