// 시계(시간 의존 로직은 Clock 주입). 벽시계 now()는 절대 시각(밀리초)이고,
// 단조 시계 monotonicMs()는 시스템 시각을 고쳐도 뒤로 가지 않는 경과 시간용이다(남은 시간·지연 측정).
export interface Clock {
  /** 벽시계, 1970-01-01T00:00:00Z부터의 밀리초 */
  now(): number;
  /** 단조 시계, 밀리초(기준점은 뜻이 없고 차이만 쓴다) */
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonicMs: () => performance.now(),
};

/** Nest 주입 이름. createService가 전역으로 넣는다 */
export const CLOCK = Symbol.for('peaket.platform.clock');

export interface FakeClock extends Clock {
  /** 두 시계를 함께 ms만큼 앞으로 민다 */
  advance(ms: number): void;
}

/** 시험용 시계. 저절로 흐르지 않고 advance로만 간다 */
export function fakeClock(start: { now?: number; monotonic?: number } = {}): FakeClock {
  let wall = start.now ?? Date.parse('2026-11-01T00:00:00.000Z');
  let mono = start.monotonic ?? 0;
  return {
    now: () => wall,
    monotonicMs: () => mono,
    advance(ms: number) {
      if (!(ms >= 0)) throw new Error(`시계는 앞으로만 간다: ${ms}`);
      wall += ms;
      mono += ms;
    },
  };
}
