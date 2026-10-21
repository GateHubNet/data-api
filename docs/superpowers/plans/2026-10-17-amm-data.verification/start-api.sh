#!/bin/bash
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/amm-t12
R=/Users/golobitch/github.com/GateHubNet/data-api-new
set -a; . $S/env/common.env; . $S/env/api.key.env; set +a
export GH_NETWORK=xrpl GH_NODE_ENDPOINTS=${NODE_EP:-ws://127.0.0.1:24001} GH_HTTP_API_PORT=23001 GH_METRICZ_PORT=23003 NODE_ENV=development
cd $R/apps/api
echo "$(date -u +%FT%TZ) starting api" >> $S/logs/api.log
nohup node dist/main.js >> $S/logs/api.log 2>&1 &
echo $! > $S/pids/api.pid
echo "pid $(cat $S/pids/api.pid)"
