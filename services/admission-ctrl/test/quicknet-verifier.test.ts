// drand quicknet 서명 검증(ADR-0239 결정 3, Q-T27). 값은 공개 drand API에서 받아 둔 실제 값이고, 시험에서 인터넷으로 나가지 않는다.
import { createHash } from 'node:crypto';
import { DRAND_CHAIN_HASH, DRAND_GENESIS_MS, DRAND_PERIOD_MS } from '@peaket/shuffle';
import { describe, expect, test } from 'vitest';
import { DrandBeacon } from '../src/modules/batch/adapters/drand-beacon.js';
import { MemoryShuffleRecords } from '../src/modules/batch/adapters/memory-batch-store.js';
import { QUICKNET_PUBLIC_KEY, QUICKNET_SCHEME, QuicknetBeaconVerifier } from '../src/modules/batch/adapters/quicknet-verifier.js';

const PUBLIC = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';
const R1000 = { round: 1000, randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd', signature: 'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39' };
const R2M = { round: 2000000, randomness: '3fcc32da81d3de7243f1b702a3a502a3118e0492e19e39e30f3da36be1eef788', signature: 'a7c94d62fa50475c65f259bc4d50afc0cebc5cb29848568f90dff842789c05d7f6b2414971a0b67bf532624ad6bab054' };
const v = new QuicknetBeaconVerifier();

describe('QuicknetBeaconVerifier', () => {
  test('[ASVS v5.0.0-11.2.1] 공개키와 체인 값은 코드에 고정한 quicknet이다', () => {
    expect(QUICKNET_PUBLIC_KEY).toBe(PUBLIC);
    expect(QUICKNET_SCHEME).toBe('bls-unchained-g1-rfc9380');
    expect(DRAND_CHAIN_HASH).toBe('52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971');
    expect([DRAND_GENESIS_MS, DRAND_PERIOD_MS]).toEqual([1692803367_000, 3_000]);
  });

  test('[ASVS v5.0.0-11.6.1] Q-T27 실제 drand 라운드 1000·2000000의 서명을 맞다고 본다', () => {
    expect(v.verify(R1000.round, R1000.signature)).toBe(true);
    expect(v.verify(R2M.round, R2M.signature)).toBe(true);
  });

  test('Q-T27 라운드 값은 서명의 SHA-256이다', () => {
    for (const r of [R1000, R2M]) expect(createHash('sha256').update(Buffer.from(r.signature, 'hex')).digest('hex')).toBe(r.randomness);
  });

  test('[ASVS v5.0.0-11.6.1] Q-T27 라운드 번호를 바꾸거나 서명 한 바이트를 바꾸면 false다', () => {
    expect(v.verify(R1000.round + 1, R1000.signature)).toBe(false);
    expect(v.verify(R2M.round, R1000.signature)).toBe(false);
    const flip = (hex: string, at: number) => hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);
    expect(v.verify(R1000.round, flip(R1000.signature, 60))).toBe(false);
    expect(v.verify(R1000.round, flip(R1000.signature, 94))).toBe(false);
  });

  test.each([
    ['빈 값', ''],
    ['짧은 길이', 'ab'.repeat(47)],
    ['긴 길이', 'ab'.repeat(49)],
    ['16진수가 아님', 'zz'.repeat(48)],
    ['대문자', R1000.signature.toUpperCase()],
    ['곡선 밖의 점', 'ff'.repeat(48)],
    ['모두 0', '00'.repeat(48)],
  ])('[ASVS v5.0.0-16.5.2] 나쁜 입력(%s)은 예외 없이 false다', (_n, sig) => {
    expect(v.verify(R1000.round, sig)).toBe(false);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, Number.MAX_VALUE])('Q-T27 라운드가 범위를 벗어나면(%s) false다', (round) => {
    expect(v.verify(round, R1000.signature)).toBe(false);
  });

  test('Q-T27 라운드 상한(2^53 − 1)도 예외 없이 끝난다', () => {
    expect(v.verify(Number.MAX_SAFE_INTEGER, R1000.signature)).toBe(false);
  });

  test('[ASVS v5.0.0-16.5.2] Q-T27 어댑터는 실제 서명을 받아들이고 틀린 서명은 다음 중계로 넘어간다', async () => {
    const records = new MemoryShuffleRecords();
    records.setForTest('e', 'lobby', { commit: '00'.repeat(32), round: R1000.round, sealed: 's', atMs: 1 });
    const http = (bad: boolean) => ({ get: async () => ({ status: 200, body: { round: R1000.round, randomness: R1000.randomness, signature: bad ? R2M.signature : R1000.signature } }) });
    const good = new DrandBeacon({ relays: ['https://a.example'], records, verifier: v, http: http(false) });
    expect((await good.round('e', 'lobby'))?.signature).toBe(R1000.signature);
    const bad = new DrandBeacon({ relays: ['https://a.example'], records, verifier: v, http: http(true) });
    expect(await bad.round('e', 'lobby')).toBeNull();
  });
});
