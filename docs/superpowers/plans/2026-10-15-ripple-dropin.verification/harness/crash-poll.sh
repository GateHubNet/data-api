#!/bin/bash
# poll ClickHouse over HTTP; kill -9 the XRPL syncer at the first sign of an in-flight INSERT after >= 1 committed batch,
# else when 150..450 ledgers are committed
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify
P=$(cat $S/pids/syncer-xrpl.pid)
q() { curl -s "http://127.0.0.1:18123/" --data-binary "$1"; }
for i in $(seq 1 6000); do
  n=$(q "select count() from xrpl.ledgers"); n=${n:-0}
  inflight=$(q "select count() from system.processes where current_database='xrpl' and query ilike 'insert into%'")
  if [ "$n" -ge 1 ] && [ "${inflight:-0}" -ge 1 ] && [ "$n" -lt 480 ]; then reason="in-flight INSERT seen, $n ledgers committed"; break; fi
  if [ "$n" -ge 150 ] && [ "$n" -le 450 ]; then reason="$n ledgers committed (no in-flight insert caught)"; break; fi
  sleep 0.02
done
kill -9 $P; echo "KILL -9 pid $P at $(date -u +%FT%TZ): $reason"
