// CS 처리함 기한 알림 한 바퀴(F-06-2 GAT-280, ADR-0364 결정 3, R-T50 ②③, transfer-refund §13 'CS 처리함 건' 행).
// 열린 건의 기한(진행·결과)마다 1영업일 전이 지나면 CS_CASE_DUE_SOON(SEV3), 기한이 지나면 CS_CASE_OVERDUE(SEV2)를 ops_alert에 한 번 연다.
// 경보 키는 건 ID·기한 종류·기한 값이라 같은 기한은 한 번이고(두 번 돌려도 하나), 연 기한 값을 cs_case.due_soon_alerted_for·overdue_alerted_for에 적는다.
// 세부에는 건 ID·종류·기한 종류(PROGRESS·RESULT)·기한·담당자 관리 계정 ID와 받는 사람(ASSIGNEE·CS_LEAD)만 싣고 팬 정보는 없다.
// 건이 해결되면 그 건의 경보를 풀고 표시를 지운다(갱신 쓰임새가 바로 풀고, 실패했으면 이 바퀴가 다시 푼다).
// 같은 바퀴에서 열린 건의 기한 상태를 종류별로 세어 ops_cs_case_open{kind,due_state}로 낸다.
import type { OpsAlertInput } from '../../alerts/index.js';
import { weekendOnlyCalendar, type BusinessCalendar } from '../domain/business-calendar.js';
import { dueSoonAtOf, dueStateOf } from '../domain/case-deadlines.js';
import type { CsCase, CsCaseAlertRelease, CsCaseSignals, CsCaseStatus, CsCaseStore } from '../domain/cs-case.js';

/** 배경 작업 간격 1분 [가정](ADR-0364 결정 3) */
export const CS_CASE_DEADLINE_TICK_MS = 60_000;
export const CS_CASE_DUE_SOON_ALERT = 'CS_CASE_DUE_SOON';
export const CS_CASE_OVERDUE_ALERT = 'CS_CASE_OVERDUE';
const OPEN_STATUSES: readonly CsCaseStatus[] = ['OPEN', 'IN_PROGRESS'];
const PAGE = 500;
/** 한 바퀴에서 보는 열린 건 상한(500 × 40) */
const MAX_PAGES = 40;
const RESOLVED_BATCH = 200;

type DueKind = 'PROGRESS' | 'RESULT';

/** ops 경보 원장 쓰기(alerts 모듈 RecordOpsAlert의 면) */
export interface CsCaseAlertSink {
  handle(i: OpsAlertInput): Promise<unknown>;
  resolve(i: { eventKey: string; kind: string; reason: string; resolvedAt?: string }): Promise<unknown>;
}

export interface CsCaseDeadlineTickDeps {
  readonly store: CsCaseStore;
  readonly alerts: CsCaseAlertSink;
  readonly calendar?: BusinessCalendar;
  readonly signals?: CsCaseSignals;
}

const iso = (ms: number): string => new Date(ms).toISOString();
/** 경보 키: 건 ID·기한 종류·기한 값(같은 기한은 한 번) */
export const csCaseAlertKey = (caseId: string, dueKind: DueKind, dueMs: number): string => `cs-case:${caseId}:${dueKind}:${iso(dueMs)}`;

const deadlinesOf = (c: CsCase): Array<{ kind: DueKind; dueMs: number }> =>
  (
    [
      { kind: 'PROGRESS' as const, dueMs: c.progressDueAtMs },
      { kind: 'RESULT' as const, dueMs: c.resultDueAtMs },
    ].filter((d): d is { kind: DueKind; dueMs: number } => d.dueMs !== null)
  ).sort((a, b) => a.dueMs - b.dueMs);

export class CsCaseDeadlineTick implements CsCaseAlertRelease {
  readonly #calendar: BusinessCalendar;

  constructor(private readonly d: CsCaseDeadlineTickDeps) {
    this.#calendar = d.calendar ?? weekendOnlyCalendar;
  }

