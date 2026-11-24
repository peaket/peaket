// F-04-9 결정적 반올림 도우미. 정본: docs/features/forensic-replay.md §5.3.
// 정본이 허용한 Math 함수만 쓴다(Math.floor·Math.trunc 등). Math.round·Math.ceil은 쓰지 않는다.
// 값은 0 이상인 경우에만 쓴다(시각·개수·확률·표본 배율).

export function ceilPositive(value: number): number {
  const floor = Math.floor(value);
  return value === floor ? floor : floor + 1;
}

export function roundPositive(value: number): number {
  return Math.floor(value + 0.5);
}
