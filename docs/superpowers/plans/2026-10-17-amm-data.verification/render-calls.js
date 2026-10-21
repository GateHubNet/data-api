// Renders the calls of an amm-smoke.js run (<dir>/summary.json and the saved responses) as a markdown table:
// number, request, status, time, trimmed body. usage: node render-calls.js <smoke dir>
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const short = (r) => r.replace(/^GET /, '').replace(/marker=[A-Za-z0-9%_-]{16,}/g, 'marker=…');
console.log('| # | Request | Status | ms | Body (trimmed) |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of summary.results) {
  const f = fs.readdirSync(dir).find((x) => x.startsWith(r.n + '-'));
  const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  let body = typeof rec.body === 'string' ? rec.body.split('\n').slice(0, 2).join(' / ') : JSON.stringify(rec.body);
  body = body.replace(/"marker":"[^"]{16,}"/g, '"marker":"…"');
  if (body.length > 110) body = body.slice(0, 107) + '...';
  console.log(`| ${r.n} | \`${esc(short(r.request)).slice(0, 190)}\` | ${r.status} | ${r.ms} | ${esc(body) || '(empty body)'} |`);
}
