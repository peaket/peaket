// 남는 차액을 ops-svc CS 처리함 REFUND_FAILED(category DEDUCTION_GAP)로 여는 어댑터(BAT-420 몫 D, OPEN[45] 결정, asyncapi CaseRequested).
// POST /internal/v1/cs-cases, eventKey = sha256(`deduction-gap:${cancellationId}`) 앞 16바이트를 UUID 꼴로(같은 취소는 같은 건), 내부 토큰 머리, 5초, 실패는 삼킨다.
// CS가 승인 업무 '시스템 잘못이 확인된 환불'로 차액을 돌려준다(자동 추가 환급은 하지 않는다). 금액·개인정보는 본문에 싣지 않는다.
import { createHash } from 'node:crypto';
import type { ExternalHttpClient } from '@peaket/platform';
import type { DeductionGapNotice } from '../domain/event-refund-ports.js';

/** ops 내부 호출 한도 5초 [가정] */
const TIMEOUT_MS = 5_000;

/** 같은 취소의 차액 건은 늘 같은 eventKey다(ops CS 처리함이 한 건으로 모은다) */
export function deductionGapEventKey(cancellationId: string): string {
  const h = createHash('sha256').update(`deduction-gap:${cancellationId}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class HttpDeductionGapNotice implements DeductionGapNotice {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(q: Parameters<DeductionGapNotice['open']>[0]): Promise<void> {
    try {
      await this.client.request({
        method: 'POST',
        path: '/internal/v1/cs-cases',
        headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
        body: JSON.stringify({ eventKey: deductionGapEventKey(q.cancellationId), kind: 'REFUND_FAILED', sourceId: q.cancellationId, category: 'DEDUCTION_GAP', createdAt: new Date(q.nowMs).toISOString() }),
        timeoutCapMs: TIMEOUT_MS,
      });
    } catch {
      // best effort: 건을 못 열어도 일괄 환불은 이어 간다. 다시 시작하면 다시 찾지 않으므로 실패는 부른 쪽 로그가 본다
    }
  }
}
