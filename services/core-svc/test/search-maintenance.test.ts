// 검색 읽기 모델 주기 일의 시작 따라잡기와 1분 정리 시각 창(리뷰 R165-1, ADR-0271 결정 12, 계획 docs/review/plans/BAT-165.md '### 13').
// 가짜 원천·가짜 시계. 서버가 뜰 때 따라잡기(reconcileAll)를 먼저 하고, 1분 정리의 시각 창은 따라잡기를 시작한 시각에서 이으며,
// 정리가 성공했을 때만 앞으로 옮긴다(실패하면 다음 정리가 같은 창부터 다시 본다).
import { fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { SearchReadModelTimers } from '../src/modules/catalog/application/search-maintenance.js';
import type { SearchReadModelSync } from '../src/modules/catalog/index.js';

const T0 = Date.parse('2026-11-16T00:00:00.000Z');
// 시험 값(정본 1분 [가정]과 다르게 고른 간격. 창은 시각으로만 본다)
const STEP = 47_000;

let timers: SearchReadModelTimers | undefined;
afterEach(() => timers?.stop());

function fakeSync() {
  const calls: { kind: string; at: number; since?: number }[] = [];
  const fail = { timed: false, purge: false, reconcile: false };
  // 따라잡기 결과(ran)와 마지막으로 끝난 따라잡기 시각(다른 파드가 마친 것까지 DB가 아는 값)
  const state = { ran: true, last: null as number | null };
  const sync: SearchReadModelSync = {
    sync: () => Promise.reject(new Error('부르지 않는다')),
    async syncTimed(at, since) {
      calls.push({ kind: 'timed', at: at.getTime(), since: since.getTime() });
      if (fail.timed) throw new Error('정리 실패');
      return { version: null, productions: 0 };
    },
    async recountInterest() {
      return 0;
    },
    async purgeRemovals(at) {
      calls.push({ kind: 'purge', at: at.getTime() });
      if (fail.purge) throw new Error('지운 표시 정리 실패');
      return 0;
    },
    async reconcileAll(at) {
      calls.push({ kind: 'reconcile', at: at.getTime() });
      if (fail.reconcile) throw new Error('따라잡기 실패');
      if (state.ran) state.last = at.getTime();
      return { ran: state.ran, productions: 0, version: null, chunks: 0 };
    },
    async lastReconciledAt() {
      calls.push({ kind: 'last', at: 0 });
      return state.last === null ? null : new Date(state.last);
    },
  };
  return { sync, calls, fail, state };
}

describe('검색 읽기 모델 주기 일', () => {
  test('HOT-270 1분 정리의 시각 창은 따라잡기 시작 시각에서 잇고, 정리가 실패하면 창을 앞으로 옮기지 않는다(R165-1)', async () => {
    const clock = fakeClock({ now: T0 });
    const f = fakeSync();
    timers = new SearchReadModelTimers({ sync: f.sync, clock });
    // 만든 뒤 시간이 지나고 나서 띄운다: 창의 시작은 만든 때가 아니라 따라잡기를 시작한 때다
    clock.advance(STEP);
    const started = T0 + STEP;
    await timers.start();
    expect(f.calls.filter((c) => c.kind === 'reconcile')).toEqual([{ kind: 'reconcile', at: started }]);

    clock.advance(STEP);
    await timers.tidy();
    expect(f.calls.filter((c) => c.kind === 'timed').map((c) => c.since)).toEqual([started]);
    const ok1 = T0 + 2 * STEP;

    // 정리 가운데 지운 표시 정리가 실패하면 창을 옮기지 않는다
    clock.advance(STEP);
    f.fail.purge = true;
    await expect(timers.tidy()).rejects.toThrow();
    f.fail.purge = false;
    // 동기화 자체가 실패해도 옮기지 않는다
    clock.advance(STEP);
    f.fail.timed = true;
    await expect(timers.tidy()).rejects.toThrow();
    f.fail.timed = false;
    // 다음 성공한 정리는 마지막 성공(ok1)부터 본다
    clock.advance(STEP);
    await timers.tidy();
    expect(f.calls.filter((c) => c.kind === 'timed').map((c) => c.since)).toEqual([started, ok1, ok1, ok1]);
  });

  test('HOT-270 따라잡기가 실패하면 1분 정리 주기마다 정리 앞에 다시 부르고, 마치거나 다른 파드가 마친 것을 보면 더 부르지 않는다(R165-14)', async () => {
    // 시험이 정한 모양: 1분 정리 한 번(tidy)이 주기 일이다. 따라잡기를 마치지 못했으면 정리 앞에 lastReconciledAt을 보고 다시 부른다
    const reconciles = (f: ReturnType<typeof fakeSync>) => f.calls.filter((c) => c.kind === 'reconcile').length;
    const firstOf = (f: ReturnType<typeof fakeSync>, kind: string) => f.calls.findIndex((c) => c.kind === kind);

    // 첫 따라잡기가 던지면 다음 주기에 1번(정리 앞), 성공 뒤 주기에는 0번
    {
      const clock = fakeClock({ now: T0 });
      const f = fakeSync();
      f.fail.reconcile = true;
      timers = new SearchReadModelTimers({ sync: f.sync, clock });
      await timers.start();
      expect(reconciles(f)).toBe(1);
      f.fail.reconcile = false;
      f.calls.length = 0;
      clock.advance(STEP);
      await timers.tidy();
      expect(reconciles(f)).toBe(1);
      expect(firstOf(f, 'reconcile')).toBeLessThan(firstOf(f, 'timed'));
      f.calls.length = 0;
      clock.advance(STEP);
      await timers.tidy();
      expect(reconciles(f)).toBe(0);
      timers.stop();
    }

    // 다른 파드가 따라잡기를 쥐고 있어 이 파드는 건너뛰었다(ran: false). 마친 시각이 이 파드 시작 시각 뒤·같음·앞일 때
    for (const [offset, expected] of [
      [1, 0],
      [0, 0],
      [-1, 1],
    ] as const) {
      const clock = fakeClock({ now: T0 });
      const f = fakeSync();
      f.state.ran = false;
      timers = new SearchReadModelTimers({ sync: f.sync, clock });
      clock.advance(STEP);
      const started = T0 + STEP;
      await timers.start();
      f.state.ran = true;
      f.state.last = started + offset;
      f.calls.length = 0;
      clock.advance(STEP);
      await timers.tidy();
      expect({ offset, reconciles: reconciles(f) }).toEqual({ offset, reconciles: expected });
      timers.stop();
    }
  });
});
