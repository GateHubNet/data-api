#!/bin/bash
# Stratified sample of the last ~65k Xahau ledgers: 65 bursts of one 100-ledger chunk, 1000 ledgers apart, visited in a spread order.
# Each burst is one `ingest:range` invocation (<= 3 in flight). On a rate-limit failure: wait 15 s, retry once, then skip.
# usage: sample-range.sh <deadline-epoch>
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify
R=/Users/golobitch/github.com/GateHubNet/data-api-new
deadline=$1
set -a; . $S/env/common.env; set +a
export GH_NETWORK=xahau GH_NODE_ENDPOINTS=wss://xahau.network
export NODE_OPTIONS="--require $S/workaround-unlreport.js"
cd $R
L=$S/logs/range-sample.log
ok=0; skipped=0
for i in $(seq 0 64); do
  k=$(( (i*29) % 65 )); a=$(( 26505800 + k*1000 )); b=$(( a + 99 ))
  if [ -f $S/range.stop ] || [ $(date +%s) -ge $deadline ]; then echo "$(date -u +%FT%TZ) STOP at i=$i (deadline/stop file)" >> $L; break; fi
  for attempt in 1 2; do
    pnpm --filter @gatehub/data-syncer ingest:range --from $a --to $b --concurrency 3 --chunk 100 --run-id verify-sample >> $S/logs/range-sample.raw.log 2>&1
    rc=$?
    echo "$(date -u +%FT%TZ) burst i=$i k=$k $a..$b attempt=$attempt rc=$rc" >> $L
    [ $rc -eq 0 ] && { ok=$((ok+1)); break; }
    sleep 15
  done
  [ $rc -ne 0 ] && skipped=$((skipped+1))
  sleep 3
done
echo "$(date -u +%FT%TZ) SAMPLE DONE ok=$ok skipped=$skipped" >> $L
