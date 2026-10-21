#!/bin/bash
# run SQL against my own scratch ClickHouse container
docker exec amm-verify-t12-clickhouse-1 clickhouse-client --multiquery -q "$1"
