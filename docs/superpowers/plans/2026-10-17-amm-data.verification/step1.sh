#!/bin/bash
cd /Users/golobitch/github.com/GateHubNet/data-api-new
S=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/amm-t12
echo "$(date -u +%FT%TZ) start build" > $S/logs/step1.log
SECONDS=0
pnpm build > $S/logs/step1-build.log 2>&1; echo "build exit=$? ${SECONDS}s" >> $S/logs/step1.log
SECONDS=0
pnpm test > $S/logs/step1-unit.log 2>&1; echo "unit exit=$? ${SECONDS}s" >> $S/logs/step1.log
SECONDS=0
pnpm -r --no-bail test:e2e > $S/logs/step1-e2e.log 2>&1; echo "e2e exit=$? ${SECONDS}s" >> $S/logs/step1.log
echo "$(date -u +%FT%TZ) done" >> $S/logs/step1.log
