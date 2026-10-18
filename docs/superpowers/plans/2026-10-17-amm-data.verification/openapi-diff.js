// compares paths / methods / parameter names of docs/openapi.yaml with the live /internal/docs-json
const fs = require('fs');
const root = '/Users/golobitch/github.com/GateHubNet/data-api-new';
const yaml = require(require.resolve('js-yaml', { paths: [root + '/node_modules/.pnpm/js-yaml@4.1.0/node_modules', root] }));
const live = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const doc = yaml.load(fs.readFileSync(root + '/docs/openapi.yaml', 'utf8'));
const sig = (spec) => {
  const out = {};
  for (const [p, ops] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(ops)) out[`${m.toUpperCase()} ${p}`] = (op.parameters || []).map((x) => `${x.in}:${x.name}`).sort();
  return out;
};
const a = sig(live);
const b = sig(doc);
const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
let diffs = 0;
for (const k of [...keys].sort()) {
  if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
    diffs++;
    console.log('DIFF', k, '\n  live:', JSON.stringify(a[k]), '\n  yaml:', JSON.stringify(b[k]));
  }
}
console.log(`live operations ${Object.keys(a).length}, yaml operations ${Object.keys(b).length}, differences ${diffs}`);
console.log('amm paths in live:', Object.keys(a).filter((k) => /amm/.test(k)).join(' | '));
