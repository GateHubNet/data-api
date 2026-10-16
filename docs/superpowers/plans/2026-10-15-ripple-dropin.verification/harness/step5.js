// Step 5 spot checks against the node. usage: node step5.js <xrpl|xahau>
const fs = require('fs'); const crypto = require('crypto');
const S = '/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify';
const R = '/Users/golobitch/github.com/GateHubNet/data-api-new';
const net = process.argv[2];
const CFG = { xrpl: { port: 13001, node: 'wss://xrplcluster.com', nat: 'XRP' }, xahau: { port: 13011, node: 'wss://xahau.network', nat: 'XAH' } }[net];
const xrpl = require(require.resolve('xrpl', { paths: [R + '/apps/api', R] }));
const codec = require(require.resolve('ripple-binary-codec', { paths: [R + '/packages/shared', R + '/apps/api', R] }));
const KEY = fs.readFileSync(`${S}/env/api.key.env`, 'utf8').match(/GH_API_KEYS=(.*)/)[1].trim();
const api = async (p) => { const r = await fetch(`http://127.0.0.1:${CFG.port}${p}`, { headers: { 'X-API-Key': KEY } }); return { status: r.status, json: await r.json() }; };
const ch = async (sql) => { const r = await fetch(`http://127.0.0.1:18123/?database=${net}&default_format=JSONEachRow`, { method: 'POST', body: sql }); const t = await r.text(); if (!r.ok) throw new Error(t); return t.trim() ? t.trim().split('\n').map(JSON.parse) : []; };
const out = []; const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
const half = (buf) => crypto.createHash('sha512').update(buf).digest().subarray(0, 32);
const vl = (b) => { const n = b.length; let h; if (n <= 192) h = Buffer.from([n]); else if (n <= 12480) { const m = n - 193; h = Buffer.from([193 + (m >> 8), m & 255]); } else { const m = n - 12481; h = Buffer.from([241 + (m >> 16), (m >> 8) & 255, m & 255]); } return Buffer.concat([h, b]); };
// SHAMap root over transaction leaves (key = tx id)
function shamapRoot(leaves /* [{id:Buffer, hash:Buffer}] */, depth = 0) {
  if (leaves.length === 0) return Buffer.alloc(32);
  const nib = (id, d) => (d % 2 === 0 ? id[d >> 1] >> 4 : id[d >> 1] & 15);
  const build = (items, d) => {
    if (items.length === 1 && d > 0) return items[0].hash;
    const kids = Array.from({ length: 16 }, () => []);
    items.forEach((it) => kids[nib(it.id, d)].push(it));
    const parts = [Buffer.from('4D494E00', 'hex')];
    kids.forEach((k) => parts.push(k.length ? build(k, d + 1) : Buffer.alloc(32)));
    return half(Buffer.concat(parts));
  };
  return build(leaves, 0);
}
(async () => {
  const client = new xrpl.Client(CFG.node, { timeout: 60000 }); await client.connect();
  const req = async (c) => (await client.request(c)).result;
  try {
    // ---------- (1) /ledgers/{index} vs node `ledger` ----------
    const lr = (await ch('select ledger_index li from ledgers order by ledger_index desc limit 1 offset 20'))[0].li;
    const idxs = [lr, lr - 300, lr - 450].filter((x) => x > 0);
    for (const li of idxs) {
      const a = (await api(`/v2/ledgers/${li}`)).json.ledger;
      const n = (await req({ command: 'ledger', ledger_index: li })).ledger;
      const cmp = { ledger_hash: n.ledger_hash, parent_hash: n.parent_hash, total_coins: n.total_coins, close_time: n.close_time + 946684800, close_time_resolution: String(n.close_time_resolution), close_flags: String(n.close_flags), parent_close_time: n.parent_close_time + 946684800, account_hash: n.account_hash, transaction_hash: n.transaction_hash };
      const diffs = Object.keys(cmp).filter((k) => String(a[k]) !== String(cmp[k]));
      log(`(1) ledger ${li}: ${diffs.length ? 'DIFF ' + diffs.map((k) => `${k} api=${a[k]} node=${cmp[k]}`).join('; ') : 'all 9 header fields equal the node (close_time converted from the ripple epoch to unix seconds, as the API serves it)'}`);
    }
    // ---------- (2) binary=true re-hash: each tx blob -> hash ----------
    let ok = 0, bad = 0, badEx = [];
    const page = await api(`/v2/transactions?binary=true&limit=100&descending=true`);
    for (const t of page.json.transactions) {
      const h = half(Buffer.concat([Buffer.from('54584E00', 'hex'), Buffer.from(t.tx, 'hex')])).toString('hex').toUpperCase();
      if (h === t.hash) ok++; else { bad++; if (badEx.length < 3) badEx.push(t.hash); }
    }
    log(`(2) /v2/transactions?binary=true (100 newest): ${ok} re-hash to hash, ${bad} do not ${badEx.join(',')}`);
    // single-tx endpoint across types
    const types = await ch(`select tx_type t, any(hash) h from transactions group by tx_type order by count() desc limit 12`);
    for (const t of types) {
      const b = (await api(`/v2/transactions/${t.h}?binary=true`)).json.transaction;
      const h = half(Buffer.concat([Buffer.from('54584E00', 'hex'), Buffer.from(b.tx, 'hex')])).toString('hex').toUpperCase();
      const j = (await api(`/v2/transactions/${t.h}`)).json.transaction;
      let dec = 'n/a';
      try { dec = JSON.stringify(codec.decode(b.tx)) === JSON.stringify(codec.decode(codec.encode(codec.decode(b.tx)))) ? 'codec roundtrip ok' : 'codec roundtrip differs'; } catch (e) { dec = 'codec(xrpl defs) cannot decode: ' + String(e.message).slice(0, 40); }
      log(`    ${t.t.padEnd(26)} hash ${h === t.h ? 'OK ' : 'BAD'} (${t.h.slice(0, 12)}..) json.hash==hash:${j.hash === t.h} ${dec}`);
    }
    // ---------- (2b) ledger transaction tree: binary txs of a ledger re-hash to ledger.transaction_hash ----------
    const lids = (await ch(`select ledger_index li, tx_count c, transaction_hash th from ledgers where tx_count > 5 order by ledger_index desc limit 3 offset 30`));
    for (const L of lids) {
      const led = (await api(`/v2/ledgers/${L.li}?binary=true`)).json.ledger;
      const leaves = led.transactions.map((t) => {
        const tx = Buffer.from(t.tx, 'hex'); const meta = Buffer.from(t.meta, 'hex'); const id = Buffer.from(t.hash, 'hex');
        return { id, hash: half(Buffer.concat([Buffer.from('534E4400', 'hex'), vl(tx), vl(meta), id])) };
      });
      const root = shamapRoot(leaves).toString('hex').toUpperCase();
      log(`(2b) ledger ${L.li} (${L.c} txs): tx-tree root ${root === led.transaction_hash ? 'EQUALS' : 'DIFFERS from'} ledger.transaction_hash`);
    }
    // ---------- (3) /balances vs account_lines ----------
    const acct = (await ch(`select buyer a, count() c from exchanges group by buyer order by c desc limit 1`))[0]?.a || (await ch(`select source a, count() c from payments group by source order by c desc limit 1`))[0].a;
    const bal = (await api(`/v2/accounts/${acct}/balances?limit=all`)).json;
    const li = bal.ledger_index;
    const info = await req({ command: 'account_info', account: acct, ledger_index: li });
    let lines = []; let marker; do { const r = await req({ command: 'account_lines', account: acct, ledger_index: li, limit: 400, marker }); lines = lines.concat(r.lines); marker = r.marker; } while (marker);
    const want = [{ currency: CFG.nat, value: new (require(require.resolve('bignumber.js', { paths: [R + '/packages/shared', R] })))(info.account_data.Balance).div(1e6).toFixed() }, ...lines.map((l) => ({ currency: l.currency, counterparty: l.account, value: l.balance }))];
    const key = (b) => `${b.currency}|${b.counterparty || ''}`;
    const A = new Map(bal.balances.map((b) => [key(b), b.value])); const W = new Map(want.map((b) => [key(b), b.value]));
    const BN = require(require.resolve('bignumber.js', { paths: [R + '/packages/shared', R] }));
    const diffs = [];
    for (const [k, v] of W) { if (!A.has(k)) diffs.push(`missing in api: ${k}`); else if (!new BN(A.get(k)).eq(new BN(v))) diffs.push(`${k} api=${A.get(k)} node=${v}`); }
    for (const [k] of A) if (!W.has(k)) diffs.push(`extra in api: ${k}`);
    log(`(3) /balances ${acct} at ledger ${li}: api ${A.size} balances vs node ${W.size} (1 account_info + ${lines.length} account_lines): ${diffs.length ? 'DIFF ' + diffs.slice(0, 5).join('; ') : 'identical'}`);
    // orders vs account_offers
    const ord = (await api(`/v2/accounts/${acct}/orders?limit=all`)).json;
    let offers = []; marker = undefined; do { const r = await req({ command: 'account_offers', account: acct, ledger_index: ord.ledger_index, limit: 400, marker }); offers = offers.concat(r.offers); marker = r.marker; } while (marker);
    log(`(3b) /orders ${acct} at ledger ${ord.ledger_index}: api ${ord.orders.length} orders vs node account_offers ${offers.length}; sequences equal: ${JSON.stringify(ord.orders.map((o) => o.properties.sequence).sort()) === JSON.stringify(offers.map((o) => o.seq).sort())}`);
    // ---------- (4) validations exist for recent ledgers ----------
    const from = process.env.VAL_FROM, to = process.env.VAL_TO; // a window in which the validations worker ran without a break
    const v = await ch(`select l.ledger_index li, countIf(v.validation_public_key != '') n from (select ledger_index, ledger_hash from ledgers where ${from ? `close_time between toDateTime('${from}') and toDateTime('${to}')` : '1'} order by ledger_index desc limit 400) l left join validations v on v.ledger_hash = l.ledger_hash group by li order by li`);
    const withV = v.filter((x) => Number(x.n) > 0).length; const nmin = Math.min(...v.map((x) => Number(x.n))); const nmax = Math.max(...v.map((x) => Number(x.n)));
    const first = (await ch(`select min(ts) m from fee_stats`))[0];
    const vsince = (await ch(`select min(first_datetime) m, max(last_datetime) x, uniqExact(validation_public_key) vk, uniqExact(reporter_public_key) rk, count() c from validations`))[0];
    log(`(4) validations: ${withV}/${v.length} stored ledgers closed in [${from || 'any'} .. ${to || 'now'}] have >= 1 validation (per-ledger validators min ${nmin} max ${nmax}); table: ${vsince.c} rows, ${vsince.vk} validators, ${vsince.rk} reporter(s), ${vsince.m} .. ${vsince.x}`);
    // ---------- (5) fee_stats cadence ----------
    const ts = (await ch(`select toUnixTimestamp64Milli(ts) t from fee_stats order by ts`)).map((x) => Number(x.t));
    const d = ts.slice(1).map((t, i) => (t - ts[i]) / 1000);
    const runs = d.filter((x) => x < 30);
    runs.sort((a, b) => a - b);
    const q = (p) => runs[Math.floor(p * (runs.length - 1))];
    log(`(5) fee_stats: ${ts.length} rows; ${runs.length} deltas < 30 s: median ${q(0.5).toFixed(2)} s, p90 ${q(0.9).toFixed(2)} s, p99 ${q(0.99).toFixed(2)} s, mean ${(runs.reduce((a, b) => a + b, 0) / runs.length).toFixed(2)} s; gaps >= 30 s: ${d.filter((x) => x >= 30).map((x) => x.toFixed(0)).join(',') || 'none'}`);
  } finally { await client.disconnect(); }
  fs.writeFileSync(`${S}/logs/step5-${net}.log`, out.join('\n') + '\n');
})().catch((e) => { console.error('STEP5 CRASH', e); process.exit(1); });
