// 건 요청(support.cases-requested·내부 HTTP)을 CS 처리함 건으로 바꾸는 쓰임새(GAT-110 첫 몫, F-06-2 GAT-280 ADR-0364 결정 2·4).
// 받는 종류는 cs-case.ts ACCEPTED_KINDS다(F-06-2의 아홉과 F-07-5가 더한 정산 이의 STATEMENT_DISPUTE, 대상 = 정산서 ID, ADR-0368 결정 5). 그 밖 종류와 칸이 빠진 본문은 건을 만들지 않는다(accepted: false, 지표 결과 ignored).
// 기한은 건을 열 때 dueBaseAt(없으면 createdAt)에서 영업일 달력으로 센다. 같은 eventKey는 해결된 건이어도 새 건을 열지 않고(duplicate),
// 같은 (종류, 대상)의 열린 건이 있으면 그 건이다(existing). 내부 HTTP와 Kafka 소비자가 이 처리기 하나를 부른다.
import { randomUUID } from 'node:crypto';
import { weekendOnlyCalendar, type BusinessCalendar } from '../domain/business-calendar.js';
import { deadlinesOf } from '../domain/case-deadlines.js';
import { ACCEPTED_KINDS, type CaseRequested, type CsCase, type CsCaseSignals, type CsCaseStore } from '../domain/cs-case.js';

export type CaseRequestResult = 'opened' | 'existing' | 'duplicate' | 'ignored';

export interface ReceiveCaseRequestedOptions {
  readonly calendar?: BusinessCalendar;
  readonly signals?: CsCaseSignals;
}

export class ReceiveCaseRequested {
  readonly #calendar: BusinessCalendar;
  readonly #signals: CsCaseSignals | undefined;

  constructor(
    private readonly store: CsCaseStore,
    o: ReceiveCaseRequestedOptions = {},
  ) {
    this.#calendar = o.calendar ?? weekendOnlyCalendar;
    this.#signals = o.signals;
  }

  /** 받지 않은 요청을 지표에 센다(본문 모양이 틀려 handle까지 오지 못한 것) */
  ignored(kind: string): void {
    this.#signals?.request(kind, 'ignored');
  }

  /** inheritedDueMs: 승인 업무 실행 실패 건이 이어받는 원래 기한(ADR-0364 결정 6) */
  async handle(payload: CaseRequested, nowMs: number, o: { inheritedDueMs?: number | null } = {}): Promise<{ accepted: boolean; result: CaseRequestResult; case?: CsCase }> {
    if (!ACCEPTED_KINDS.has(payload.kind)) {
      this.ignored(payload.kind);
      return { accepted: false, result: 'ignored' };
    }
    const createdMs = Date.parse(payload.createdAt);
    const baseRaw = payload.dueBaseAt !== undefined ? Date.parse(payload.dueBaseAt) : createdMs;
    // 시각을 읽지 못하면 받은 시각으로 센다(본문 검사는 받는 층이 했다)
    const baseMs = Number.isFinite(baseRaw) ? baseRaw : nowMs;
    const due = deadlinesOf({ kind: payload.kind, category: payload.category, baseMs, inheritedDueMs: o.inheritedDueMs ?? null }, this.#calendar);
    const r = await this.store.receive({
      caseId: randomUUID(),
      eventKey: payload.eventKey,
      kind: payload.kind,
      targetRef: payload.sourceId,
      category: payload.category,
      progressDueAtMs: due.progressDueMs,
      resultDueAtMs: due.resultDueMs,
      nowMs,
    });
    this.#signals?.request(payload.kind, r.result);
    return { accepted: true, result: r.result, case: r.case };
  }
}
