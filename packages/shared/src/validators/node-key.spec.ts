import { readFileSync } from 'fs';
import { join } from 'path';
import { encodeAccountPublic, encodeNodePublic } from 'ripple-address-codec';
import { isNodePublicKey, nodePublicKeyFromHex, nodePublicKeyToHex } from './node-key';

const UNL_DIR = join(__dirname, '..', '..', 'test', 'fixtures');
const LISTS = ['xrpl/unl/vl.ripple.com.json', 'xrpl/unl/unl.xrplf.org.json', 'xahau/unl/vl.xahau.org.json'];

/** The master keys (66 upper hex digits) of every validator in the recorded lists, and the publishers' keys. */
function recordedKeys(): string[] {
  return LISTS.flatMap((file) => {
    const list = JSON.parse(readFileSync(join(UNL_DIR, file), 'utf8')) as { public_key: string; blob: string };
    const blob = JSON.parse(Buffer.from(list.blob, 'base64').toString('utf8')) as {
      validators: { validation_public_key: string }[];
    };
    return [list.public_key, ...blob.validators.map((v) => v.validation_public_key)];
  });
}

describe('node public keys', () => {
  const keys = recordedKeys();

  it('reads the recorded keys: 35 + 35 + 19 validators and 3 publishers', () => {
    expect(keys).toHaveLength(35 + 35 + 19 + 3);
    expect(new Set(keys.map((key) => key.slice(0, 2)))).toEqual(new Set(['ED']));
  });

  it('turns the hex of each recorded key into base58 and back', () => {
    for (const hex of keys) {
      const base58 = nodePublicKeyFromHex(hex);
      expect(base58).toMatch(/^n[1-9A-HJ-NP-Za-km-z]{51}$/);
      expect(nodePublicKeyToHex(base58 as string)).toBe(hex);
      expect(isNodePublicKey(base58 as string)).toBe(true);
    }
  });

  it('knows the base58 of a published master key', () => {
    // The publisher key of the recorded vl.ripple.com list; the base58 form is what the codec makes of it.
    expect(nodePublicKeyFromHex('ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734')).toBe(
      'nHBe4vqSAzjpPRLKwSFzRFtmvzXaf5wPPmuVrQCAoJoS1zskgDA4',
    );
  });

  describe('nodePublicKeyFromHex', () => {
    const ed = 'ED' + 'AB'.repeat(32);

    it('takes any case and answers the same base58', () => {
      expect(nodePublicKeyFromHex(ed.toLowerCase())).toBe(nodePublicKeyFromHex(ed));
      expect(nodePublicKeyFromHex(ed)).toBe(encodeNodePublic(Buffer.from(ed, 'hex')));
    });

    it('accepts the three key types 02, 03 and ED', () => {
      for (const prefix of ['02', '03', 'ED', 'ed']) {
        expect(nodePublicKeyFromHex(prefix + '11'.repeat(32))).toBeDefined();
      }
    });

    it('refuses what is not 33 bytes of hex starting 02, 03 or ED', () => {
      expect(nodePublicKeyFromHex('')).toBeUndefined();
      expect(nodePublicKeyFromHex(ed.slice(0, 64))).toBeUndefined(); // 32 bytes
      expect(nodePublicKeyFromHex(ed + '00')).toBeUndefined(); // 34 bytes
      expect(nodePublicKeyFromHex(ed.slice(0, 65))).toBeUndefined(); // odd length
      expect(nodePublicKeyFromHex('ED' + 'ZZ'.repeat(32))).toBeUndefined();
      expect(nodePublicKeyFromHex('04' + '11'.repeat(32))).toBeUndefined();
      expect(nodePublicKeyFromHex('00' + '11'.repeat(32))).toBeUndefined();
      expect(nodePublicKeyFromHex(' ' + ed)).toBeUndefined();
    });
  });

  describe('nodePublicKeyToHex', () => {
    it('answers upper-case hex', () => {
      const hex = nodePublicKeyToHex('nHBe4vqSAzjpPRLKwSFzRFtmvzXaf5wPPmuVrQCAoJoS1zskgDA4');
      expect(hex).toBe('ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734');
    });

    it('throws on text that is not a node public key', () => {
      expect(() => nodePublicKeyToHex('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).toThrow();
      expect(() => nodePublicKeyToHex('summary')).toThrow();
    });
  });

  describe('isNodePublicKey', () => {
    it('is true for master (nH...) and signing (n9...) keys of the three types', () => {
      expect(isNodePublicKey('nHBe4vqSAzjpPRLKwSFzRFtmvzXaf5wPPmuVrQCAoJoS1zskgDA4')).toBe(true);
      for (const prefix of ['02', '03', 'ED']) {
        const base58 = encodeNodePublic(Buffer.from(prefix + '5A'.repeat(32), 'hex'));
        expect(isNodePublicKey(base58)).toBe(true);
      }
    });

    it('is false for a classic address, a truncated key, a word and the empty text', () => {
      expect(isNodePublicKey('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).toBe(false);
      expect(isNodePublicKey('nHBe4vqSAzjpPRLKwSFzRFtmvzXaf5wPPmuVrQCAoJoS1zskgDA')).toBe(false);
      expect(isNodePublicKey('summary')).toBe(false);
      expect(isNodePublicKey('')).toBe(false);
    });

    it('is false for a key with a broken checksum', () => {
      const good = 'nHBe4vqSAzjpPRLKwSFzRFtmvzXaf5wPPmuVrQCAoJoS1zskgDA4';
      expect(isNodePublicKey(good.slice(0, -1) + (good.endsWith('4') ? '5' : '4'))).toBe(false);
    });

    it('is false for an account public key and for a 33-byte key of an unknown type', () => {
      expect(isNodePublicKey(encodeAccountPublic(Buffer.from('ED' + '5A'.repeat(32), 'hex')))).toBe(false);
      expect(isNodePublicKey(encodeNodePublic(Buffer.from('04' + '5A'.repeat(32), 'hex')))).toBe(false);
    });
  });
});
