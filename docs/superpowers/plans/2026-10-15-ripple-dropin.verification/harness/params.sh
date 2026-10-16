#!/bin/bash
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify
KEY=$(sed 's/GH_API_KEYS=//' $S/env/api.key.env)
chk() { printf '%-92s ' "$1"; curl -s -m 20 -D $S/h.tmp -H "X-API-Key: $KEY" "localhost:$PORT$1" -o $S/b.tmp; printf '[%s] ' "$(head -1 $S/h.tmp | cut -d' ' -f2)"; head -c 150 $S/b.tmp | tr -d '\n'; echo; }
PORT=${1:-13001}
echo "# parameter-rule spot checks on port $PORT"
chk "/v2/payments?limit=1&marker=garbage"
chk "/v2/payments?limit=2&limit=5"
chk "/v2/payments?limit=99999"
chk "/v2/payments?limit=0"
chk "/v2/payments?limit=2.9"
chk "/v2/payments?limit=abc"
chk "/v2/payments?limit=1&format=CSV"
chk "/v2/payments?limit=1&descending=1"
chk "/v2/payments?limit=1&start=2026-10-16T16:00:00&end=2026-10-16T16:00:10"
chk "/v2/payments?limit=1&unknown=xyz"
chk "/v2/exchange_rates/XRP/XRP"
chk "/v2/exchange_rates/USD+rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq/XRP?date=2999-01-01"
chk "/v2/stats?family=type&limit=1"
chk "/v2/stats?metrics=ledger_count"
chk "/v2/ledgers/0x646A164D65ED1A84CF6263773CF4AC12C51F615CB4DF525553D00F78D4BF5A7F"
chk "/v2/ledgers?ledger_hash=zz"
chk "/v2/accounts/rrrrrrrrrrrrrrrrrrrrBZbvji/transactions?limit=1"
chk "/v2/network/fee_stats?interval=raw&limit=1"
chk "/v2/transactions/%zz"
chk "/v2/health"
chk "/"
rm -f $S/h.tmp $S/b.tmp
