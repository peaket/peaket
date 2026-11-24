// F-02-3 freeze-guard 단위 시험(정본: docs/devops.md §8.1·§8.2, D-T3, OPS-320).
// 자동 중단은 진행 중 롤아웃만, 창의 범위 안에서만, 창의 자동 중단 시각부터 한다.
import { describe, expect, it } from 'vitest';
import { renderCalendar, parseSchedule, type FreezeCalendar } from '../src/calendar.js';
import { guardPlan, runGuardOnce, type RolloutView } from '../src/guard.js';

const E_LARGE = '0192f3a4-1111-7abc-8def-0123456789ab';
const E_SMALL = '0192f3a4-3333-7abc-8def-0123456789ab';
const OPENS = '2026-11-24T20:00:00+09:00';
const NOW = Date.parse('2026-11-24T09:00:00Z');
const schedule = (scale: 'large' | 'small', eventId = E_LARGE) =>
  parseSchedule(JSON.stringify({ revision: 1, generatedAt: '2026-11-24T08:55:00Z', onsales: [{ eventId, opensAt: OPENS, scale }] }));

const calendarOf = (scale: 'large' | 'small'): FreezeCalendar => renderCalendar(schedule(scale), NOW).calendar;
const rollout = (workload: string, name: string, phase: RolloutView['phase']): RolloutView => ({
  name,
  namespace: 'purchase',
  workload,
  phase,
});

describe('F-02-3 freeze-guard — D-T3 자동 중단', () => {
  it('D-T3 ① T-100분에 시작한 카나리가 T-45분에도 진행 중이면 중단하고 T-30분 점검의 진행 중 배포가 0이 된다', () => {
    const cal = calendarOf('large');
    const aborts = guardPlan(cal, [
      rollout('purchase-svc', 'purchase-svc-canary', 'Progressing'),
      rollout('queue-svc', 'queue-svc-paused', 'Paused'),
      rollout('ticket-svc', 'ticket-svc-healthy', 'Healthy'),
    ], Date.parse('2026-11-24T10:15:00Z'));
    expect(aborts.map((r) => r.name).sort()).toEqual(['purchase-svc-canary', 'queue-svc-paused']);
    // 대형은 hotpath가 아닌 ticket-svc도 대상이다(모든 운영 변경)
    expect(aborts.map((r) => r.workload)).toContain('purchase-svc');
    // 중단이 끝나면 롤아웃은 Aborted가 되고, T-30분 점검 때 진행 중 배포가 0건이 된다
    const after = guardPlan(cal, [
      rollout('purchase-svc', 'purchase-svc-canary', 'Aborted'),
      rollout('queue-svc', 'queue-svc-paused', 'Healthy'),
      rollout('ticket-svc', 'ticket-svc-healthy', 'Healthy'),
    ], Date.parse('2026-11-24T10:45:00Z'));
    expect(after).toEqual([]);
  });

  it('D-T3 ② 소형은 T-15분에 핫패스 롤아웃만 중단한다', () => {
    const cal = calendarOf('small');
    const before = guardPlan(cal, [rollout('queue-svc', 'q1', 'Progressing')], Date.parse('2026-11-24T10:44:59.999Z'));
    expect(before).toEqual([]);
    const at = guardPlan(cal, [
      rollout('queue-svc', 'q1', 'Progressing'),
      rollout('purchase-svc', 'p1', 'Paused'),
      rollout('ticket-svc', 't1', 'Progressing'),
      rollout('web', 'w1', 'Progressing'),
    ], Date.parse('2026-11-24T10:45:00Z'));
    expect(at.map((r) => r.name).sort()).toEqual(['p1', 'q1', 'w1']);
  });

  it('D-T3 ③ 이미 끝난 롤아웃·창 밖·중복 호출은 중단하지 않는다', () => {
    const cal = calendarOf('large');
    const at = Date.parse('2026-11-24T10:20:00Z');
    expect(guardPlan(cal, [rollout('purchase-svc', 'done', 'Aborted')], at)).toEqual([]);
    expect(guardPlan(cal, [rollout('purchase-svc', 'degraded', 'Degraded')], at)).toEqual([]);
    expect(guardPlan(cal, [rollout('purchase-svc', 'healthy', 'Healthy')], at)).toEqual([]);
    // 창 시작 전(T-90분 전)에도 아무것도 하지 않는다
    expect(guardPlan(cal, [rollout('purchase-svc', 'early', 'Progressing')], Date.parse('2026-11-24T09:29:59.999Z'))).toEqual([]);
    // 같은 실행에 같은 롤아웃이 두 번 들어와도 한 번만 중단한다
    const dup = guardPlan(cal, [rollout('purchase-svc', 'same', 'Progressing'), rollout('purchase-svc', 'same', 'Progressing')], at);
    expect(dup).toHaveLength(1);
  });

  it('F023-GUARD abortAt 정각은 중단하고 endsAt 정각은 중단하지 않는다', () => {
    const cal = calendarOf('large');
    const atAbort = Date.parse('2026-11-24T10:15:00.000Z');
    expect(guardPlan(cal, [rollout('queue-svc', 'q', 'Progressing')], atAbort)).toHaveLength(1);
    const atEnd = Date.parse('2026-11-24T12:00:00.000Z');
    expect(guardPlan(cal, [rollout('queue-svc', 'q', 'Progressing')], atEnd)).toEqual([]);
  });
});

