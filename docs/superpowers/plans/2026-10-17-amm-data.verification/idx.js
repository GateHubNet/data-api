const root = '/Users/golobitch/github.com/GateHubNet/data-api-new';
const xrpl = require(require.resolve('xrpl', { paths: [root + '/apps/api', root] }));
const [a, b, c] = process.argv.slice(2);
console.log(xrpl.hashes.hashTrustline(a, b, c));
