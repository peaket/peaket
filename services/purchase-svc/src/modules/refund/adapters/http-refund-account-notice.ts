// 가상계좌 환불의 계좌 대기를 ops-svc CS 처리함 '환불 대기'(REFUND_ACCOUNT_PENDING, category REFUND)로 여는 어댑터
// (BUILD_ORDER GAT-090, docs/features/payment.md §6 '계좌 대기', docs/features/transfer-refund.md §3.1 ⑥). HttpRefundFailureNotice와 같은 꼴이다.
// POST /internal/v1/cs-cases, 본문 { eventKey, kind: 'REFUND_ACCOUNT_PENDING', sourceId, category, createdAt }, 내부 토큰 머리, 5초.
// 2xx를 받아야 연 것이다. 401·4xx·5xx는 CsCaseRejected, 시간 초과·연결 실패는 그 오류 그대로 던진다. 부른 쪽(환급 실행기 틱 끝)이 경고·지표를 남기고
// refund_account_case_opened_at을 비운 채 두어 다음 틱에 다시 연다.
// eventKey는 `refund-account:{취소 ID}`의 SHA-256 앞 16바이트 UUID다. 계좌·금액·개인정보는 싣지 않는다(계좌는 저장하지 않으므로 여기에도 없다).
import type { ExternalHttpClient } from '@peaket/platform';
import { caseEventKey } from '../domain/case-event-key.js';
import type { RefundAccountNotice } from '../domain/event-refund-ports.js';
import { requireAccepted } from './cs-case-response.js';

/** ops 내부 호출 한도 5초 [가정] */
const TIMEOUT_MS = 5_000;

export class HttpRefundAccountNotice implements RefundAccountNotice {
  /** 내부 토큰은 다른 CS 어댑터와 같이 생성자로 받는다(process.env를 읽지 않는다) */
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(q: Parameters<RefundAccountNotice['open']>[0]): Promise<void> {
    // 같은 취소는 같은 eventKey·sourceId라 ops CS 처리함에서 한 건이다(다시 보내도 된다)
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/cs-cases',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({
        eventKey: caseEventKey('refund-account', q.cancellationId),
        kind: 'REFUND_ACCOUNT_PENDING',
        sourceId: q.cancellationId,
        category: 'REFUND',
        createdAt: new Date(q.nowMs).toISOString(),
      }),
      timeoutCapMs: TIMEOUT_MS,
    });
    await requireAccepted(res, 'refund-account');
  }
}
