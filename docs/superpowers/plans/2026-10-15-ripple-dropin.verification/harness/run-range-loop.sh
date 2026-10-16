#!/bin/bash
# resumable Xahau range ingest, newest day first; on a failed run (rate limit) wait 25 s and re-run the same command, as the docs say.
# stops at the deadline (epoch seconds, $1) or when all three ranges are done.
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify
R=/Users/golobitch/github.com/GateHubNet/data-api-new
deadline=$1
set -a; . $S/env/common.env; set +a
export GH_NETWORK=xahau GH_NODE_ENDPOINTS=wss://xahau.network
export NODE_OPTIONS="--require $S/workaround-unlreport.js"
cd $R
for r in "26549127 26570726 day1" "26527527 26549126 day2" "26505927 26527526 day3"; do
  set -- $r
  while true; do
    if [ -f $S/range.stop ] || [ $(date +%s) -ge $deadline ]; then echo "$(date -u +%FT%TZ) STOP (deadline or stop file) before $3" >> $S/logs/range-xahau.log; exit 0; fi
    echo "$(date -u +%FT%TZ) run $3 $1..$2" >> $S/logs/range-xahau.log
    pnpm --filter @gatehub/data-syncer ingest:range --from $1 --to $2 --concurrency 3 --chunk 100 --run-id verify-$3 >> $S/logs/range-xahau.log 2>&1
    rc=$?
    echo "$(date -u +%FT%TZ) $3 exit=$rc" >> $S/logs/range-xahau.log
    [ $rc -eq 0 ] && break
    sleep 12
  done
done
echo "$(date -u +%FT%TZ) ALL RANGES DONE" >> $S/logs/range-xahau.log
