// 비밀 값 상수 시간 비교(W9-fix3 F2, docs/architecture.md §3.2 'REST' 행, asvs/settlement.md v5.0.0-11.2.4).
// 시험 담당이 컴파일에 필요한 빈 뼈대만 두었다(동작 없음). 구현 담당이 채운다.

/** 받은 값과 기대 값을 SHA-256 뒤 timingSafeEqual로 한 번 견준다. 기대 값이 비면 false */
export function constantTimeEqual(_given: string, _expected: string): boolean {
  return false;
}
