// 규칙 다시 읽기와 준비 상태(docs/features/bot-defense.md §4.4): 처음에 못 읽으면 5초마다 재시도하고, 읽어야 준비 상태가 된다. 시작 파일 main.ts가 이 함수를 쓴다.
import { describe, expect, test } from 'vitest';
import { RULES_REFRESH_MS, RULES_RETRY_MS, startRuleRefresh } from '../src/modules/scoring/adapters/rule-refresh.js';

function harness(results: boolean[]) {
  const timers: { fn: () => void; ms: number }[] = [];
  const ready = { registered: [] as string[], done: [] as string[], register: (t: string) => void ready.registered.push(t), complete: (t: string) => void ready.done.push(t) };
  const refresh = async () => results.shift() ?? false;
  const loop = startRuleRefresh({ rules: { refresh }, readiness: ready, task: 'trust-rules', setTimer: (fn, ms) => void timers.push({ fn, ms }) });
  return { timers, ready, loop };
}

describe('startRuleRefresh', () => {
  test('낮음시험빈틈_처음읽기전에는준비상태가아니고_5초뒤다시읽는다', async () => {
    const h = harness([false, false, true]);
    await h.loop.first;
    expect(h.ready.registered).toEqual(['trust-rules']);
    expect(h.ready.done).toEqual([]);
    expect(h.timers.at(-1)!.ms).toBe(RULES_RETRY_MS);
    h.timers.at(-1)!.fn();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(h.ready.done).toEqual([]);
    expect(h.timers.at(-1)!.ms).toBe(RULES_RETRY_MS);
  });

  test('낮음시험빈틈_읽으면준비상태가되고_5분뒤다시읽는다', async () => {
    const h = harness([true]);
    await h.loop.first;
    expect(h.ready.done).toEqual(['trust-rules']);
    expect(h.timers.at(-1)!.ms).toBe(RULES_REFRESH_MS);
  });

  test('낮음시험빈틈_한번읽은뒤다시읽기가실패해도준비상태는그대로다', async () => {
    const h = harness([true, false]);
    await h.loop.first;
    h.timers.at(-1)!.fn();
    await new Promise((r) => setImmediate(r));
    expect(h.ready.done).toEqual(['trust-rules']);
    expect(h.timers.at(-1)!.ms).toBe(RULES_REFRESH_MS);
  });

  test('값은정본과같다', () => {
    expect([RULES_RETRY_MS, RULES_REFRESH_MS]).toEqual([5_000, 300_000]);
  });
});
