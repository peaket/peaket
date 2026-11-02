// 세션 유스케이스 단위 시험(메모리 저장소). 같은 묶음을 test-int에서 PostgreSQL 저장소로도 돌린다.
import { describe, expect, test } from 'vitest';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { type ActiveSession, sessionsOverDeviceLimit } from '../src/modules/session/domain/session.js';
import { sessionCases } from './session-cases.js';

sessionCases('메모리', async () => {
  const m = new MemorySessionStore();
  return {
    store: m,
    refreshHashOf: async (id) => m.peekSession(id)?.refreshHash ?? null,
    sessionCount: async (a) => m.activeCount(a),
    deviceRows: async (a) => m.deviceCount(a),
    loginVerdictOf: async (id) => m.peekSession(id)?.loginVerdict ?? null,
  };
});

describe('기기 한도 규칙(POL-019, identity §2)', () => {
  const s = (id: string, deviceId: string | null, idle: number): ActiveSession => ({ sessionId: id, deviceId, idleExpiresAt: idle });

  test('POL019_다섯대까지는_끝내지않는다', () => {
    expect(sessionsOverDeviceLimit([s('a', 'd1', 1), s('b', 'd2', 2), s('c', 'd3', 3), s('d', 'd4', 4)], 'd5')).toEqual([]);
    // 이미 있는 기기의 새 세션은 기기 수를 늘리지 않는다
    expect(sessionsOverDeviceLimit([s('a', 'd1', 1), s('b', 'd2', 2), s('c', 'd3', 3), s('d', 'd4', 4), s('e', 'd5', 5)], 'd3')).toEqual([]);
  });

  test('POL019_여섯대째면_마지막활동이가장이른기기의세션을모두끝낸다', () => {
    const active = [s('a1', 'd1', 50), s('a2', 'd1', 10), s('b', 'd2', 20), s('c', 'd3', 30), s('d', 'd4', 40), s('e', 'd5', 60)];
    // d1의 마지막 활동은 50(두 세션 가운데 늦은 쪽)이라 d2(20)가 가장 이르다
    expect(sessionsOverDeviceLimit(active, 'd6')).toEqual(['b']);
  });

  test('POL019_기기행이없는세션은_하나씩한대로센다', () => {
    const active = [s('a', null, 1), s('b', null, 2), s('c', 'd3', 3), s('d', 'd4', 4), s('e', 'd5', 5)];
    expect(sessionsOverDeviceLimit(active, null)).toEqual(['a']);
  });

  test('POL019_새세션의기기는_끝낼대상에서뺀다', () => {
    const active = [s('a', 'd1', 1), s('b', 'd2', 2), s('c', 'd3', 3), s('d', 'd4', 4), s('e', 'd5', 5), s('f', 'd6', 6)];
    // 이미 여섯 대(한도를 넘은 상태)에서 d1으로 다시 로그인: d1은 남기고 그다음 이른 d2를 끝낸다
    expect(sessionsOverDeviceLimit(active, 'd1')).toEqual(['b']);
  });
});
