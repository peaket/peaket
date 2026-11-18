// CS 처리함 건(asyncapi CaseRequested)의 eventKey 만들기(transfer-refund §3.1 ②·§5 '그래도 남는 건', BAT-420 리뷰 D2).
// `${접두어}:${취소 ID}`의 SHA-256 앞 16바이트를 8-4-4-4-12 UUID 꼴로 쓴다. 같은 취소·같은 종류는 늘 같은 키라 ops가 한 건으로 모으고,
// 접두어가 다르면(이상 표시 entry-after-cancel·차액 deduction-gap) 같은 취소라도 다른 건이다.
import { createHash } from 'node:crypto';

/** refund-account: CS '환불 대기'(REFUND_ACCOUNT_PENDING, BUILD_ORDER GAT-090) */
export type CaseEventKeyPrefix = 'entry-after-cancel' | 'deduction-gap' | 'refund-account';

export function caseEventKey(prefix: CaseEventKeyPrefix, cancellationId: string): string {
  const h = createHash('sha256').update(`${prefix}:${cancellationId}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
