// 시각은 KST(Asia/Seoul) 고정으로 쓴다. 토스페이먼츠 응답과 같은 ISO 8601 + `+09:00` 모양이다.
const KST_OFFSET_MS = 9 * 3_600_000;

export function kstIso(ms: number): string {
  return `${new Date(ms + KST_OFFSET_MS).toISOString().slice(0, -1)}+09:00`;
}

export interface SimClock {
  /** 벽시계, 1970-01-01T00:00:00Z부터의 밀리초 */
  now(): number;
}

export const systemClock: SimClock = { now: () => Date.now() };
