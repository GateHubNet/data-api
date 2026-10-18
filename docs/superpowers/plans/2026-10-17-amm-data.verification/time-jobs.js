// Verification-only preload (node --require): prints one line per aggregator job run with its wall time, so the first
// measurement of the AMM jobs at mainnet data shape can be read from the syncer log. Changes no product file.
const root = '/Users/golobitch/github.com/GateHubNet/data-api-new';
const { AggregatorService } = require(root + '/apps/syncer/dist/aggregator/aggregator.service.js');
const proto = AggregatorService.prototype;
const original = proto.runJobs;
let tickNo = 0;
proto.runJobs = function (tick) {
  if (!this.__timed) {
    this.__timed = true;
    for (const job of this.jobs) {
      const run = job.run;
      job.run = async function (t) {
        const t0 = Date.now();
        try {
          return await run.call(this, t);
        } finally {
          console.log(`[T12-JOB] ${new Date().toISOString()} tick=${tickNo} job=${job.name} ms=${Date.now() - t0}`);
        }
      };
    }
  }
  tickNo++;
  const t0 = Date.now();
  return Promise.resolve(original.call(this, tick)).finally(() => console.log(`[T12-TICK] ${new Date().toISOString()} tick=${tickNo - 1} ms=${Date.now() - t0}`));
};
