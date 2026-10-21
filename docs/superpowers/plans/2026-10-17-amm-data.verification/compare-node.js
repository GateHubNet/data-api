// Compares what the local API serves with what the node says (amm_info at the pool's last_ledger, tx metadata, account_lines).
//   API_BASE=... API_KEY=... CH_URL=... NODE_WS=ws://127.0.0.1:24001 (the throttling proxy; or wss://s2.ripple.com) OUT=<dir> node compare-node.js
// One request at a time, a pause between requests, and the first error that looks like a rate limit ends the run (exit 3).
const fs = require('fs');
const path = require('path');
const root = '/Users/golobitch/github.com/GateHubNet/data-api-new';
const xrpl = require(require.resolve('xrpl', { paths: [root + '/apps/api', root] }));
const BigNumber = require(require.resolve('bignumber.js', { paths: [root + '/apps/syncer', root + '/apps/api', root] }));

const BASE = process.env.API_BASE || 'http://127.0.0.1:23001';
const KEY = process.env.API_KEY || '';
const CH = process.env.CH_URL || 'http://127.0.0.1:28123';
const DB = process.env.DB || 'xrpl';
const NODE = process.env.NODE_WS || 'ws://127.0.0.1:24001';
const PAUSE = Number(process.env.PAUSE_MS || 800);
const OUT = process.env.OUT || path.join(__dirname, 'node');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p) {
  const r = await fetch(BASE + p, { headers: { 'X-API-Key': KEY } });
  return { status: r.status, json: await r.json() };
}
async function ch(sql) {
  const r = await fetch(`${CH}/?default_format=JSONEachRow`, { method: 'POST', body: sql });
  const t = (await r.text()).trim();
  if (!r.ok) throw new Error(t);
  return t === '' ? [] : t.split('\n').map((l) => JSON.parse(l));
}

let client;
let nodeCalls = 0;
async function node(cmd) {
  if (!client) {
    client = new xrpl.Client(NODE, { timeout: 60000 });
    await client.connect();
  }
  nodeCalls++;
  try {
    const res = await client.request(cmd);
    await sleep(PAUSE);
    return res.result;
  } catch (e) {
    const text = String((e && (e.message || e.data && JSON.stringify(e.data))) || e);
    if (/slowDown|tooBusy|too much load|rate limit|retry in/i.test(text)) {
      console.log(`RATE-LIMIT answer from the node on ${JSON.stringify(cmd)}: ${text.slice(0, 200)} -> stopping`);
      process.exit(3);
    }
    return { error: text.slice(0, 300) };
  }
}

const bn = (v) => new BigNumber(v);
const drops = (d) => bn(d).dividedBy(1e6);
function amountOf(a) {
  // node amount -> { currency, issuer?, value } in whole units
  if (typeof a === 'string') return { currency: 'XRP', value: drops(a) };
  return { currency: a.currency, issuer: a.issuer, value: bn(a.value) };
}
const same = (x, y) => bn(x).isEqualTo(bn(y));

const rows = { pools: [], swaps: [], positions: [], governance: [] };

