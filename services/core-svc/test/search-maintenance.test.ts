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
  const fail = { timed: false, purge: false };
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
      return { ran: true, productions: 0, version: null };
    },
  };
  return { sync, calls, fail };
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
});
