import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * A self-signed certificate and its key for the local HTTPS servers of the tests, TEST ONLY: nothing in `src/` reads
 * them and the key protects nothing. The tests resolve the fake `.example` hosts to servers on 127.0.0.1 and hand this
 * certificate to `SafeFetcher` as its `ca`, so the connection is verified through Node's normal chain and identity
 * check (a wildcard such as `*.example` is refused by Node, so every host is listed in the SAN; a host that is not
 * listed fails with a TLS error, which a test relies on).
 *
 * Made once with OpenSSL (EC P-256, valid 10 years), run in `apps/syncer/test/support`:
 *
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
 *     -keyout tls/example.key -out tls/example.crt \
 *     -subj "/CN=gatehub-data-api test (self-signed, test only)" \
 *     -addext "subjectAltName=DNS:a.example,DNS:b.example,DNS:c.example,DNS:d.example,DNS:e.example,DNS:unl.example,DNS:northpeak.example,DNS:www.northpeak.example"
 *
 * A test that needs another host adds `DNS:<host>` to the list and runs the command again (both files change).
 */
export const TEST_TLS = {
  key: readFileSync(join(__dirname, 'tls', 'example.key'), 'utf8'),
  cert: readFileSync(join(__dirname, 'tls', 'example.crt'), 'utf8'),
};
