// 회차별 임대의 두 줄(SweepLeases.acquire의 lane, docs/data.md §3 s:{event:E}:sweep·sesweep, docs/features/seat-hold.md §2 '정리 색인과 1초 반복', BUILD_ORDER PRF-138).
// 'expiry'(기본, 만료 반복 s:{event:E}:sweep)와 'session'(구매 세션 정리 반복 s:{event:E}:sesweep)은 다른 키라 서로 막지 않는다. 같은 줄 안의 규칙은 기존과 같다.
// 여기서는 메모리 구현(MemorySweepLeases)과, 가짜 HotRedis로 본 Redis 구현(RedisSweepLeases)이 어느 키를 쓰는지를 본다(실제 Valkey는 test-int/sweep-lease-lanes.int.test.ts).
import 'reflect-metadata';
import { fakeClock, type HotRedis } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemorySeatStore, MemorySweepLeases, RedisSweepLeases, type SweepLane, SWEEP_LEASE_TTL_MS, seatKeys, slotOf } from '../src/modules/inventory/index.js';
import { newEvent } from './hold-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const TTL = 3000;
const LANES: SweepLane[] = ['expiry', 'session', 'sale'];

function world() {
  const clock = fakeClock({ now: NOW, monotonic: 0 });
  const store = new MemorySeatStore(clock);
  const leases = new MemorySweepLeases(store.db, clock);
  return { clock, store, leases };
}

describe('MemorySweepLeases: 줄 둘은 서로 막지 않는다', () => {
  test('QT11_NFR025_ 같은 파드가 두 줄을 따로 잡고, 한 줄을 다른 파드가 잡고 있어도 다른 줄은 잡힌다', async () => {
    const { leases } = world();
    const e = newEvent();
    expect(await leases.acquire(e, 'pod-a', TTL, 'session')).toBe(true);
    expect(await leases.acquire(e, 'pod-a', TTL, 'expiry')).toBe(true);
    // 두 줄 모두 pod-a의 것이라 pod-b는 어느 줄도 못 잡는다
    expect(await leases.acquire(e, 'pod-b', TTL, 'session')).toBe(false);
    expect(await leases.acquire(e, 'pod-b', TTL, 'expiry')).toBe(false);
  });

  test('QT11_NFR025_ 정리 임대를 잡은 파드가 있어도 만료 임대는 다른 파드가 잡는다(그 반대도 같다)', async () => {
    const { leases } = world();
    const e = newEvent();
    expect(await leases.acquire(e, 'pod-a', TTL, 'session')).toBe(true);
    expect(await leases.acquire(e, 'pod-b', TTL, 'expiry')).toBe(true);
    // 각자 자기 줄을 늘리고, 남의 줄은 못 잡는다
    expect(await leases.acquire(e, 'pod-a', TTL, 'session')).toBe(true);
    expect(await leases.acquire(e, 'pod-b', TTL, 'expiry')).toBe(true);
    expect(await leases.acquire(e, 'pod-a', TTL, 'expiry')).toBe(false);
    expect(await leases.acquire(e, 'pod-b', TTL, 'session')).toBe(false);
  });

  test('QT11_NFR025_ 줄 인자가 없으면 expiry다: 인자 없이 잡은 임대는 session 줄을 막지 않고 expiry 줄을 막는다', async () => {
    const { leases } = world();
    const e = newEvent();
    expect(await leases.acquire(e, 'pod-a', TTL)).toBe(true);
    expect(await leases.acquire(e, 'pod-b', TTL, 'session')).toBe(true);
    expect(await leases.acquire(e, 'pod-b', TTL, 'expiry')).toBe(false);
    expect(await leases.acquire(e, 'pod-b', TTL)).toBe(false);
    expect(await leases.acquire(e, 'pod-a', TTL, 'expiry')).toBe(true);
  });

  test('ST25_ADR0122_ 판매 상태 판정 줄(sale)은 만료·정리 줄과 서로 막지 않는다: 한 파드가 다른 두 줄을 잡고 있어도 다른 파드가 잡고, 같은 줄은 못 잡는다 [ASVS v5.0.0-15.4.2]', async () => {
    const { leases } = world();
    const e = newEvent();
    expect(await leases.acquire(e, 'pod-a', TTL, 'expiry')).toBe(true);
    expect(await leases.acquire(e, 'pod-a', TTL, 'session')).toBe(true);
    expect(await leases.acquire(e, 'pod-b', TTL, 'sale')).toBe(true);
    expect(await leases.acquire(e, 'pod-a', TTL, 'sale')).toBe(false);
    expect(await leases.acquire(e, 'pod-b', TTL, 'expiry')).toBe(false);
    expect(await leases.acquire(e, 'pod-b', TTL, 'session')).toBe(false);
  });

  test('QT11_NFR025_ 줄은 회차마다 따로다: 한 회차의 정리 임대는 다른 회차의 정리 임대를 막지 않는다', async () => {
    const { leases } = world();
    const e1 = newEvent();
    const e2 = newEvent();
    expect(await leases.acquire(e1, 'pod-a', TTL, 'session')).toBe(true);
    expect(await leases.acquire(e2, 'pod-b', TTL, 'session')).toBe(true);
    expect(await leases.acquire(e2, 'pod-a', TTL, 'session')).toBe(false);
  });
});

