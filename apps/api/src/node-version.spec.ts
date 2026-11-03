import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/**
 * `ripple-binary-codec` 2.x loads ES-module-only dependencies (`@noble/hashes`, `@scure/base`) with `require(esm)`,
 * which Node enables by default from 20.19.0, 22.12.0 and in every release after 22 (ruling R40).
 */
function hasRequireEsm(major: number, minor: number): boolean {
  if (major === 20) return minor >= 19;
  if (major === 22) return minor >= 12;
  return major > 22;
}

const DOCKERFILES = ['apps/api/Dockerfile', 'apps/syncer/Dockerfile', 'apps/exporter/Dockerfile'];

describe('the Node version the API needs', () => {
  it('is declared by the workspace and by the API: Node 20.19 or later', () => {
    for (const manifest of ['package.json', 'apps/api/package.json']) {
      expect(JSON.parse(read(manifest)).engines).toEqual({ node: '>=20.19.0' });
    }
  });

  it.each(DOCKERFILES)('%s builds and runs on an explicitly pinned Node that has it', (dockerfile) => {
    const bases = [...read(dockerfile).matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    expect(bases).toHaveLength(2); // builder and runtime
    for (const base of bases) {
      const match = /^node:(\d+)\.(\d+)\.(\d+)-bookworm-slim$/.exec(base);
      expect(match).not.toBeNull(); // not a floating tag such as node:20-bookworm-slim
      expect(hasRequireEsm(Number(match![1]), Number(match![2]))).toBe(true);
    }
    expect(new Set(bases).size).toBe(1); // builder and runtime run the same Node
  });

  it('is the same base in the API, the syncer and the exporter image', () => {
    const base = (dockerfile: string) => /^FROM\s+(\S+)/m.exec(read(dockerfile))![1];
    expect(base('apps/syncer/Dockerfile')).toBe(base('apps/api/Dockerfile'));
    expect(base('apps/exporter/Dockerfile')).toBe(base('apps/api/Dockerfile'));
  });

  it('knows which Node versions have require(esm)', () => {
    expect([hasRequireEsm(20, 18), hasRequireEsm(20, 19), hasRequireEsm(20, 20)]).toEqual([false, true, true]);
    expect([hasRequireEsm(22, 11), hasRequireEsm(22, 12), hasRequireEsm(22, 23)]).toEqual([false, true, true]);
    expect([hasRequireEsm(18, 20), hasRequireEsm(24, 0)]).toEqual([false, true]);
  });
});
