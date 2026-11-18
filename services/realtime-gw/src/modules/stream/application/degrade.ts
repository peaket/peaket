// 파드의 전파 Degraded 판정(docs/features/seat-hold.md §7 '전파 Degraded Mode'의 '자동 전환의 첫 구현', ADR-0298 결정 1·2·6, BUILD_ORDER HOT-091).
// 보낸 묶음마다 '넘친 대기'(maxWaitMs − 그 묶음을 쌓기 시작할 때 그 연결의 묶음 간격, 0 아래는 0)를 받아
// 단조 시계의 10초 창마다 n(보낸 묶음 수)·a(넘친 대기 > 60ms)·b(> 30ms)를 센다.
// a × 100 > n인 창이 '넘음'(가장 가까운 순위의 p99 > 60ms), b × 100 ≤ n인 창이 '괜찮음'(p99 ≤ 30ms)이다. 빈 창은 넘음이 아니고 괜찮음이다.
// 평시에 넘음 창 18개(3분)가 이어지면 Degraded, Degraded에서 괜찮음 창 30개(5분)가 이어지면 평시로 되돌린다. 다른 창이 끼면 처음부터 센다.
// 바뀐 뒤의 창부터 새로 센다. 창은 판정기를 만든 때(단조 시계)부터 잰다. 타이머를 두지 않고 허브의 박자가 advance를 부른다.

/** 창 길이(ms, [가정] S-T12·K4) */
export const DEGRADE_WINDOW_MS = 10_000;
/** 넘친 대기가 이것을 넘으면 '넘음' 쪽으로 센다(ms, 망 한쪽 120·그리기 20 어림에서 나온 값, [가정]) */
export const DEGRADE_ENTER_EXCESS_MS = 60;
/** 넘친 대기가 이것을 넘으면 '괜찮음'을 깨는 쪽으로 센다(ms, [가정]) */
export const DEGRADE_EXIT_EXCESS_MS = 30;
/** Degraded로 바꾸는 이어진 넘음 창 수(10초 × 18 = 3분) */
export const DEGRADE_ENTER_WINDOWS = 18;
/** 평시로 되돌리는 이어진 괜찮음 창 수(10초 × 30 = 5분 [가정]) */
export const DEGRADE_EXIT_WINDOWS = 30;

/** 파드가 바뀐 일 하나(마지막 창의 n·a·b를 싣는다) */
export interface DegradedChange {
  degraded: boolean;
  batches: number;
  over60: number;
  over30: number;
}

export interface DegradeJudge {
  /** 지금 파드가 Degraded인가 */
  readonly degraded: boolean;
  /** 보낸 묶음 하나의 넘친 대기(ms, 0 아래는 0으로 본다)를 지금 창에 센다 */
  record(excessMs: number): void;
  /** monoMs까지 끝난 창을 모두 판정한다(박자 앞에서 부른다). 바뀐 일을 일어난 차례대로 돌려준다(대개 비었다) */
  advance(monoMs: number): DegradedChange[];
}

export function createDegradeJudge(startMonoMs: number): DegradeJudge {
  let degraded = false;
  let windowStart = startMonoMs;
  let n = 0;
  let a = 0;
  let b = 0;
  /** 평시의 이어진 넘음 창 수 */
  let overRun = 0;
  /** Degraded의 이어진 괜찮음 창 수 */
  let okRun = 0;

  /** 끝난 창 하나를 판정한다. 바뀌었으면 그 일을 돌려준다 */
  const close = (batches: number, over60: number, over30: number): DegradedChange | undefined => {
    if (!degraded) {
      // 넘음: a × 100 > n(빈 창은 0 > 0이 아니라 넘음이 아니다)
      overRun = over60 * 100 > batches ? overRun + 1 : 0;
      if (overRun < DEGRADE_ENTER_WINDOWS) return undefined;
    } else {
      // 괜찮음: b × 100 ≤ n(빈 창은 0 ≤ 0이라 괜찮음이다)
      okRun = over30 * 100 <= batches ? okRun + 1 : 0;
      if (okRun < DEGRADE_EXIT_WINDOWS) return undefined;
    }
    degraded = !degraded;
    // 바뀐 뒤의 창부터 새로 센다
    overRun = 0;
    okRun = 0;
    return { degraded, batches, over60, over30 };
  };

  return {
    get degraded() {
      return degraded;
    },
    record(excessMs) {
      n += 1;
      if (excessMs > DEGRADE_ENTER_EXCESS_MS) a += 1;
      if (excessMs > DEGRADE_EXIT_EXCESS_MS) b += 1;
    },
    advance(monoMs) {
      const changes: DegradedChange[] = [];
      if (!(monoMs - windowStart >= DEGRADE_WINDOW_MS)) return changes;
      // 지금까지 센 창을 닫는다
      const first = close(n, a, b);
      if (first) changes.push(first);
      n = 0;
      a = 0;
      b = 0;
      windowStart += DEGRADE_WINDOW_MS;
      // 박자가 멈췄던 동안 지난 창은 모두 빈 창이다. 빈 창이 DEGRADE_EXIT_WINDOWS개를 넘으면 상태가 더 바뀌지 않으므로(평시·넘음 0개) 거기까지만 돈다
      const empty = Math.floor((monoMs - windowStart) / DEGRADE_WINDOW_MS);
      const loop = Math.min(empty, DEGRADE_EXIT_WINDOWS + 1);
      for (let i = 0; i < loop; i += 1) {
        const c = close(0, 0, 0);
        if (c) changes.push(c);
      }
      windowStart += empty * DEGRADE_WINDOW_MS;
      return changes;
    },
  };
}
