# ADR-0006: TLS terminated by the GateHub reverse proxy; app trusts X-Forwarded-For

**Status:** Accepted. Amended: the stack's nginx recovers the client address itself (see the end).

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
- The local `docker-compose.prod.yaml` includes an nginx for host routing and edge rules (no TLS).

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

## Amendment: the stack's nginx sits between the front proxy and the API
`docker-compose.prod.yaml` puts an nginx behind the front proxy (host routing `xrpl.data.*` / `xahau.data.*`, `/internal/` and `/liveliness/` blocked for the
public). With two hops (front proxy, nginx) `GH_TRUST_PROXY_HOPS=1` would make `req.ip` the front proxy and put every client in one rate-limit bucket. So:

- nginx recovers the real client with the `realip` module from the `X-Forwarded-For` of a **`TRUSTED_PROXIES` peer only** (comma separated addresses/CIDRs, default the
  private ranges, zero prefix lengths refused), then **sets** (never appends) `X-Forwarded-For` to that one address, so the API keeps `GH_TRUST_PROXY_HOPS=1` and a client
  cannot choose its own address. `X-Forwarded-Proto` passes through from a trusted peer only.
- The operator must set `TRUSTED_PROXIES` to the front proxy and bind nginx (`NGINX_BIND`) to an interface only that proxy can reach; with the placeholder defaults a client
  that reaches nginx from a private address can pick its address. See [deployment](../deployment.md#the-edge-nginx) and [security](../security.md#4-transport-and-the-client-address).
