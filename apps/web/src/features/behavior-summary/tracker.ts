// 행동 신호 요약(openapi BehaviorSummary v1, docs/features/bot-defense.md §4.1, ADR-0065 결정 9, ADR-0249 결정 7).
// 수·간격·방향 엔트로피만 잰다. 원시 좌표·키 값·입력한 글자·어느 좌석 위를 지났는지는 남기지 않는다. 공연 상세·좌석 화면이 함께 쓴다.

/** openapi BehaviorSummary v1 */
export interface BehaviorSummary {
  v: 1;
  windowMs: number;
  pointerMoves: number;
  pointerEntropy: number;
  inputIntervalMeanMs?: number;
  inputIntervalStdMs?: number;
  scrollEvents: number;
  scrollDistancePx: number;
}

export interface BehaviorTracker {
  move(x: number, y: number): void;
  input(): void;
  scroll(dy: number): void;
  summary(): BehaviorSummary;
}

const MAX_WINDOW_MS = 3_600_000;
/** 계약의 최댓값 [가정](openapi BehaviorSummary). 넘지 않게 멈춘다 */
const MAX_COUNT = 1_000_000;
const MAX_SCROLL_PX = 1_000_000_000;
const KEEP_INTERVALS = 200;

/** 화면이 열린 동안의 행동 신호를 센다. 원시 값은 마지막 점 하나와 간격 200개 [가정]만 메모리에 둔다 */
export function createBehaviorTracker(now: () => number): BehaviorTracker {
  const start = now();
  let moves = 0;
  const dirs = new Array<number>(8).fill(0);
  let last: [number, number] | null = null;
  const intervals: number[] = [];
  let lastInput: number | null = null;
  let scrolls = 0;
  let scrollPx = 0;
  // 1시간(계약 windowMs 상한)이 지나면 더 세지 않는다(구간 길이와 수가 어긋나지 않게)
  const open = () => now() - start <= MAX_WINDOW_MS;
  return {
    move(x: number, y: number) {
      if (!open()) return;
      moves = Math.min(moves + 1, MAX_COUNT);
      if (last) {
        const dx = x - last[0];
        const dy = y - last[1];
        if (dx !== 0 || dy !== 0) dirs[(((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8)]!++;
      }
      last = [x, y];
    },
    input() {
      if (!open()) return;
      const t = now();
      if (lastInput !== null) {
        intervals.push(t - lastInput);
        if (intervals.length > KEEP_INTERVALS) intervals.shift();
      }
      lastInput = t;
    },
    scroll(dy: number) {
      if (!open()) return;
      scrolls = Math.min(scrolls + 1, MAX_COUNT);
      scrollPx = Math.min(scrollPx + Math.abs(Math.round(dy)), MAX_SCROLL_PX);
    },
    summary(): BehaviorSummary {
      const total = dirs.reduce((a, b) => a + b, 0);
      let entropy = 0;
      for (const c of dirs) if (c > 0) entropy -= (c / total) * Math.log2(c / total);
      const s: BehaviorSummary = {
        v: 1,
        // 단조 시계는 소수라 정수로 내린다(계약 windowMs는 정수)
        windowMs: Math.min(Math.max(0, Math.floor(now() - start)), MAX_WINDOW_MS),
        pointerMoves: moves,
        pointerEntropy: Math.round(entropy * 1000) / 1000,
        scrollEvents: scrolls,
        scrollDistancePx: scrollPx,
      };
      if (intervals.length > 0) {
        const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
        s.inputIntervalMeanMs = Math.round(mean * 10) / 10;
        s.inputIntervalStdMs = Math.round(Math.sqrt(variance) * 10) / 10;
      }
      return s;
    },
  };
}

/** 창에서 추적기가 듣는 대상의 모양(시험은 이벤트 대상 하나로 흉내 낸다) */
export type BehaviorTarget = Pick<Window, 'scrollY' | 'addEventListener' | 'removeEventListener'>;

/** 창의 입력을 추적기에 잇고, 끄는 함수를 돌려준다. 키를 누르고 있을 때의 자동 반복은 입력 간격에 넣지 않는다 */
export function listenBehavior(target: BehaviorTarget, t: BehaviorTracker): () => void {
  let lastY = target.scrollY;
  const move = (e: PointerEvent) => t.move(e.clientX, e.clientY);
  const tap = () => t.input();
  const key = (e: KeyboardEvent) => {
    if (!e.repeat) t.input();
  };
  const scroll = () => {
    t.scroll(target.scrollY - lastY);
    lastY = target.scrollY;
  };
  target.addEventListener('pointermove', move, { passive: true });
  target.addEventListener('pointerdown', tap, { passive: true });
  target.addEventListener('keydown', key);
  target.addEventListener('scroll', scroll, { passive: true });
  return () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerdown', tap);
    target.removeEventListener('keydown', key);
    target.removeEventListener('scroll', scroll);
  };
}
