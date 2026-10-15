# ADR-0006: TLS terminated by the GateHub reverse proxy; app trusts X-Forwarded-For

**Status:** Accepted

## Context
The services run inside GateHub's infrastructure behind a shared reverse proxy that already
handles TLS termination, certificates, and edge routing. Re-implementing TLS in each service
would duplicate that responsibility. However, when an app sits behind a proxy, the connecting
IP it sees is the **proxy's** IP for every request — which silently breaks per-client rate
limiting (everyone shares one bucket) and client-IP logging.

## Decision
- The API **speaks plain HTTP**; **TLS is terminated by the GateHub reverse proxy**.
- The app enables Express `trust proxy` (`GH_TRUST_PROXY_HOPS`, default 1) so `req.ip`
  resolves to the real client from `X-Forwarded-For`. The rate limiter and logging then key
  on the real client.
- ClickHouse, Keeper, and the syncer are **internal-only** — never publicly exposed.
- The local `docker-compose.prod.yaml` includes an nginx **stand-in** for the proxy (forwards
  `X-Forwarded-For`, no TLS) purely so the multi-replica topology is testable locally; in a
  real deployment it's replaced by the GateHub proxy.

## Consequences
**Positive**
- One place owns TLS/certs (the proxy); services stay simple.
- Correct per-client rate limiting and logging via `X-Forwarded-For`.

**Negative / trade-offs**
- The app must be reachable **only** through the proxy. If a client could reach it directly it
  could spoof `X-Forwarded-For`; network policy must enforce proxy-only ingress. Set
  `GH_TRUST_PROXY_HOPS` to the exact number of trusted hops — too high allows spoofing.
- The in-app rate limit is still per-replica/in-memory; a true global limit needs a shared
  store, and the edge proxy may also rate-limit (defense in depth). See
  [security.md](../security.md).
