#!/bin/bash
# extra crash tests in LIVE mode: kill -9 the XRPL syncer (when an INSERT is in flight if one is caught within 25 s), wait for the lease to age out,
# restart, and check the invariants. 3 rounds. Logs to logs/crash-loop.log
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify
q() { curl -s "http://127.0.0.1:18123/" --data-binary "$1"; }
L=$S/logs/crash-loop.log
for round in 1 2 3; do
  P=$(cat $S/pids/syncer-xrpl.pid)
  reason="no in-flight INSERT caught in 25 s; killed anyway"
  for i in $(seq 1 1250); do
    inflight=$(q "select count() from system.processes where current_database='xrpl' and query ilike 'insert into%'")
    if [ "${inflight:-0}" -ge 1 ]; then reason="INSERT in flight"; break; fi
    sleep 0.02
  done
  kill -9 $P; echo "$(date -u +%FT%TZ) round $round: kill -9 $P ($reason)" >> $L
  echo "  before restart: ledgers=$(q "select count() from xrpl.ledgers") max=$(q "select max(ledger_index) from xrpl.ledgers") tx_max=$(q "select max(ledger_index) from xrpl.transactions") (tx_max > max means orphan child rows of an uncommitted ledger)" >> $L
  sleep 33
  $S/start-syncer.sh xrpl "" GH_CATCHUP_CONCURRENCY=2 GH_NODE_ENDPOINTS=wss://s2.ripple.com >> $L
  sleep 40
  echo "  after restart:  span=count: $(q "select max(ledger_index)-min(ledger_index)+1 = count() from xrpl.ledgers"); count=uniqExact(tx): $(q "select count() = uniqExact(ledger_index, tx_index) from xrpl.transactions"); no tx above checkpoint: $(q "select count() = 0 from xrpl.transactions where ledger_index > (select max(ledger_index) from xrpl.ledgers)"); ledger_by_hash==ledgers: $(q "select (select count() from xrpl.ledger_by_hash) = (select count() from xrpl.ledgers)"); sum(tx_count)==tx rows: $(q "select (select sum(tx_count) from xrpl.ledgers) = (select count() from xrpl.transactions)"); lag: $(curl -s localhost:13002/liveliness/healthz | grep -o '"lag":[0-9]*' | head -1)" >> $L
done
echo "$(date -u +%FT%TZ) crash-loop done" >> $L
