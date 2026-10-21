#!/bin/bash
# usage: run-range.sh <from> <to> <tag> [extra range-ingest flags]
# XRPL range ingest through the throttling proxy (ws://127.0.0.1:24001 -> wss://s2.ripple.com): one request in flight, a gap
# between requests, and the whole run is killed by the watchdog at the first rate-limit answer (the proxy writes $S/STOPPED).
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/amm-t12
R=/Users/golobitch/github.com/GateHubNet/data-api-new
from=$1; to=$2; tag=$3; shift 3
set -a; . $S/env/common.env; set +a
export GH_NETWORK=xrpl GH_NODE_ENDPOINTS=ws://127.0.0.1:24001
cd $R
echo "$(date -u +%FT%TZ) range-ingest xrpl $from..$to ($tag)" >> $S/logs/range.log
SECONDS=0
( while sleep 1; do if [ -f $S/STOPPED ]; then pkill -f "amm-t12-$tag"; echo "$(date -u +%FT%TZ) watchdog: STOPPED file, run killed" >> $S/logs/range.log; break; fi; done ) &
WD=$!
pnpm --filter @gatehub/data-syncer ingest:range --from $from --to $to --concurrency 1 --chunk 20 --max-wait 60 --run-id amm-t12-$tag "$@" >> $S/logs/range.log 2>&1
rc=$?
kill $WD 2>/dev/null
echo "$(date -u +%FT%TZ) range-ingest $tag exit=$rc ${SECONDS}s" >> $S/logs/range.log