describe.each(LANES)('MemorySweepLeases: %s 줄 안의 규칙(내 것이면 늘림, 비었거나 지났으면 잡음, 남의 것이면 거짓)', (lane) => {
  test(`QT11_NFR025_${lane}_ 비었으면 잡고, 내 것이면 수명을 지금부터 다시 건다(남은 시간이 아니라 지금 + 수명)`, async () => {
    const { clock, leases } = world();
    const e = newEvent();
    expect(await leases.acquire(e, 'pod-a', TTL, lane)).toBe(true);
    clock.advance(TTL - 1);
    expect(await leases.acquire(e, 'pod-a', TTL, lane)).toBe(true);
    // 처음 잡은 때로부터 3초가 지났지만 늘렸으므로 아직 pod-a의 것이다
    clock.advance(TTL - 1);
    expect(await leases.acquire(e, 'pod-b', TTL, lane)).toBe(false);
    clock.advance(1);
    expect(await leases.acquire(e, 'pod-b', TTL, lane)).toBe(true);
  });

  test(`QT11_NFR025_${lane}_ 남의 임대는 수명이 다하기 1ms 전까지 못 잡고, 다하는 순간(지금 ≥ 만료 시각) 잡는다. 못 잡은 시도는 남의 임대를 늘리지 않는다`, async () => {
    const { clock, leases } = world();
    const e = newEvent();
    expect(await leases.acquire(e, 'pod-a', TTL, lane)).toBe(true);
    clock.advance(TTL - 1);
    // 이 시도가 pod-a의 수명을 늘렸다면 아래에서 pod-b가 못 잡는다
    expect(await leases.acquire(e, 'pod-b', TTL, lane)).toBe(false);
    clock.advance(1);
    expect(await leases.acquire(e, 'pod-b', TTL, lane)).toBe(true);
    // 그 뒤로는 pod-a가 못 잡는다
    expect(await leases.acquire(e, 'pod-a', TTL, lane)).toBe(false);
  });

  test(`QT11_NFR025_${lane}_ 모양이 틀리면 RangeError이고 아무것도 잡지 않는다(회차·파드 ID가 키 조각 모양이 아님, 수명이 1 이상의 안전한 정수가 아님)`, async () => {
    const { leases } = world();
    const e = newEvent();
    await expect(leases.acquire('bad id', 'pod-a', TTL, lane)).rejects.toBeInstanceOf(RangeError);
    await expect(leases.acquire(e, 'pod:a', TTL, lane)).rejects.toBeInstanceOf(RangeError);
    await expect(leases.acquire(e, 'pod-a', 0, lane)).rejects.toBeInstanceOf(RangeError);
    await expect(leases.acquire(e, 'pod-a', 1.5, lane)).rejects.toBeInstanceOf(RangeError);
    // 잘못된 시도 뒤에도 비어 있어 다른 파드가 잡는다
    expect(await leases.acquire(e, 'pod-b', TTL, lane)).toBe(true);
  });
});

