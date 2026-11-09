// RB-35 일꾼(ADR-0239 결정 8): 리더만 돌고, 전달된 묶음을 처리한다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { ApplyRb35, COMMANDER_KEYS_ENV, commanderKeysFromProcess, MemoryRb35Store, Rb35Worker } from '../src/modules/rb35/index.js';
import { bundleOf, CMD_ID, keysEnv, keysOf, NOW, operator, signedBy } from './rb35-support.js';

const a = operator('commander-a');
const b = operator('commander-b');
const E = 'evt-rb35';
const STOP = `${NOW - 1_000}:beacon`;

function setup(leader: boolean) {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryRb35Store(clock);
  store.setForTest(E, 'lobby', { stop: STOP, commit: 'a'.repeat(64), round: 8_000_000, published: false });
  store.setSchedule(E, { startsAtMs: NOW + 5 * 86_400_000, opensAtMs: NOW - 60_000 });
  const worker = new Rb35Worker({ store, apply: new ApplyRb35(store, keysOf(a, b), clock), isLeader: () => leader, listEvents: async () => [E], clock });
  return { store, worker };
}

describe('Rb35Worker', () => {
  test('Q-T27 리더가 전달 칸의 묶음을 적용한다', async () => {
    const { store, worker } = setup(true);
    const raw = JSON.stringify(signedBy(bundleOf({ params: { stop: STOP } }), a, b));
    await store.deposit(E, 'lobby', CMD_ID, raw);
    await worker.tickOnce();
    expect(store.pendingOf(E, 'lobby')).toBeUndefined();
    expect(store.stateOf(E, 'lobby').stop).toBeNull();
    expect(store.resultOf(E, CMD_ID)).toBe('applied');
  });

  test('Q-T27 리더가 아니면 아무것도 하지 않는다', async () => {
    const { store, worker } = setup(false);
    const raw = JSON.stringify(signedBy(bundleOf({ params: { stop: STOP } }), a, b));
    await store.deposit(E, 'lobby', CMD_ID, raw);
    await worker.tickOnce();
    expect(store.pendingOf(E, 'lobby')).toBe(raw);
    expect(store.stateOf(E, 'lobby').stop).toBe(STOP);
  });
});

describe('commanderKeysFromProcess', () => {
  test('운영에서 공개키 목록이 없으면 시작하지 않는다', () => {
    expect(() => commanderKeysFromProcess({ PEAKET_ENV: 'prod' })).toThrow(COMMANDER_KEYS_ENV);
    expect(() => commanderKeysFromProcess({})).toThrow(COMMANDER_KEYS_ENV);
    expect(() => commanderKeysFromProcess({ PEAKET_ENV: 'staging' })).toThrow(COMMANDER_KEYS_ENV);
  });

  test('[ASVS v5.0.0-11.6.1] 운영에서 commander가 두 명 미만이면 시작하지 않는다', () => {
    expect(() => commanderKeysFromProcess({ PEAKET_ENV: 'prod', [COMMANDER_KEYS_ENV]: keysEnv(a) })).toThrow(/두 명/);
    const c = operator('operator-c', 'operator');
    expect(() => commanderKeysFromProcess({ PEAKET_ENV: 'prod', [COMMANDER_KEYS_ENV]: keysEnv(a, c) })).toThrow(/두 명/);
  });

  test('local·ci·demo는 없어도 시작한다', () => {
    for (const env of ['local', 'ci', 'demo']) expect(commanderKeysFromProcess({ PEAKET_ENV: env })).toBeNull();
  });

  test('목록이 있으면 읽는다', () => {
    expect(commanderKeysFromProcess({ PEAKET_ENV: 'prod', [COMMANDER_KEYS_ENV]: keysEnv(a, b) })?.size).toBe(2);
  });
});
