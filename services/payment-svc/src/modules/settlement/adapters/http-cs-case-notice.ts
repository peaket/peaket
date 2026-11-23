// ops-svc CS 처리함 '정산 이의' 건(F-07-5 LCH-100, ADR-0368 결정 5, settlement §4.2 '이의 받기')과 지급 쪽 건(F-07-6 ADR-0369 결정 10) 열기.
// 이의를 먼저 커밋한 뒤 부른다. ops가 답하지 않거나 받지 않으면 던지고, 이의 행의 case_requested_at이 빈 채로 남아 정산 일꾼이 30분 [가정]마다 다시 보낸다.
// ops는 같은 종류·같은 정산서의 열린 건을 하나로 모은다(eventKey = 이의 ID). 본문에 이의 글·금액은 싣지 않는다.
// F-07-7(계획 §5.1 (타) 결정 2·(파) (마)): openCase의 선택 칸 detail은 있을 때만 본문에 싣는다. ops가 거절하면(202 accepted:false·400·422) OpsIntakeRefused,
// 연결 실패·시간 초과·그 밖 상태는 일시 실패(SettlementProblem 503)로 던진다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { z } from 'zod';
import { SettlementProblem } from '../domain/settlement.js';
import type { SettlementCaseNotice } from '../domain/ports.js';
import { OpsIntakeRefused, refusalOfStatus } from './ops-intake-refused.js';

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
    await this.#open({ eventKey: o.disputeId, kind: 'STATEMENT_DISPUTE', sourceId: o.statementId, createdAt: o.createdAt });
  }

  /** 지급 쪽 다섯 종류(F-07-6 ADR-0369 결정 10). 같은 경로·같은 본문 모양이다(대상 = 묶음·지급 건·토스 셀러·TOSS:{상점}) */
  async openCase(o: { eventKey: string; kind: string; sourceId: string; createdAt: Date; detail?: string }): Promise<void> {
    await this.#open(o);
  }

  async #open(o: { eventKey: string; kind: string; sourceId: string; createdAt: Date; detail?: string }): Promise<void> {
    let res: Awaited<ReturnType<ExternalHttpClient['request']>>;
    try {
      res = await this.#client.request({
        method: 'POST',
        path: '/internal/v1/cs-cases',
        headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
        body: JSON.stringify({ eventKey: o.eventKey, kind: o.kind, sourceId: o.sourceId, category: 'SETTLEMENT', createdAt: o.createdAt.toISOString(), ...(o.detail !== undefined ? { detail: o.detail } : {}) }),
        timeoutCapMs: 3_000,
      });
    } catch {
      throw unavailable('connection');
    }
    const refusal = refusalOfStatus(res.status);
    if (refusal) throw new OpsIntakeRefused(refusal, 'CS 처리함 건');
    if (!res.ok) throw unavailable('status-' + String(res.status));
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw unavailable('json');
    }
    const parsed = CaseAnswer.safeParse(body);
    // ops가 이 종류를 받지 않으면(accepted false) 건이 열리지 않았으므로 다시 보낸다
    if (!parsed.success) throw unavailable('shape');
    if (!parsed.data.accepted) throw new OpsIntakeRefused('NOT_ACCEPTED', 'CS 처리함 건');
  }
}