(async () => {
  // ------------------------------------------------------------------ pools: amm_info at the pool's last_ledger
  const full = await ch(`SELECT amm_account FROM ${DB}.amm_pools FINAL WHERE lp_supply IS NOT NULL AND trading_fee IS NOT NULL ORDER BY last_ledger DESC LIMIT 8`);
  const swapOnly = await ch(`SELECT amm_account FROM ${DB}.amm_pools FINAL WHERE lp_supply IS NULL AND reserve_base IS NOT NULL AND reserve_counter IS NOT NULL ORDER BY value_native DESC LIMIT 3`);
  const picks = [...full.map((x) => ({ a: x.amm_account, kind: 'full (deposit/withdraw/create in range)' })), ...swapOnly.map((x) => ({ a: x.amm_account, kind: 'swap-only (reserves)' }))];
  for (const { a, kind } of picks) {
    const served = (await api(`/v2/amm/pools/${a}`)).json.pool;
    const info = await node({ command: 'amm_info', amm_account: a, ledger_index: served.last_ledger });
    if (info.error) {
      rows.pools.push({ pool: a, kind, last_ledger: served.last_ledger, error: info.error });
      continue;
    }
    const amm = info.amm;
    const sides = [amountOf(amm.amount), amountOf(amm.amount2)];
    const find = (cur, iss) => sides.find((s) => s.currency === cur && (s.issuer || '') === (iss || ''));
    const nb = find(served.base_currency, served.base_issuer);
    const nc = find(served.counter_currency, served.counter_issuer);
    const row = {
      pool: a,
      kind,
      pair: `${served.base_currency}${served.base_issuer ? '+' + served.base_issuer : ''} / ${served.counter_currency}${served.counter_issuer ? '+' + served.counter_issuer : ''}`,
      last_ledger: served.last_ledger,
      ledger_index_node: info.ledger_index,
      served: { reserve_base: served.reserve_base, reserve_counter: served.reserve_counter, lp_supply: served.lp_supply, trading_fee: served.trading_fee, lp_currency: served.lp_currency, auction_holder: served.auction_slot && served.auction_slot.holder },
      node: {
        reserve_base: nb && nb.value.toFixed(),
        reserve_counter: nc && nc.value.toFixed(),
        lp_supply: amm.lp_token && amm.lp_token.value,
        trading_fee: amm.trading_fee,
        lp_currency: amm.lp_token && amm.lp_token.currency,
        auction_holder: amm.auction_slot && amm.auction_slot.account,
        amount_raw: amm.amount,
        amount2_raw: amm.amount2,
      },
    };
    row.match = {
      reserve_base: served.reserve_base === undefined ? 'n/a (not served)' : nb && same(served.reserve_base, nb.value),
      reserve_counter: served.reserve_counter === undefined ? 'n/a (not served)' : nc && same(served.reserve_counter, nc.value),
      lp_supply: served.lp_supply === undefined ? 'n/a (not served)' : same(served.lp_supply, amm.lp_token.value),
      trading_fee: served.trading_fee === undefined ? 'n/a (not served)' : served.trading_fee === amm.trading_fee,
      lp_currency: served.lp_currency === undefined ? 'n/a (not served)' : served.lp_currency === amm.lp_token.currency,
      auction_holder: served.auction_slot === undefined ? 'n/a (not served)' : (served.auction_slot.holder || '') === ((amm.auction_slot && amm.auction_slot.account) || ''),
    };
    rows.pools.push(row);
    console.log(`pool ${a} @${served.last_ledger}: ${JSON.stringify(row.match)}`);
  }

  // ------------------------------------------------------------------ swaps: the pool's deltas in the transaction metadata
  const sel = [];
  const take = async (label, sql) => {
    const r = await ch(sql);
    if (r.length) sel.push({ label, ...r[0] });
  };
  const cols = 'tx_hash, amm_account, node_index, tx_type, ledger_index, base_currency, base_issuer, counter_currency, counter_issuer, base_amount, counter_amount, buyer, seller, taker';
  await take('Payment through an XRP pool', `SELECT ${cols} FROM ${DB}.exchanges WHERE amm_account != '' AND tx_type = 'Payment' AND counter_currency = 'XRP' ORDER BY ledger_index, tx_index LIMIT 1`);
  await take('OfferCreate crossing an XRP pool', `SELECT ${cols} FROM ${DB}.exchanges WHERE amm_account != '' AND tx_type = 'OfferCreate' ORDER BY ledger_index DESC, tx_index LIMIT 1`);
  await take('Payment through an IOU/IOU pool', `SELECT ${cols} FROM ${DB}.exchanges WHERE amm_account != '' AND base_issuer != '' AND counter_issuer != '' ORDER BY ledger_index DESC, tx_index LIMIT 1`);
  await take('a pool of a transaction that crosses 4 pools', `SELECT ${cols} FROM ${DB}.exchanges WHERE amm_account != '' AND tx_hash IN (SELECT tx_hash FROM ${DB}.exchanges WHERE amm_account != '' GROUP BY tx_hash HAVING count() = 4 LIMIT 1) ORDER BY node_index LIMIT 1 OFFSET 2`);
  await take('Payment through an XRP pool, newest', `SELECT ${cols} FROM ${DB}.exchanges WHERE amm_account != '' AND tx_type = 'Payment' AND counter_currency = 'XRP' AND base_issuer != '' ORDER BY ledger_index DESC, tx_index DESC LIMIT 1`);

  const txCache = new Map();
  for (const s of sel) {
    if (!txCache.has(s.tx_hash)) txCache.set(s.tx_hash, await node({ command: 'tx', transaction: s.tx_hash }));
    const tx = txCache.get(s.tx_hash);
    if (tx.error) {
      rows.swaps.push({ ...s, error: tx.error });
      continue;
    }
    const meta = tx.meta || tx.metaData;
    const pool = s.amm_account;
    // pool balance before/after for an asset
    const delta = (cur, iss) => {
      let total = bn(0);
      let nodes = 0;
      for (const n of meta.AffectedNodes) {
        const k = Object.keys(n)[0];
        const d = n[k];
        const fin = d.FinalFields || d.NewFields;
        const prev = d.PreviousFields;
        if (cur === 'XRP' && d.LedgerEntryType === 'AccountRoot' && fin && fin.Account === pool) {
          const after = bn(fin.Balance);
          const before = prev && prev.Balance !== undefined ? bn(prev.Balance) : k === 'CreatedNode' ? bn(0) : after;
          total = total.plus(after.minus(before).dividedBy(1e6));
          nodes++;
        }
        if (cur !== 'XRP' && d.LedgerEntryType === 'RippleState' && fin && fin.Balance && fin.Balance.currency === cur) {
          const low = fin.LowLimit.issuer;
          const high = fin.HighLimit.issuer;
          if ((low === pool && high === iss) || (high === pool && low === iss)) {
            const sign = low === pool ? 1 : -1;
            const after = bn(fin.Balance.value).times(sign);
            const before = prev && prev.Balance ? bn(prev.Balance.value).times(sign) : after;
            total = total.plus(after.minus(before));
            nodes++;
          }
        }
      }
      return { value: total, nodes };
    };
    const db = delta(s.base_currency, s.base_issuer);
    const dc = delta(s.counter_currency, s.counter_issuer);
    // the API as the swaps route of the pool serves it, at this transaction
    const served = (await api(`/v2/amm/pools/${pool}/swaps?limit=400`)).json.exchanges.find((x) => x.tx_hash === s.tx_hash && x.node_index === s.node_index);
    const row = {
      label: s.label,
      tx_hash: s.tx_hash,
      tx_type: s.tx_type,
      ledger_index: s.ledger_index,
      pool,
      pair: `${s.base_currency}${s.base_issuer ? '+' + s.base_issuer : ''} / ${s.counter_currency}${s.counter_issuer ? '+' + s.counter_issuer : ''}`,
      node_index: s.node_index,
      served: served && { base_amount: served.base_amount, counter_amount: served.counter_amount, buyer: served.buyer, seller: served.seller, taker: served.taker, rate: served.rate },
      node: { base_delta_pool: db.value.toFixed(), counter_delta_pool: dc.value.toFixed(), base_nodes: db.nodes, counter_nodes: dc.nodes, account: meta && tx.Account, tx_result: meta.TransactionResult },
    };
    row.match = served && {
      base_amount: same(served.base_amount, db.value.abs()),
      counter_amount: same(served.counter_amount, dc.value.abs()),
      taker_is_sender: served.taker === tx.Account,
      direction: db.value.isNegative() ? served.seller === pool && served.buyer === tx.Account : served.buyer === pool && served.seller === tx.Account,
    };
    rows.swaps.push(row);
    console.log(`swap ${s.tx_hash.slice(0, 10)} ${s.label}: ${JSON.stringify(row.match)}`);
  }

  // ------------------------------------------------------------------ positions: account_lines of the LP at the newest ledger
  const newest = (await ch(`SELECT max(ledger_index) AS m FROM ${DB}.ledgers`))[0].m;
  const lps = await ch(`SELECT account, amm_account FROM ${DB}.amm_liquidity WHERE event = 'deposit' GROUP BY account, amm_account ORDER BY max(ledger_index) DESC LIMIT 4`);
  for (const lp of lps) {
    const pos = (await api(`/v2/accounts/${lp.account}/amm_positions`)).json.positions.find((x) => x.pool === lp.amm_account);
    // the LP-token line is read by its ledger index (account_lines with a peer filter is a paged search and can return an empty page with a marker)
    const lpCurrency = pos && pos.lp_currency;
    const entry = await node({ command: 'ledger_entry', index: xrpl.hashes.hashTrustline(lp.account, lp.amm_account, lpCurrency), ledger_index: Number(newest) });
    const info = await node({ command: 'amm_info', amm_account: lp.amm_account, ledger_index: Number(newest) });
    if ((entry.error && !/entryNotFound/.test(entry.error)) || info.error) {
      rows.positions.push({ account: lp.account, pool: lp.amm_account, error: entry.error || info.error });
      continue;
    }
    const supply = bn(info.amm.lp_token.value);
    const nodeBal = entry.node ? bn(entry.node.Balance.value).times(entry.node.LowLimit.issuer === lp.account ? 1 : -1) : bn(0);
    const sides = [amountOf(info.amm.amount), amountOf(info.amm.amount2)];
    const pool = (await api(`/v2/amm/pools/${lp.amm_account}`)).json.pool;
    const sb = sides.find((s) => s.currency === pool.base_currency && (s.issuer || '') === (pool.base_issuer || ''));
    const sc = sides.find((s) => s.currency === pool.counter_currency && (s.issuer || '') === (pool.counter_issuer || ''));
    const row = {
      account: lp.account,
      pool: lp.amm_account,
      ledger: Number(newest),
      served: pos,
      node: { lp_balance: nodeBal.toFixed(), lp_supply: supply.toFixed(), share: nodeBal.dividedBy(supply).toPrecision(30), base_amount: sb && nodeBal.times(sb.value).dividedBy(supply).toPrecision(30), counter_amount: sc && nodeBal.times(sc.value).dividedBy(supply).toPrecision(30) },
    };
    row.match = pos && {
      lp_balance: same(pos.lp_balance, nodeBal),
      share_rel_err: pos.share === undefined ? null : bn(pos.share).minus(nodeBal.dividedBy(supply)).abs().dividedBy(nodeBal.dividedBy(supply)).toExponential(2),
      base_amount_rel_err: pos.base_amount !== undefined && sb ? bn(pos.base_amount).minus(nodeBal.times(sb.value).dividedBy(supply)).abs().dividedBy(bn(pos.base_amount)).toExponential(2) : null,
    };
    rows.positions.push(row);
    console.log(`position ${lp.account} in ${lp.amm_account}: ${JSON.stringify(row.match)}`);
  }


  // ------------------------------------------------------------------ governance: the fee after a vote, from amm_info at the vote's ledger
  const votes = await ch(`SELECT amm_account, ledger_index, tx_hash, account, fee_voted, trading_fee_after FROM ${DB}.amm_governance WHERE kind = 'vote' ORDER BY ledger_index LIMIT 3`);
  for (const v of votes) {
    const served = (await api(`/v2/amm/pools/${v.amm_account}/governance?type=vote`)).json.governance.find((x) => x.tx_hash === v.tx_hash);
    const info = await node({ command: 'amm_info', amm_account: v.amm_account, ledger_index: Number(v.ledger_index) });
    if (info.error) {
      rows.governance.push({ pool: v.amm_account, tx_hash: v.tx_hash, error: info.error });
      continue;
    }
    const slot = (info.amm.vote_slots || []).find((x) => x.account === v.account);
    const row = {
      pool: v.amm_account,
      tx_hash: v.tx_hash,
      ledger_index: Number(v.ledger_index),
      served: served && { account: served.account, fee_voted: served.fee_voted, trading_fee_after: served.trading_fee_after },
      node: { trading_fee: info.amm.trading_fee, voter_slot: slot && { trading_fee: slot.trading_fee, vote_weight: slot.vote_weight } },
    };
    row.match = served && { trading_fee_after: served.trading_fee_after === info.amm.trading_fee, fee_voted: slot ? served.fee_voted === slot.trading_fee : 'voter has no slot at that ledger' };
    rows.governance.push(row);
    console.log(`vote ${v.tx_hash.slice(0, 10)} in ${v.amm_account}: ${JSON.stringify(row.match)}`);
  }

  fs.writeFileSync(path.join(OUT, 'compare.json'), JSON.stringify({ node: NODE, node_requests: nodeCalls, ...rows }, null, 2));
  console.log(`done: ${nodeCalls} node requests`);
  if (client) await client.disconnect();
})().catch((e) => {
  console.error('compare crashed:', e);
  process.exit(2);
});
