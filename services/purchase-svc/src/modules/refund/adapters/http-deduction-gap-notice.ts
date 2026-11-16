// 남는 차액을 ops-svc CS 처리함 REFUND_FAILED(category DEDUCTION_GAP)로 여는 어댑터(BAT-420 몫 D, OPEN[45] 결정, asyncapi CaseRequested, 빈 뼈대).
// POST /internal/v1/cs-cases, eventKey = sha256(`deduction-gap:${cancellationId}`) 앞 16바이트를 UUID 꼴로, 내부 토큰 머리, 5초, 실패는 삼킨다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { DeductionGapNotice } from '../domain/event-refund-ports.js';

export class HttpDeductionGapNotice implements DeductionGapNotice {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(_q: Parameters<DeductionGapNotice['open']>[0]): Promise<void> {
    void this.client;
    void this.internalToken;
    throw new Error('아직 없음');
  }
}
