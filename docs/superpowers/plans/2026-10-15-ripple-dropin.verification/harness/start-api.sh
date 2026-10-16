#!/bin/bash
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify
R=/Users/golobitch/github.com/GateHubNet/data-api-new
net=$1; shift
set -a; . $S/env/common.env; . $S/env/api.key.env; set +a
if [ "$net" = xrpl ]; then export GH_NODE_ENDPOINTS=wss://xrplcluster.com GH_HTTP_API_PORT=13001 GH_METRICZ_PORT=13003; else export GH_NODE_ENDPOINTS=wss://xahau.network GH_HTTP_API_PORT=13011 GH_METRICZ_PORT=13013; fi
export GH_NETWORK=$net NODE_ENV=development
for kv in "$@"; do export "$kv"; done
cd $R/apps/api
echo "$(date -u +%FT%TZ) starting api $net" >> $S/logs/api-$net.log
nohup node dist/main.js >> $S/logs/api-$net.log 2>&1 &
echo $! > $S/pids/api-$net.pid
echo "pid $(cat $S/pids/api-$net.pid)"
