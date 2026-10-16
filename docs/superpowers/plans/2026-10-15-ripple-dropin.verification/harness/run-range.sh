#!/bin/bash
# Xahau range ingest, newest day first, <= 3 in flight. usage: run-range.sh <from> <to> <tag>
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify
R=/Users/golobitch/github.com/GateHubNet/data-api-new
set -a; . $S/env/common.env; set +a
export GH_NETWORK=xahau GH_NODE_ENDPOINTS=wss://xahau.network
export NODE_OPTIONS="--require $S/workaround-unlreport.js"
cd $R
echo "$(date -u +%FT%TZ) range-ingest xahau $1..$2 ($3)" >> $S/logs/range-xahau.log
pnpm --filter @gatehub/data-syncer ingest:range --from $1 --to $2 --concurrency 3 --chunk 500 --run-id verify-$3 >> $S/logs/range-xahau.log 2>&1
echo "$(date -u +%FT%TZ) range-ingest $3 exit=$?" >> $S/logs/range-xahau.log