describe('F-02-3 freeze-guard — 실행·장애', () => {
  const at = Date.parse('2026-11-24T10:20:00Z');

  it('D-T3 ③ 같은 롤아웃을 두 번 부르지 않고, 중단한 이름과 지표를 돌려준다', async () => {
    const calls: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const run = await runGuardOnce({
      now: () => at,
      calendar: { read: async () => calendarOf('large') },
      rollouts: { list: async () => [rollout('purchase-svc', 'a', 'Progressing'), rollout('queue-svc', 'b', 'Paused')] },
      aborter: { abort: async (r) => void calls.push(r.name) },
      log: (line) => void logs.push(line),
    });
    expect(run.result).toBe('aborted');
    expect([...run.aborted].sort()).toEqual(['a', 'b']);
    expect(calls.sort()).toEqual(['a', 'b']);
    expect(logs.filter((l) => l.event === 'freeze_rollout_aborted')).toHaveLength(2);
  });

  it('D-T3 ③ 창 밖이면 롤아웃 목록을 부르지 않고 끝낸다', async () => {
    let listed = 0;
    const run = await runGuardOnce({
      now: () => Date.parse('2026-11-24T13:00:00Z'),
      calendar: { read: async () => calendarOf('large') },
      rollouts: {
        list: async () => {
          listed += 1;
          return [];
        },
      },
      aborter: { abort: async () => {} },
    });
    expect(run.result).toBe('no-window');
    expect(listed).toBe(0);
  });

  it('F023-GUARD 목록·중단 실패는 종료 실패로 남기고 다른 롤아웃을 대신 건드리지 않는다', async () => {
    const run = await runGuardOnce({
      now: () => at,
      calendar: { read: async () => calendarOf('large') },
      rollouts: { list: async () => Promise.reject(new Error('argo down')) },
      aborter: { abort: async () => {} },
    });
    expect(run.result).toBe('failed');
    expect(run.aborted).toEqual([]);

    const attempted: string[] = [];
    const partial = await runGuardOnce({
      now: () => at,
      calendar: { read: async () => calendarOf('large') },
      rollouts: { list: async () => [rollout('purchase-svc', 'bad', 'Progressing'), rollout('queue-svc', 'good', 'Progressing')] },
      aborter: {
        abort: async (r) => {
          attempted.push(r.name);
          if (r.name === 'bad') throw new Error('patch failed');
        },
      },
    });
    expect(partial.result).toBe('failed');
    expect(attempted).toEqual(['bad', 'good']);
    expect(partial.aborted).toEqual(['good']);
  });
});
