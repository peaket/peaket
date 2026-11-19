// 배상 송금 실패를 ops-svc CS 처리함 '배상 대기'(COMPENSATION_PENDING)로 여는 어댑터(BAT-425, ADR-0317 결정 6, docs/api/guidelines.md §8.1).
// POST /internal/v1/cs-cases, eventKey = sha256(`compensation:{id}`) 앞 16바이트를 UUID 꼴로(같은 배상은 같은 건), 내부 토큰 머리, 5초.
// 2xx·accepted: true를 받아야 연 것이다. 실패는 던져 부르는 쪽이 경고만 남긴다(응답의 422를 바꾸지 않는다). 금액·계좌·개인정보는 본문에 싣지 않는다.
import type { ExternalHttpClient } from '@peaket/platform';
import { caseEventKey } from '../domain/case-event-key.js';
import type { CompensationCaseNotice } from '../domain/ports.js';
import { requireAccepted } from './cs-case-response.js';

const TIMEOUT_MS = 5_000;

/** 같은 배상의 CS 건은 늘 같은 eventKey다(ops가 한 건으로 모은다) */
export function compensationCaseEventKey(compensationId: string): string {
  return caseEventKey('compensation', compensationId);
}

export class HttpCompensationCaseNotice implements CompensationCaseNotice {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(q: Parameters<CompensationCaseNotice['open']>[0]): Promise<void> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/cs-cases',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({ eventKey: compensationCaseEventKey(q.compensationId), kind: 'COMPENSATION_PENDING', sourceId: q.compensationId, category: 'COMPENSATION', createdAt: new Date(q.nowMs).toISOString() }),
      timeoutCapMs: TIMEOUT_MS,
    });
    await requireAccepted(res, 'compensation-pending');
  }
}
