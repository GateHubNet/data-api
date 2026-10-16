// VERIFICATION-ONLY WORKAROUND (not product code, nothing in the repo is changed): Xahau's UNLReport pseudo-transaction
// has Account "" and build-rows.js senderOf() throws on it, which blocks ingest of every 256th ledger. This preload patches
// the module text in memory so the verification can continue: an empty Account becomes ACCOUNT_ZERO, as XRPL pseudo-txs have.
const Module = require('module');
const orig = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  if (/shared\/dist\/ingest\/build-rows\.js$/.test(filename)) {
    const before = content;
    content = content.replace(/if \(typeof sender !== 'string' \|\| sender === ''\) \{/, "if (sender === '') return 'rrrrrrrrrrrrrrrrrrrrrhoLvTp';\n    if (typeof sender !== 'string') {");
    if (content === before) console.error('[workaround-unlreport] PATTERN NOT FOUND');
    else console.error('[workaround-unlreport] patched ' + filename);
  }
  return orig.call(this, content, filename);
};
