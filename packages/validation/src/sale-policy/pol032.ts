// POL-032 취소 공제율 상한(ADR-0261 결정 3): 관람일 10일 전까지 0%, 7~9일 10%, 3~6일 20%, 1~2일 30%, 당일 90%.
// daysLeft는 공연일까지 남은 달력일(공연장 현지, payment §4.1)이다.

/** 남은 날 하나의 상한(%) */
export function refundCap(daysLeft: number): number {
  if (daysLeft >= 10) return 0;
  if (daysLeft >= 7) return 10;
  if (daysLeft >= 3) return 20;
  if (daysLeft >= 1) return 30;
  return 90;
}

/** 구간 안 모든 날의 상한 가운데 가장 작은 값(구간은 0~365일이라 날마다 본다) */
export function bandCap(gte: number, lte: number): number {
  let cap = Number.POSITIVE_INFINITY;
  for (let d = gte; d <= lte; d++) cap = Math.min(cap, refundCap(d));
  return cap;
}