describe('RedisSweepLeases: 줄마다 다른 키 하나로 임대 Lua 한 번(가짜 HotRedis로 본 호출)', () => {
  /** evalScript만 받는 가짜: 받은 KEYS·ARGV를 적고 답을 정해 준 값으로 낸다. 일반 명령은 쓰면 안 된다 */
  function fake(answer: unknown = 1) {
    const evals: { keys: string[]; args: string[] }[] = [];
    let commands = 0;
    const redis = {
      evalScript: async (_script: unknown, keys: string[], args: string[]) => {
        evals.push({ keys: [...keys], args: [...args] });
        return answer;
      },
      command: async () => {
        commands += 1;
        return null;
      },
      sendCommand: async () => {
        commands += 1;
        return null;
      },
      close: async () => undefined,
    } as unknown as HotRedis;
    return { redis, evals, commands: () => commands };
  }

  test('QT11_NFR025_ session 줄은 s:{event:E}:sesweep, expiry 줄과 줄 인자가 없을 때는 s:{event:E}:sweep 하나만 KEYS로 넘기고, ARGV는 [파드 ID, 수명 글]이다. 일반 명령은 보내지 않는다', async () => {
    const f = fake(1);
    const leases = new RedisSweepLeases(f.redis);
    const e = newEvent();
    expect(await leases.acquire(e, 'pod-a', TTL, 'session')).toBe(true);
    expect(await leases.acquire(e, 'pod-a', TTL, 'expiry')).toBe(true);
    expect(await leases.acquire(e, 'pod-a', TTL)).toBe(true);
    expect(f.evals).toEqual([
      { keys: [`s:{event:${e}}:sesweep`], args: ['pod-a', '3000'] },
      { keys: [`s:{event:${e}}:sweep`], args: ['pod-a', '3000'] },
      { keys: [`s:{event:${e}}:sweep`], args: ['pod-a', '3000'] },
    ]);
    expect(f.commands()).toBe(0);
  });

  test('ST25_ADR0122_ sale 줄은 s:{event:E}:salesweep 하나만 KEYS로 넘기고, 키 이름 도우미(seatKeys.saleSweep)와 같으며 그 회차의 다른 키와 같은 슬롯이다', async () => {
    const f = fake(1);
    const e = newEvent();
    expect(await new RedisSweepLeases(f.redis).acquire(e, 'pod-a', TTL, 'sale')).toBe(true);
    expect(f.evals).toEqual([{ keys: [`s:{event:${e}}:salesweep`], args: ['pod-a', '3000'] }]);
    expect(f.commands()).toBe(0);
    expect(seatKeys.saleSweep(e)).toBe(`s:{event:${e}}:salesweep`);
    expect(slotOf(seatKeys.saleSweep(e))).toBe(slotOf(seatKeys.bitmap(e)));
  });

  test('QT11_NFR025_ 키 이름 도우미도 같다(seatKeys.sessionSweep·seatKeys.sweep). 두 키는 같은 회차 해시 태그라 같은 슬롯이다', () => {
    const e = newEvent();
    expect(seatKeys.sessionSweep(e)).toBe(`s:{event:${e}}:sesweep`);
    expect(seatKeys.sweep(e)).toBe(`s:{event:${e}}:sweep`);
    expect(slotOf(seatKeys.sessionSweep(e))).toBe(slotOf(seatKeys.sweep(e)));
    expect(slotOf(seatKeys.sessionSweep(e))).toBe(slotOf(seatKeys.sessions(e)));
    expect(slotOf(seatKeys.sessionSweep(e))).toBe(slotOf(seatKeys.stream(e)));
  });

  test('QT11_NFR025_ 임대 Lua의 답 0이면 줄과 관계없이 false이고, 모르는 답은 Error다', async () => {
    const e = newEvent();
    for (const lane of LANES) {
      expect(await new RedisSweepLeases(fake(0).redis).acquire(e, 'pod-a', TTL, lane)).toBe(false);
      await expect(new RedisSweepLeases(fake('2').redis).acquire(e, 'pod-a', TTL, lane)).rejects.toThrow(/모르는 값/);
    }
  });

  test('QT11_NFR025_ 모양이 틀리면 session 줄에서도 RangeError이고 Redis를 부르지 않는다', async () => {
    const f = fake(1);
    const leases = new RedisSweepLeases(f.redis);
    await expect(leases.acquire('bad id', 'pod-a', TTL, 'session')).rejects.toBeInstanceOf(RangeError);
    await expect(leases.acquire(newEvent(), 'pod:a', TTL, 'session')).rejects.toBeInstanceOf(RangeError);
    await expect(leases.acquire(newEvent(), 'pod-a', 0, 'session')).rejects.toBeInstanceOf(RangeError);
    expect(f.evals).toEqual([]);
    expect(f.commands()).toBe(0);
  });

  test('QT11_NFR025_ 정리 임대 수명 3초는 만료 임대와 같다(SWEEP_LEASE_TTL_MS)', () => {
    expect(SWEEP_LEASE_TTL_MS).toBe(TTL);
  });
});
