// usage: node rpc.js <wss-url> '<json command>'  (uses xrpl.js from the repo's node_modules)
const path = require('path');
const root = '/Users/golobitch/github.com/GateHubNet/data-api-new';
const xrpl = require(require.resolve('xrpl', { paths: [root + '/apps/api', root] }));
(async () => {
  const [url, cmd] = process.argv.slice(2);
  const c = new xrpl.Client(url, { timeout: 60000 });
  await c.connect();
  try {
    const r = await c.request(JSON.parse(cmd));
    console.log(JSON.stringify(r.result));
  } finally { await c.disconnect(); }
})().catch((e) => { console.error('ERR', e.message || e); process.exit(1); });
