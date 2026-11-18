// 파드의 전파 Degraded 판정(docs/features/seat-hold.md §7 '전파 Degraded Mode'의 '자동 전환의 첫 구현', ADR-0298 결정 1·2·6, BUILD_ORDER HOT-091).
// 표본은 '박자 늦음'이다: 박자 안에서 보낸 묶음마다 보낸 단조 시각 − 그 박자의 예정 시각(지난 박자 시작 + 100ms, 0 아래는 0).
// 묶음 간격(100·1,000)과 상관없고 시계 차이가 들지 않는다. 무엇을 셀지(박자 밖 묶음·버퍼 1초 연결은 세지 않는다)는 허브가 정한다.
// 단조 시계의 10초 창마다 n(표본 수)·a(> 50ms)·b(> 25ms)와 박자 수를 센다.
// a × 100 > n인 창이 '넘음'(가장 가까운 순위의 p99 > 50ms), b × 100 ≤ n인 창이 '괜찮음'(p99 ≤ 25ms)이다.
// 박자는 돌았지만 표본이 없는 창은 넘음이 아니고 괜찮음이다. 박자가 한 번도 돌지 않은 채 지난 창은 넘음이다(루프가 멈춘 것이 가장 큰 늦음).
// 평시에 넘음 창 18개(3분)가 이어지면 Degraded, Degraded에서 괜찮음 창 30개(5분)가 이어지면 평시로 되돌린다. 다른 창이 끼면 처음부터 센다.
// 바뀐 뒤의 창부터 새로 센다. 창은 판정기를 만든 때(단조 시계)부터 잰다. 타이머를 두지 않고 허브의 박자가 tick을 부른다.

/** 창 길이(ms, [가정] S-T12·K4) */
export const DEGRADE_WINDOW_MS = 10_000;
/** 박자 늦음이 이것을 넘으면 '넘음' 쪽으로 센다(ms, 예산 300 − 묶음 100 − Lua 10 − 망 120 − 그리기 20, [가정]) */
export const DEGRADE_ENTER_LAG_MS = 50;
/** 박자 늦음이 이것을 넘으면 '괜찮음'을 깨는 쪽으로 센다(ms, [가정]) */
export const DEGRADE_EXIT_LAG_MS = 25;
/** Degraded로 바꾸는 이어진 넘음 창 수(10초 × 18 = 3분) */
export const DEGRADE_ENTER_WINDOWS = 18;
/** 평시로 되돌리는 이어진 괜찮음 창 수(10초 × 30 = 5분 [가정]) */
export const DEGRADE_EXIT_WINDOWS = 30;

/** 파드가 바뀐 일 하나(마지막 창의 n·a·b와 박자 수를 싣는다) */
export interface DegradedChange {
  degraded: boolean;
  /** 마지막 창의 표본 수 n */
  batches: number;
  /** 마지막 창에서 박자 늦음이 50ms를 넘은 수 a */
  overEnter: number;
  /** 마지막 창에서 박자 늦음이 25ms를 넘은 수 b */
  overExit: number;
  /** 마지막 창에서 돈 박자 수 */
  ticks: number;
}

export interface DegradeJudge {
  /** 지금 파드가 Degraded인가 */
  readonly degraded: boolean;
  /** 박자 안에서 보낸 묶음 하나의 박자 늦음(ms, 0 아래는 0으로 본다)을 지금 창에 센다 */
  record(lagMs: number): void;
  /**
   * 박자 하나가 돌았다(박자 앞에서 부른다). monoMs까지 끝난 창을 모두 판정한 뒤 이 박자를 새 창에 센다.
   * 바뀐 일을 일어난 차례대로 돌려준다(대개 비었다)
   */
  tick(monoMs: number): DegradedChange[];
}

export function createDegradeJudge(startMonoMs: number): DegradeJudge {
  let degraded = false;
  let windowStart = startMonoMs;
  let n = 0;
  let a = 0;
  let b = 0;
  let ticks = 0;
  /** 평시의 이어진 넘음 창 수 */
  let overRun = 0;
  /** Degraded의 이어진 괜찮음 창 수 */
  let okRun = 0;

  /** 끝난 창 하나를 판정한다. 바뀌었으면 그 일을 돌려준다 */
  const close = (w: { batches: number; overEnter: number; overExit: number; ticks: number }): DegradedChange | undefined => {
    const stalled = w.ticks === 0;
    if (!degraded) {
      // 넘음: 박자가 돌지 않았거나 a × 100 > n(박자는 돌고 표본이 없으면 0 > 0이 아니라 넘음이 아니다)
      overRun = stalled || w.overEnter * 100 > w.batches ? overRun + 1 : 0;
      if (overRun < DEGRADE_ENTER_WINDOWS) return undefined;
    } else {
      // 괜찮음: 박자가 돌았고 b × 100 ≤ n
      okRun = !stalled && w.overExit * 100 <= w.batches ? okRun + 1 : 0;
      if (okRun < DEGRADE_EXIT_WINDOWS) return undefined;
    }
    degraded = !degraded;
    // 바뀐 뒤의 창부터 새로 센다
    overRun = 0;
    okRun = 0;
    return { degraded, ...w };
  };

  return {
    get degraded() {
      return degraded;
    },
    record(lagMs) {
      n += 1;
      if (lagMs > DEGRADE_ENTER_LAG_MS) a += 1;
      if (lagMs > DEGRADE_EXIT_LAG_MS) b += 1;
    },
    tick(monoMs) {
      const changes: DegradedChange[] = [];
      if (monoMs - windowStart >= DEGRADE_WINDOW_MS) {
        // 지금까지 센 창을 닫는다
        const first = close({ batches: n, overEnter: a, overExit: b, ticks });
        if (first) changes.push(first);
        n = 0;
        a = 0;
        b = 0;
        ticks = 0;
        windowStart += DEGRADE_WINDOW_MS;
        // 박자가 멈췄던 동안 지난 창은 박자가 돌지 않은 창(넘음, 괜찮음 아님)이다.
        // 평시에서 DEGRADE_ENTER_WINDOWS개면 Degraded가 되고 그 뒤로는 바뀌지 않으므로 거기까지만 돈다
        const empty = Math.floor((monoMs - windowStart) / DEGRADE_WINDOW_MS);
        const loop = Math.min(empty, DEGRADE_ENTER_WINDOWS + 1);
        for (let i = 0; i < loop; i += 1) {
          const c = close({ batches: 0, overEnter: 0, overExit: 0, ticks: 0 });
          if (c) changes.push(c);
        }
        windowStart += empty * DEGRADE_WINDOW_MS;
      }
      ticks += 1;
      return changes;
    },
  };
}
