#!/bin/bash
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/amm-t12
R=/Users/golobitch/github.com/GateHubNet/data-api-new
set -a; . $S/env/common.env; set +a
export GH_NETWORK=xrpl GH_WORKERS=ingest,aggregator GH_HTTP_API_PORT=23002 GH_METRICZ_PORT=23000 GH_RUN_MIGRATIONS_ON_BOOT=false
export GH_NODE_ENDPOINTS=ws://127.0.0.1:24001 GH_CATCHUP_CONCURRENCY=1
export NODE_OPTIONS="--require $S/time-jobs.js"
cd $R/apps/syncer
echo "$(date -u +%FT%TZ) starting syncer workers=ingest,aggregator (live)" >> $S/logs/syncer-live.log
nohup node dist/main.js >> $S/logs/syncer-live.log 2>&1 &
echo $! > $S/pids/syncer-live.pid
echo "pid $(cat $S/pids/syncer-live.pid)"
