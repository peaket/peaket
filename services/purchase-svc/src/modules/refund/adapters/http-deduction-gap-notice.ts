// 남는 차액을 ops-svc CS 처리함 REFUND_FAILED(category DEDUCTION_GAP)로 여는 어댑터(BAT-420 몫 D, OPEN[45] 결정, asyncapi CaseRequested).
// POST /internal/v1/cs-cases, eventKey = sha256(`deduction-gap:${cancellationId}`) 앞 16바이트를 UUID 꼴로(같은 취소는 같은 건), 내부 토큰 머리, 5초.
// 2xx를 받아야 연 것이다. 401·5xx·시간 초과·연결 실패는 던진다(웨이브 끝 리뷰 S1, guidelines §8.1 'ops-svc CS 처리함 내부 HTTP'):
// 부른 쪽이 경고·지표를 남기고 행의 deduction_gap_opened_at이 빈 채로 두어 다음 틱에 다시 연다.
// CS가 승인 업무 '시스템 잘못이 확인된 환불'로 차액을 돌려준다(자동 추가 환급은 하지 않는다). 금액·개인정보는 본문에 싣지 않는다.
import type { ExternalHttpClient } from '@peaket/platform';
import { caseEventKey } from '../domain/case-event-key.js';
import { requireAccepted } from './cs-case-response.js';
import type { DeductionGapNotice } from '../domain/event-refund-ports.js';

/** ops 내부 호출 한도 5초 [가정] */
const TIMEOUT_MS = 5_000;

/** 같은 취소의 차액 건은 늘 같은 eventKey다(ops CS 처리함이 한 건으로 모은다) */
export function deductionGapEventKey(cancellationId: string): string {
  return caseEventKey('deduction-gap', cancellationId);
}

export class HttpDeductionGapNotice implements DeductionGapNotice {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(q: Parameters<DeductionGapNotice['open']>[0]): Promise<void> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/cs-cases',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({ eventKey: deductionGapEventKey(q.cancellationId), kind: 'REFUND_FAILED', sourceId: q.cancellationId, category: 'DEDUCTION_GAP', createdAt: new Date(q.nowMs).toISOString() }),
      timeoutCapMs: TIMEOUT_MS,
    });
    await requireAccepted(res, 'deduction-gap');
  }
}
