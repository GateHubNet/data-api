// Semantic cross-checks of API answers against ClickHouse truth and the node. usage: node semantic.js <xrpl|xahau>
const fs = require('fs');
const S = '/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify';
const R = '/Users/golobitch/github.com/GateHubNet/data-api-new';
const net = process.argv[2];
const CFG = { xrpl: { port: 13001, node: 'wss://xrplcluster.com', nat: 'XRP' }, xahau: { port: 13011, node: 'wss://xahau.network', nat: 'XAH' } }[net];
const xrpl = require(require.resolve('xrpl', { paths: [R + '/apps/api', R] }));
const BN = require(require.resolve('bignumber.js', { paths: [R + '/packages/shared', R] }));
const KEY = fs.readFileSync(`${S}/env/api.key.env`, 'utf8').match(/GH_API_KEYS=(.*)/)[1].trim();
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${CFG.port}${p}`, { headers: { 'X-API-Key': KEY } }); return { status: r.status, json: await r.json(), headers: r.headers }; };
const ch = async (sql) => { const r = await fetch(`http://127.0.0.1:18123/?database=${net}&default_format=JSONEachRow`, { method: 'POST', body: sql }); const t = await r.text(); if (!r.ok) throw new Error(t); return t.trim() ? t.trim().split('\n').map(JSON.parse) : []; };
const out = []; const log = (s) => { out.push(s); console.log(s); };
async function walk(path, key, limit) { // follow `marker` to the end
  let rows = []; let marker; let pages = 0;
  do { const r = await get(`${path}${path.includes('?') ? '&' : '?'}limit=${limit}${marker ? '&marker=' + encodeURIComponent(marker) : ''}`); if (r.status !== 200) throw new Error(path + ' -> ' + r.status + JSON.stringify(r.json)); rows = rows.concat(r.json[key]); marker = r.json.marker; pages++; } while (marker && pages < 400);
  return { rows, pages };
}
(async () => {
  const lim = (await ch('select max(ledger_index) mx, min(ledger_index) mn from ledgers'))[0];
  // keep to ledgers that are committed now (the live tail moves): pin the window by `end` is not possible by index, so compare on a closed window via start/end dates
  const t = (await ch(`select toString(min(close_time)) a, toString(addMinutes(min(close_time), ${Number(process.env.WIN_MIN || 20)})) b from ledgers`))[0];
  const start = t.a.replace(' ', 'T') + 'Z', end = t.b.replace(' ', 'T') + 'Z';
  const win = `start=${start}&end=${end}`;
  const sqlWin = `close_time >= toDateTime('${t.a}') and close_time <= toDateTime('${t.b}')`; // end is inclusive at its precision (second)
  log(`window ${start} .. ${end}`);
  // (a) payments: page walk == SQL count, no duplicates
  { const w = await walk(`/v2/payments?${win}`, 'payments', 1000); const n = (await ch(`select count() n from payments where ${sqlWin}`))[0].n;
    const keys = new Set(w.rows.map((p) => p.tx_hash)); log(`(a) /v2/payments walk: ${w.rows.length} rows in ${w.pages} pages; SQL count ${n}; distinct tx_hash ${keys.size}; ${Number(n) === w.rows.length && keys.size === w.rows.length ? 'EQUAL' : 'DIFFERENT'}`); }
  // (b) exchanges (all pairs) walk == SQL
  { const w = await walk(`/v2/exchanges?${win}`, 'exchanges', 400); const n = (await ch(`select count() n from exchanges where ${sqlWin}`))[0].n;
    const ids = new Set(w.rows.map((e) => `${e.ledger_index}:${e.tx_index}:${e.node_index}`)); log(`(b) /v2/exchanges walk: ${w.rows.length} rows in ${w.pages} pages; SQL ${n}; distinct (ledger,tx,node) ${ids.size}; ${Number(n) === w.rows.length && ids.size === w.rows.length ? 'EQUAL' : 'DIFFERENT'}`); }
  // (c) accounts/transactions walk == SQL
  { const a = (await ch(`select account a, count() c from account_transactions where ${sqlWin} group by account order by c desc limit 1`))[0];
    const w = await walk(`/v2/accounts/${a.a}/transactions?${win}`, 'transactions', 1000); const hashes = new Set(w.rows.map((x) => x.hash));
    log(`(c) /v2/accounts/${a.a}/transactions walk: ${w.rows.length} rows in ${w.pages} pages; SQL ${a.c}; distinct hashes ${hashes.size}; ${Number(a.c) === w.rows.length && hashes.size === w.rows.length ? 'EQUAL' : 'DIFFERENT'}`); }
  // (d) fees of one ledger vs the node's ledger
  { const L = (await ch(`select ledger_index li, toString(close_time) ct from ledgers where tx_count > 20 order by ledger_index limit 1 offset 10`))[0]; const li = L.li; const cts = L.ct.replace(' ', 'T') + 'Z';
    const f = (await get(`/v2/network/fees?start=${cts}&end=${cts}&limit=1000`)).json.rows.find((r) => r.ledger_index === Number(li));
    const c = new xrpl.Client(CFG.node, { timeout: 60000 }); await c.connect();
    const led = (await c.request({ command: 'ledger', ledger_index: Number(li), transactions: true, expand: true })).result.ledger; await c.disconnect();
    const fees = led.transactions.map((t) => new BN(t.Fee || 0).div(1e6)); const total = fees.reduce((a, b) => a.plus(b), new BN(0)); const max = BN.max(...fees), min = BN.min(...fees);
    log(`(d) /v2/network/fees ledger ${li}: api total ${f.total} max ${f.max} min ${f.min} tx_count ${f.tx_count} | node total ${total.toFixed()} max ${max.toFixed()} min ${min.toFixed()} tx_count ${led.transactions.length} => ${new BN(f.total).eq(total) && new BN(f.max).eq(max) && new BN(f.min).eq(min) && f.tx_count === led.transactions.length ? 'EQUAL' : 'DIFFERENT'}`); }
  // (e) stats of an hour vs ledgers table
  { const h = (await ch(`select toString(toStartOfHour(close_time)) h, sum(tx_count) tx, count() lc, sum(payments_count) p, sum(exchanges_count) e, sum(accounts_created) ac from ledgers group by h order by h limit 1`))[0];
    const iso = h.h.replace(' ', 'T') + 'Z';
    const s = (await get(`/v2/stats?interval=hour&start=${iso}&end=${iso}`)).json.stats[0];
    log(`(e) /v2/stats hour ${iso}: api transaction_count ${s.metric.transaction_count} ledger_count ${s.metric.ledger_count} payments ${s.metric.payments_count} exchanges ${s.metric.exchanges_count || 0} accounts_created ${s.metric.accounts_created || 0} | ledgers table: tx ${h.tx} ledgers ${h.lc} payments ${h.p} exchanges ${h.e} accounts ${h.ac} => ${Number(h.tx) === s.metric.transaction_count && Number(h.lc) === s.metric.ledger_count && Number(h.p) === s.metric.payments_count ? 'EQUAL' : 'DIFFERENT'}`); }
  // (f) reduce vs SQL on the busiest pair
  { const p = (await ch(`select base_currency bc, base_issuer bi, counter_currency cc, counter_issuer ci, count() c from exchanges where ${sqlWin} group by bc, bi, cc, ci order by c desc limit 1`))[0];
    if (!p) log('(f) no trades in the window'); else {
      const a = (c, i) => (c === CFG.nat && !i ? CFG.nat : `${c}+${i}`);
      const r = (await get(`/v2/exchanges/${a(p.bc, p.bi)}/${a(p.cc, p.ci)}?${win}&reduce=true`)).json.exchanges[0];
      const sql = (await ch(`select count() c, sum(base_amount_f) bv, sum(counter_amount_f) cv from exchanges where ${sqlWin} and base_currency='${p.bc}' and base_issuer='${p.bi}' and counter_currency='${p.cc}' and counter_issuer='${p.ci}' and (counter_currency != '${CFG.nat}' or counter_amount_f > 0.0005) and (base_currency != '${CFG.nat}' or base_amount_f > 0.0005)`))[0];
      log(`(f) reduce ${a(p.bc, p.bi)}/${a(p.cc, p.ci)}: api count ${r.count} base_volume ${r.base_volume} counter_volume ${r.counter_volume} | SQL count ${sql.c} base_volume ${Number(sql.bv).toFixed(4)} counter_volume ${Number(sql.cv).toFixed(4)} => ${r.count === Number(sql.c) && Math.abs(Number(r.base_volume) - Number(sql.bv)) / Number(sql.bv) < 1e-9 ? 'EQUAL (count, base volume)' : 'DIFFERENT'}`); } }
  fs.writeFileSync(`${S}/logs/semantic-${net}.log`, out.join('\n') + '\n');
})().catch((e) => { console.error('SEMANTIC CRASH', e); process.exit(1); });
