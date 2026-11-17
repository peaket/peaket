// 비밀 값 상수 시간 비교(W9-fix3 F2, docs/architecture.md §3.2 'REST' 행, asvs/settlement.md v5.0.0-11.2.4).
// 받은 값과 기대 값을 각각 SHA-256(utf8)으로 32바이트로 줄인 뒤 timingSafeEqual로 정확히 한 번 견준다.
// 길이가 달라도 일찍 끝내지 않으므로 응답 시간으로 기대 값의 길이를 알 수 없다. HTTP InternalTokenGuard와 내부 gRPC(토큰·처리자 증명)가 함께 쓴다.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** 받은 값과 기대 값을 SHA-256 뒤 timingSafeEqual로 한 번 견준다. 기대 값이 비면 false */
export function constantTimeEqual(given: string, expected: string): boolean {
  const same = timingSafeEqual(digest(given), digest(expected));
  // 기대 값이 빈 문자열이면 늘 거절한다(설정 빠짐을 '빈 토큰과 같음'으로 통과시키지 않는다). 비교는 그래도 한 번 해 시간을 같게 둔다
  return same && expected !== '';
}