  async run(nowMs: number): Promise<{ dueSoon: number; overdue: number; resolved: number }> {
    let resolved = 0;
    for (const c of await this.d.store.resolvedWithAlerts(RESOLVED_BATCH)) {
      await this.release(c, nowMs);
      resolved++;
    }
    let dueSoon = 0;
    let overdue = 0;
    const counts = new Map<string, number>();
    let after: { nextDueMs: number | null; caseId: string } | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.d.store.list({ statuses: OPEN_STATUSES, ...(after ? { after } : {}), limit: PAGE });
      for (const c of rows) {
        const state = dueStateOf(c, nowMs, this.#calendar);
        const key = `${c.kind}|${state}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const r = await this.#alert(c, nowMs);
        dueSoon += r.dueSoon;
        overdue += r.overdue;
      }
      if (rows.length < PAGE) break;
      const last = rows[rows.length - 1]!;
      const ds = [last.progressDueAtMs, last.resultDueAtMs].filter((v): v is number => v !== null);
      after = { nextDueMs: ds.length === 0 ? null : Math.min(...ds), caseId: last.caseId };
    }
    this.d.signals?.openCounts(counts);
    this.d.signals?.tickFinished(nowMs);
    return { dueSoon, overdue, resolved };
  }

  async #alert(c: CsCase, nowMs: number): Promise<{ dueSoon: number; overdue: number }> {
    let soonMark: number | undefined;
    let overMark: number | undefined;
    for (const d of deadlinesOf(c)) {
      if (nowMs >= dueSoonAtOf(d.dueMs, this.#calendar) && (c.dueSoonAlertedForMs === null || d.dueMs > c.dueSoonAlertedForMs)) {
        await this.d.alerts.handle(this.#input(c, d.kind, d.dueMs, CS_CASE_DUE_SOON_ALERT, nowMs));
        soonMark = d.dueMs;
      }
      if (nowMs >= d.dueMs && (c.overdueAlertedForMs === null || d.dueMs > c.overdueAlertedForMs)) {
        await this.d.alerts.handle(this.#input(c, d.kind, d.dueMs, CS_CASE_OVERDUE_ALERT, nowMs));
        overMark = d.dueMs;
      }
    }
    if (soonMark !== undefined || overMark !== undefined) {
      await this.d.store.markAlerted(c.caseId, { ...(soonMark !== undefined ? { dueSoonForMs: soonMark } : {}), ...(overMark !== undefined ? { overdueForMs: overMark } : {}) });
    }
    return { dueSoon: soonMark !== undefined ? 1 : 0, overdue: overMark !== undefined ? 1 : 0 };
  }

  #input(c: CsCase, dueKind: DueKind, dueMs: number, kind: string, nowMs: number): OpsAlertInput {
    const overdue = kind === CS_CASE_OVERDUE_ALERT;
    return {
      eventKey: csCaseAlertKey(c.caseId, dueKind, dueMs),
      kind,
      severity: overdue ? 'SEV2' : 'SEV3',
      source: 'ops-svc',
      reason: overdue ? 'CS 처리함 건의 기한이 지났습니다' : 'CS 처리함 건의 기한이 1영업일 안으로 다가왔습니다',
      // 팬 정보는 싣지 않는다(ADR-0364 결정 3)
      detail: { caseId: c.caseId, caseKind: c.kind, dueKind, dueAt: iso(dueMs), assignee: c.assignee, recipients: ['ASSIGNEE', 'CS_LEAD'] },
      createdAt: iso(nowMs),
    };
  }

  /** 해결한 건의 경보를 푼다(두 기한 × 두 경보). 없는 경보는 그대로 지나간다 */
  async release(c: CsCase, nowMs: number): Promise<void> {
    for (const d of deadlinesOf(c)) {
      for (const kind of [CS_CASE_DUE_SOON_ALERT, CS_CASE_OVERDUE_ALERT]) {
        await this.d.alerts.resolve({ eventKey: csCaseAlertKey(c.caseId, d.kind, d.dueMs), kind, reason: '건을 해결했습니다', resolvedAt: iso(nowMs) });
      }
    }
    await this.d.store.clearAlerted(c.caseId);
  }
}
