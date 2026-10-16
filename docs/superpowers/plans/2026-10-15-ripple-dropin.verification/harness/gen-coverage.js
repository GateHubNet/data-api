// Renders smoke/<network>/_results.json as the endpoint coverage table (markdown)
const fs = require('fs');
const S = '/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify';
const net = process.argv[2];
const res = JSON.parse(fs.readFileSync(`${S}/smoke/${net}/_results.json`, 'utf8'));
const kinds = ['json', 'csv', 'paging', 'bad-param', '401'];
const order = []; const by = new Map();
for (const r of res) { if (!by.has(r.endpoint)) { by.set(r.endpoint, []); order.push(r.endpoint); } by.get(r.endpoint).push(r); }
const cell = (rows, kind) => {
  const k = rows.filter((r) => r.kind === kind);
  if (!k.length) return 'n/a';
  const fails = k.filter((r) => r.verdict === 'fail'); const passes = k.filter((r) => r.verdict === 'pass'); const skips = k.filter((r) => r.verdict === 'skip');
  if (fails.length) return `FAIL (${fails.length}/${k.length})`;
  if (passes.length) return `pass${passes.length > 1 ? ' x' + passes.length : ''}${skips.length ? ' (+' + skips.length + ' skip)' : ''}`;
  return 'skip';
};
console.log(`| Endpoint | json | csv | paging (2-page walk) | bad param | no key (401) |`);
console.log(`| --- | --- | --- | --- | --- | --- |`);
for (const e of order) {
  const rows = by.get(e);
  console.log(`| \`${e}\` | ${kinds.map((k) => cell(rows, k)).join(' | ')} |`);
}
const c = { pass: 0, fail: 0, skip: 0 }; res.forEach((r) => c[r.verdict]++);
console.log(`\nTotals: ${c.pass} pass, ${c.fail} fail, ${c.skip} skip (${res.length} checks).`);
console.log('\nSkips and failures:');
for (const r of res.filter((x) => x.verdict !== 'pass')) console.log(`- ${r.verdict.toUpperCase()} ${r.endpoint} [${r.kind}] ${r.name}: ${r.note}`);
