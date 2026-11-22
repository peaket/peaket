// ops-svc CS 처리함 '정산 이의' 건 열기(F-07-5 LCH-100, ADR-0368 결정 5, settlement §4.2 '이의 받기').
// 이의를 먼저 커밋한 뒤 부른다. ops가 답하지 않거나 받지 않으면 던지고, 이의 행의 case_requested_at이 빈 채로 남아 정산 일꾼이 30분 [가정]마다 다시 보낸다.
// ops는 같은 종류·같은 정산서의 열린 건을 하나로 모은다(eventKey = 이의 ID). 본문에 이의 글·금액은 싣지 않는다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { z } from 'zod';
import { SettlementProblem } from '../domain/settlement.js';
import type { SettlementCaseNotice } from '../domain/ports.js';

const CaseAnswer = z.object({ accepted: z.boolean(), caseId: z.string().optional() });

const unavailable = (detail: string) => new SettlementProblem('dependency-unavailable', 503, `CS 처리함 건을 열지 못했습니다(${detail})`);

export class HttpSettlementCaseNotice implements SettlementCaseNotice {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  constructor(
    baseUrl: string,
    private readonly internalToken?: string,
    fetchImpl?: typeof fetch,
    timeoutCapMs = 3_000,
  ) {
    this.#client = createExternalHttpClient({ provider: 'ops-svc', baseUrl, timeoutCapMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  async openDispute(o: { disputeId: string; statementId: string; createdAt: Date }): Promise<void> {
    let res: Awaited<ReturnType<ExternalHttpClient['request']>>;
    try {
      res = await this.#client.request({
        method: 'POST',
        path: '/internal/v1/cs-cases',
        headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
        body: JSON.stringify({ eventKey: o.disputeId, kind: 'STATEMENT_DISPUTE', sourceId: o.statementId, category: 'SETTLEMENT', createdAt: o.createdAt.toISOString() }),
        timeoutCapMs: 3_000,
      });
    } catch {
      throw unavailable('connection');
    }
    if (!res.ok) throw unavailable(`status-${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw unavailable('json');
    }
    const parsed = CaseAnswer.safeParse(body);
    // ops가 이 종류를 받지 않으면(accepted false) 건이 열리지 않았으므로 다시 보낸다
    if (!parsed.success || !parsed.data.accepted) throw unavailable('not-accepted');
  }
}
