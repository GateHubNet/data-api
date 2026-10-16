#!/bin/bash
# usage: start-syncer.sh <xrpl|xahau> [start_ledger] [extra env assignments...]; runs the BUILT dist with env set explicitly
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify
R=/Users/golobitch/github.com/GateHubNet/data-api-new
net=$1; start=$2; shift 2
set -a; . $S/env/common.env; set +a
if [ "$net" = xrpl ]; then export GH_NODE_ENDPOINTS=wss://xrplcluster.com GH_HTTP_API_PORT=13002 GH_METRICZ_PORT=13000; else export GH_NODE_ENDPOINTS=wss://xahau.network GH_HTTP_API_PORT=13012 GH_METRICZ_PORT=13010; fi
export GH_NETWORK=$net GH_RUN_MIGRATIONS_ON_BOOT=false
[ -n "$start" ] && export GH_SYNC_START_LEDGER=$start
for kv in "$@"; do export "$kv"; done
cd $R/apps/syncer
echo "$(date -u +%FT%TZ) starting syncer $net start=${GH_SYNC_START_LEDGER:-<head>}" >> $S/logs/syncer-$net.log
nohup node dist/main.js >> $S/logs/syncer-$net.log 2>&1 &
echo $! > $S/pids/syncer-$net.pid
echo "pid $(cat $S/pids/syncer-$net.pid)"
