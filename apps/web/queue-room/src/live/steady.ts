// 보정 시계의 바탕(docs/frontend.md §3.3, ADR-0110): 페이지를 연 때의 기기 시각 + 그 뒤 단조 시계(performance.now)로 잰 경과.
// 상태 기계의 '이 기기 시계'와 화면 카운트다운이 같은 값을 써서, 페이지를 연 뒤 기기 시계가 바뀌어도 기다림·남은 초가 흔들리지 않는다.

export function createSteady(wall: () => number, mono: () => number): () => number {
  const wall0 = wall();
  const mono0 = mono();
  return () => wall0 + (mono() - mono0);
}

/** 브라우저의 기본 바탕(대기실 한 페이지에 하나) */
export const steadyNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? createSteady(Date.now, () => performance.now()) : Date.now;
