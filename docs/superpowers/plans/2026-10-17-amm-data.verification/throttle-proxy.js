// A throttling WebSocket pass-through for a public XRPL node, for verification runs only.
//   - one request in flight upstream, at least GAP_MS between the end of one answer and the start of the next
//   - on the FIRST rate-limit answer (slowDown / tooBusy / "too much load" / "rate limit") it writes the STOP file, tells the client and exits 3
//   - logs one line per request (time, command, ledger, ms, ok/error) so the number of requests made can be counted
// usage: PORT=24001 UP=wss://s2.ripple.com GAP_MS=1500 LOG=<file> STOP=<file> node throttle-proxy.js
const fs = require('fs');
const path = require('path');
const root = '/Users/golobitch/github.com/GateHubNet/data-api-new';
const WebSocket = require(require.resolve('ws', { paths: [root + '/apps/syncer', root] }));

const PORT = Number(process.env.PORT || 24001);
const UP = process.env.UP || 'wss://s2.ripple.com';
const GAP_MS = Number(process.env.GAP_MS || 1500);
const LOG = process.env.LOG || path.join(__dirname, 'logs', 'proxy.log');
const STOP = process.env.STOP || path.join(__dirname, 'STOPPED');
const log = (s) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);

let up = null;
let upReady = null;
let nextId = 1;
const queue = [];
let inflight = null;
let total = 0;
let stopping = false;
let nextAllowed = 0; // earliest time (ms) the next request may be sent upstream
let timer = null;

function connectUp() {
  if (up && up.readyState === WebSocket.OPEN) return Promise.resolve(up);
  if (upReady) return upReady;
  upReady = new Promise((resolve, reject) => {
    const ws = new WebSocket(UP);
    ws.on('open', () => { up = ws; upReady = null; log(`upstream connected ${UP}`); resolve(ws); });
    ws.on('error', (e) => { upReady = null; log(`upstream error ${e.message}`); reject(e); });
    ws.on('close', () => { log('upstream closed'); if (up === ws) up = null; });
    ws.on('message', (data) => onUp(data.toString()));
  });
  return upReady;
}

function isLimit(msg) {
  if (!(msg.status === 'error' || msg.error)) return false;
  return /slowDown|tooBusy|too much load|rate limit|retry in/i.test(JSON.stringify(msg));
}

function onUp(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!inflight || msg.id !== inflight.upId) {
    // a stream message (subscription): hand it to every client unchanged
    if (msg.id === undefined) for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(text);
    return;
  }
  const cur = inflight;
  inflight = null;
  const ms = Date.now() - cur.t0;
  const limited = isLimit(msg);
  log(`#${total} ${cur.desc} ${ms}ms ${limited ? 'RATE-LIMIT ' + JSON.stringify(msg).slice(0, 300) : msg.status === 'error' ? 'error ' + (msg.error || '') : 'ok'}`);
  msg.id = cur.clientId;
  if (cur.client.readyState === WebSocket.OPEN) cur.client.send(JSON.stringify(msg));
  if (limited) {
    stopping = true;
    fs.writeFileSync(STOP, `${new Date().toISOString()} rate-limit answer at request #${total}: ${JSON.stringify(msg).slice(0, 300)}\n`);
    log('STOPPING on the first rate-limit answer');
    setTimeout(() => process.exit(3), 300);
    return;
  }
  nextAllowed = Date.now() + GAP_MS;
  schedule();
}

function schedule() {
  if (timer) return;
  const wait = Math.max(0, nextAllowed - Date.now());
  timer = setTimeout(() => {
    timer = null;
    pump();
  }, wait);
}

async function pump() {
  if (stopping || inflight || queue.length === 0) return;
  if (Date.now() < nextAllowed) return schedule();
  const job = queue.shift();
  inflight = job;
  try {
    const ws = await connectUp();
    job.upId = nextId++;
    job.t0 = Date.now();
    total++;
    ws.send(JSON.stringify({ ...job.req, id: job.upId }));
  } catch (e) {
    inflight = null;
    log(`send failed ${e.message}`);
    if (job.client.readyState === WebSocket.OPEN)
      job.client.send(JSON.stringify({ id: job.clientId, status: 'error', type: 'response', error: 'proxyUpstream', error_message: e.message, request: job.req }));
    nextAllowed = Date.now() + GAP_MS;
    schedule();
  }
}

const wss = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('listening', () => log(`proxy listening on 127.0.0.1:${PORT} -> ${UP}, gap ${GAP_MS} ms`));
wss.on('connection', (client) => {
  client.on('message', (data) => {
    let req;
    try { req = JSON.parse(data.toString()); } catch { return; }
    if (stopping) return;
    const desc = `${req.command}${req.ledger_index !== undefined ? ' ledger=' + req.ledger_index : ''}${req.transaction ? ' tx=' + String(req.transaction).slice(0, 8) : ''}${req.amm_account ? ' amm=' + req.amm_account : ''}`;
    queue.push({ client, clientId: req.id, req, desc });
    schedule();
  });
});
process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });
