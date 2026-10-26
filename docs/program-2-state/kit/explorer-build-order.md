---
name: explorer-build-order
description: Order the user set (2026-10-24) for building the next explorer features in data-api and explorer; which mocked features are deferred
metadata:
  node_type: memory
  type: project
  originSessionId: dd934f63-30db-4773-b2fa-3a2e02d079f9
  modified: 2026-10-24T20:19:29.523Z
---

Build order for the GateHub explorer (data API + explorer), set by the user on 2026-10-24 after the mocks in the
Explorer Design Mock (claude.ai/artifact/LgETuDtW2YoDqSc2GazWDj):

1. NFTs (incl. Xahau URITokens)
2. Account names (toml two-way verification + curated list)
3. Escrow, check and payment channel pages
4. Delegation on transactions and accounts
5. Token list and issued token page
6. Supply
7. Validators map (toml server_country, no crawler)
8. MPT page

Deferred, not to be built unless asked: nodes crawler / nodes and node pages / nodes map, distribution (rich list,
brackets, percentiles), history charts needing daily stats jobs.

**Why:** the user agreed the mocks hold too many features to build at once; cheap, user-facing features first.
**How to apply:** follow this order; implement "based on the designs" in the mock; don't pull deferred features in.
Glossary: x-explorer branch docs/glossary ([[explorer-glossary]]).
