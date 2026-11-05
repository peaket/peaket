// 초 단위 시계와 낭독(CMP-014 Countdown, CMP-015·016 낭독 규칙, FE-T42).
// requestAnimationFrame을 쓰지 않고 다음 초 경계까지 setTimeout으로 기다린다. 깰 때마다 시계로 남은 시간을 다시 계산하고,
// 화면이 다시 보이면 바로 맞춘다(d2 CMP-014, docs/frontend.md §4.8). 시계는 상태 기계와 같은 바탕(live/steady.ts)이고,
// 상태 기계가 화면 값의 마감 시각을 그 바탕으로 낸다(보정 시계 − 보정값, ADR-0208 결정 10).
import { steadyNow } from '../live/steady.ts';

export interface TimerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  /** 화면이 다시 보이면 부른다. 돌려준 함수로 끊는다 */
  onVisible(cb: () => void): () => void;
}

const browserDeps = (): TimerDeps => ({
  now: steadyNow,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id as number),
  onVisible: (cb) => {
    const f = (): void => {
      if (document.visibilityState === 'visible') cb();
    };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  },
});

/** 마감 시각(ms, deps.now 바탕)까지 남은 초를 매초 알린다. 0이 되면 onDone. 정리 함수를 돌려준다 */
export function countdown(deadlineMs: number, onTick: (remainingSec: number) => void, onDone?: () => void, deps: TimerDeps = browserDeps()): () => void {
  let timer: unknown = null;
  let done = false;
  const tick = (): void => {
    timer = null;
    const remainingMs = deadlineMs - deps.now();
    const sec = Math.max(0, Math.ceil(remainingMs / 1000));
    onTick(sec);
    if (sec <= 0) {
      if (!done) {
        done = true;
        onDone?.();
      }
      return;
    }
    // 다음 초 경계(남은 ms가 1000의 배수가 되는 때)까지 기다린다
    const wait = remainingMs % 1000 || 1000;
    timer = deps.setTimer(tick, wait + 5);
  };
  const stopVisible = deps.onVisible(() => {
    if (done) return;
    if (timer !== null) deps.clearTimer(timer);
    tick();
  });
  tick();
  return () => {
    if (timer !== null) deps.clearTimer(timer);
    stopVisible();
  };
}

/**
 * 이정표형 낭독: 남은 5분·1분·10초를 지날 때 한 번씩만 live 영역에 문장을 넣는다(d1 §5, 기술 검토 낮음-102).
 * 늦게 깨 이정표 초를 건너뛰어도 2초 안이면 읽고, 숨긴 동안 더 많이 지나쳤으면 틀린 남은 시간을 읽지 않게 조용히 넘긴다
 */
export function milestoneAnnouncer(region: { textContent: string | null }, label: string): (remainingSec: number) => void {
  const marks: [number, string][] = [
    [300, '5분'],
    [60, '1분'],
    [10, '10초'],
  ];
  const passed = new Set<number>();
  let prev: number | null = null;
  return (sec) => {
    for (const [at, text] of marks) {
      if (passed.has(at) || sec > at) continue;
      passed.add(at);
      const crossedNow = (prev === null || prev > at) && at - sec <= 2;
      if (crossedNow) region.textContent = `${label} ${text} 남았습니다`;
    }
    prev = sec;
  };
}

/** 1분에 한 번 같은 문장을 live 영역에 다시 넣어 낭독한다(대기열, ADR-0063). 숫자 자체에는 live를 두지 않는다 */
export function announceEveryMinute(region: HTMLElement, sentence: () => string): () => void {
  const id = window.setInterval(() => {
    region.textContent = '';
    window.setTimeout(() => {
      region.textContent = sentence();
    }, 100);
  }, 60_000);
  return () => window.clearInterval(id);
}
