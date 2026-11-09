// drand 비콘 받기(ADR-0231 결정 11, Q-T27): 공시한 라운드만 여러 중계에서 차례로 받고, 검증에 실패한 값은 쓰지 않는다. 실제 drand를 부르지 않는다.
import { createHash } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { DRAND_CHAIN_HASH, drandRoundTimeMs } from '@peaket/shuffle';
import { describe, expect, test } from 'vitest';
import { type BeaconVerifier, DrandBeacon } from '../src/modules/batch/adapters/drand-beacon.js';
import { MemoryShuffleRecords } from '../src/modules/batch/adapters/memory-batch-store.js';

const E = 'evt-drand-1';
const ROUND = 1234;
const signature = 'aa'.repeat(48);
const randomness = createHash('sha256').update(Buffer.from(signature, 'hex')).digest('hex');
const accept: BeaconVerifier = { verify: () => true };
const url = (relay: string) => `${relay}/${DRAND_CHAIN_HASH}/public/${ROUND}`;

function world(responses: Record<string, unknown>, verifier: BeaconVerifier = accept) {
  const records = new MemoryShuffleRecords();
  records.setForTest(E, 'lobby', { commit: '00'.repeat(32), round: ROUND, sealed: 's', atMs: 1 });
  const seen: string[] = [];
  const http = {
    get: async (u: string) => {
      seen.push(u);
      const v = responses[u];
      if (v === undefined) throw new Error('연결 실패');
      if (v === 404) return { status: 404, body: null };
      return { status: 200, body: v };
    },
  };
  const beacon = new DrandBeacon({ relays: ['https://a.example', 'https://b.example'], records, verifier, http });
  return { beacon, seen };
}

describe('DrandBeacon', () => {
  test('Q-T27 중계 하나가 막혀도 다음 중계에서 공시 라운드 값을 받는다', async () => {
    const { beacon, seen } = world({ [url('https://b.example')]: { round: ROUND, randomness, signature } });
    expect((await beacon.value(E, 'lobby'))?.toString('hex')).toBe(randomness);
    expect(seen).toEqual([url('https://a.example'), url('https://b.example')]);
  });

  test('Q-T27 아직 없는 라운드(404)면 null을 주고 다른 라운드로 대신하지 않는다', async () => {
    const { beacon, seen } = world({ [url('https://a.example')]: 404, [url('https://b.example')]: 404 });
    expect(await beacon.value(E, 'lobby')).toBeNull();
    expect(seen.every((u) => u.endsWith(`/public/${ROUND}`))).toBe(true);
  });

  test('[ASVS v5.0.0-16.5.2] 검증이 실패한 값·라운드가 다른 값·SHA-256(서명)이 다른 값은 쓰지 않는다', async () => {
    const rejected = world({ [url('https://a.example')]: { round: ROUND, randomness, signature } }, { verify: () => false });
    expect(await rejected.beacon.value(E, 'lobby')).toBeNull();
    const wrongRound = world({ [url('https://a.example')]: { round: ROUND - 1, randomness, signature } });
    expect(await wrongRound.beacon.value(E, 'lobby')).toBeNull();
    const wrongHash = world({ [url('https://a.example')]: { round: ROUND, randomness: 'bb'.repeat(32), signature } });
    expect(await wrongHash.beacon.value(E, 'lobby')).toBeNull();
  });

  test('Q-T27 기록한 비콘: 서명 검증을 지나고 값이 SHA-256(서명)이면 믿는다', () => {
    const rounds: number[] = [];
    const { beacon } = world({}, { verify: (r) => (rounds.push(r), true) });
    expect(beacon.verifyStored(E, 'lobby', ROUND, randomness, signature)).toBe(true);
    expect(rounds).toEqual([ROUND]);
  });

  test('Q-T27 기록한 비콘: 값이 SHA-256(서명)과 다르거나 검증이 실패하면 믿지 않는다', () => {
    expect(world({}).beacon.verifyStored(E, 'lobby', ROUND, 'bb'.repeat(32), signature)).toBe(false);
    expect(world({}, { verify: () => false }).beacon.verifyStored(E, 'lobby', ROUND, randomness, signature)).toBe(false);
    expect(world({}).beacon.verifyStored(E, 'lobby', ROUND, 'not-hex', signature)).toBe(false);
  });

  test('공시 기록이 없으면 null이다', async () => {
    const records = new MemoryShuffleRecords();
    const beacon = new DrandBeacon({ relays: ['https://a.example'], records, verifier: accept, http: { get: async () => ({ status: 404, body: null }) } });
    expect(await beacon.value(E, 'lobby')).toBeNull();
  });

  test('Q-T27 라운드 예정 시각 전에는 중계를 부르지 않고, 구간마다 1초에 한 번만 부른다', async () => {
    const records = new MemoryShuffleRecords();
    records.setForTest(E, 'lobby', { commit: '00'.repeat(32), round: ROUND, sealed: 's', atMs: 1 });
    let calls = 0;
    const clock = fakeClock({ now: drandRoundTimeMs(ROUND) - 1 });
    const beacon = new DrandBeacon({ relays: ['https://a.example'], records, verifier: accept, clock, http: { get: async () => ((calls += 1), { status: 404, body: null }) } });
    expect(await beacon.round(E, 'lobby')).toBeNull();
    expect(calls).toBe(0);
    clock.advance(1);
    expect(await beacon.round(E, 'lobby')).toBeNull();
    expect(calls).toBe(1);
    clock.advance(999);
    expect(await beacon.round(E, 'lobby')).toBeNull();
    expect(calls).toBe(1);
    clock.advance(1);
    expect(await beacon.round(E, 'lobby')).toBeNull();
    expect(calls).toBe(2);
  });
});
