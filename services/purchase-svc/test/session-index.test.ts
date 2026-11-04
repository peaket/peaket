// 구매 세션 정리 색인 s:{event:E}:sessions와 종료 사건 더하기의 메모리 구현(RecordingSessionStartedLog: SessionStartedLog·SessionEndedLog·SessionIndex를 함께 구현)
// (docs/data.md §3, docs/features/seat-hold.md §2 '구매 세션 종료와 정리', BUILD_ORDER PRF-138). 실제 Valkey Lua는 test-int/session-index.int.test.ts가 같은 사례로 돈다.
import { describe, expect, test } from 'vitest';
import { RecordingSessionStartedLog, SESSION_IDLE_MS, sessionCheckAt } from '../src/modules/inventory/index.js';
import { endedEntry, type IndexHarness, newEvent, newMember, sessionIndexCases, startedEntry } from './session-index-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');

function memoryIndexHarness(): IndexHarness & { log: RecordingSessionStartedLog } {
  const log = new RecordingSessionStartedLog();
  return {
    log,
    started: log,
    ended: log,
    index: log,
    now: () => NOW,
    members: async (eventId) => new Map(log.index.get(eventId) ?? []),
    seed: async (eventId, jti, score) => {
      let m = log.index.get(eventId);
      if (!m) {
        m = new Map();
        log.index.set(eventId, m);
      }
      m.set(jti, score);
    },
    startedItems: async (eventId) => log.entries.filter((e) => e.eventId === eventId),
    endedItems: async (eventId) => log.endedEntries.filter((e) => e.eventId === eventId),
  };
}

describe('RecordingSessionStartedLog (정리 색인·종료 사건 계약 사례)', () => {
  sessionIndexCases(memoryIndexHarness);
});

describe('RecordingSessionStartedLog (시험 대역의 실패 주입)', () => {
  test('QT11_failWith를 두면 appendStarted가 그 오류로 실패하고 Stream 항목도 정리 색인도 더하지 않는다. 풀면 다시 더해진다', async () => {
    const h = memoryIndexHarness();
    const eventId = newEvent();
    const jti = newMember();
    const e = startedEntry(h, eventId, jti);
    const boom = new Error('boom');
    h.log.failWith = boom;
    await expect(h.log.appendStarted(e)).rejects.toBe(boom);
    expect(h.log.entries).toEqual([]);
    expect((await h.members(eventId)).size).toBe(0);
    h.log.failWith = undefined;
    await h.log.appendStarted(e);
    expect(h.log.entries).toEqual([e]);
    expect((await h.members(eventId)).get(jti)).toBe(sessionCheckAt(e.startedAtMs, e.maxStayUntilMs));
  });

  test('QT11_failEndedWith를 두면 appendEnded가 그 오류로 실패하고 종료 항목을 더하지 않으며 정리 색인에서 빼지도 않는다. 풀면 더해지고 빠진다', async () => {
    const h = memoryIndexHarness();
    const eventId = newEvent();
    const jti = newMember();
    await h.seed(eventId, jti, 1_000_000);
    const boom = new Error('boom');
    h.log.failEndedWith = boom;
    const e = endedEntry(h, eventId, jti, 'MAX_STAY');
    await expect(h.log.appendEnded(e)).rejects.toBe(boom);
    expect(h.log.endedEntries).toEqual([]);
    expect((await h.members(eventId)).get(jti)).toBe(1_000_000);
    // 시작 사건의 실패 주입은 종료에 영향을 주지 않는다
    h.log.failEndedWith = undefined;
    h.log.failWith = boom;
    await h.log.appendEnded(e);
    expect(h.log.endedEntries).toEqual([e]);
    expect((await h.members(eventId)).has(jti)).toBe(false);
  });

  test('POL009_첫 점검 시각의 점수는 시작 + 유휴 5분 또는 최대 체류 가운데 이른 쪽이다(색인의 점수 단위는 epoch 밀리초)', async () => {
    const h = memoryIndexHarness();
    const eventId = newEvent();
    const a = newMember();
    const b = newMember();
    await h.log.appendStarted(startedEntry(h, eventId, a));
    await h.log.appendStarted(startedEntry(h, eventId, b, { maxStayUntilMs: NOW + 90_000 }));
    expect(h.log.index.get(eventId)?.get(a)).toBe(NOW + SESSION_IDLE_MS);
    expect(h.log.index.get(eventId)?.get(b)).toBe(NOW + 90_000);
  });
});
