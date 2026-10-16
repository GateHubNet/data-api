#!/bin/bash
# run SQL against my own ClickHouse container
docker exec dropin-verify-clickhouse clickhouse-client --multiquery -q "$1"
