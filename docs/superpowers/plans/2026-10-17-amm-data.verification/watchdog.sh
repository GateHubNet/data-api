#!/bin/bash
# kills the syncer when the proxy reports a rate-limit answer
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/amm-t12
while sleep 1; do
  if [ -f $S/STOPPED ]; then
    kill $(cat $S/pids/syncer-live.pid) 2>/dev/null
    echo "$(date -u +%FT%TZ) watchdog: STOPPED file, syncer killed" >> $S/logs/watchdog.log
    break
  fi
  [ -f $S/pids/watchdog.stop ] && break
done
