// CS 처리함 목록·상세·갱신 쓰임새(openapi listOpsCases·getOpsCase·updateOpsCase, F-06-2 GAT-280, ADR-0364 결정 5, R-T49).
// 역할: CS 담당자(cs_agent·cs_lead)의 목록에는 지급·대사·KYC 건과 운영 쪽 승인 업무 실행 실패 건(PAYOUT_BATCH·COMMANDER_ROLE_CHANGE·CONTRACT_TERMS_CHANGE)이 없고
// 상세·갱신은 없는 건과 같은 404다(open-items 72번, 리뷰 RV-01·RV-04). operator·commander는 모두 보고 그 건만 갱신한다(관리 역할 변경·계약 변경 실패 건은 commander만,
// 그 밖 403 case-update-not-allowed). viewer는 경로 역할에 없어 403이다.
// 배정: cs_agent(와 operator·commander)는 아무도 맡지 않은 건을 자기에게 맡거나 자기 배정을 풀 때만이고, 맡은 사람이 있는 건을 바꾸는 것은 cs_lead다(어기면 403).
// 풀기는 assignee: null이고 빈 글은 받는 층이 400 invalid-body로 막는다(리뷰 RV-02). cs_lead는 활성 CS 담당자 누구에게나 맡긴다(아니면 422 case-assignee-invalid).
// 상태 차례 밖은 422 case-status-transition-invalid, 2,000자를 넘는 메모는 400 invalid-body다(R-T49 ⑨).
// 상태: OPEN → IN_PROGRESS → RESOLVED, OPEN → RESOLVED. 해결은 끝이고(다시 고치면 409), 해결에는 결과 메모(1~2,000자)가 같은 요청에 있어야 한다.
// 갱신은 If-Match 판(없으면 428, 다르면 412)이고 판이 1 오르며, 감사 체인에 행위자·이전·다음 상태·배정을 한 줄 남긴다(메모 본문은 남기지 않는다).
import { ProblemError } from '@peaket/platform';
import type { AuditRecord } from '../../audit/index.js';
import { addBusinessDays, weekendOnlyCalendar, type BusinessCalendar } from '../domain/business-calendar.js';
import { dueStateOf, type CsDueState } from '../domain/case-deadlines.js';
import {
  CS_CASE_KINDS,
  CS_CASE_STATUSES,
  RESULT_NOTE_MAX,
  OPS_APPROVAL_FAILURE_CATEGORIES,
  SETTLEMENT_OPS_KINDS,
  isCommanderOnlyCase,
  isOpsSideCase,
  nextDueOf,
  type CsActor,
  type CsAssigneeDirectory,
  type CsCase,
  type CsCaseAlertRelease,
  type CsCaseDetailReader,
  type CsCaseKind,
  type CsCaseStatus,
  type CsCaseStore,
} from '../domain/cs-case.js';

export interface CsCaseView {
  readonly caseId: string;
  readonly kind: CsCaseKind;
  readonly targetRef: string;
  readonly progressDueAt?: string;
  readonly resultDueAt?: string;
  readonly status: CsCaseStatus;
  readonly category: string;
  readonly assignee: string | null;
  readonly version: number;
  readonly dueState: CsDueState;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resultNote: string | null;
}

export interface CsCasesDeps {
  readonly store: CsCaseStore;
  readonly clock: { now(): number };
  readonly calendar?: BusinessCalendar;
  readonly assignees?: CsAssigneeDirectory;
  readonly alerts?: CsCaseAlertRelease;
  readonly detailReaders?: ReadonlyMap<CsCaseKind, CsCaseDetailReader>;
  readonly log?: { warn(obj: object, msg: string): void };
}

export interface CsCaseUpdateBody {
  /** 빈 글이나 null은 배정 풀기 */
  readonly assignee?: string | null | undefined;
  readonly status?: CsCaseStatus | undefined;
  readonly resultNote?: string | undefined;
}

const CS_ROLES: ReadonlySet<string> = new Set(['cs_agent', 'cs_lead']);
const OPS_ROLES: ReadonlySet<string> = new Set(['operator', 'commander']);
const LIST_ROLES: ReadonlySet<string> = new Set([...CS_ROLES, ...OPS_ROLES]);
const OPEN_STATUSES: readonly CsCaseStatus[] = ['OPEN', 'IN_PROGRESS'];
const NEXT_STATUSES: Readonly<Record<CsCaseStatus, readonly CsCaseStatus[]>> = { OPEN: ['IN_PROGRESS', 'RESOLVED'], IN_PROGRESS: ['RESOLVED'], RESOLVED: [] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_DUE_WITHIN_DAYS = 30;

const problem = (type: string, status: number, title: string): ProblemError => new ProblemError({ type, status, title });
const badQuery = (title: string): ProblemError => problem('invalid-query', 400, title);
const notFound = (): ProblemError => problem('not-found', 404, '없는 건입니다');
const notAllowed = (title = '이 건을 고칠 수 있는 역할이 아닙니다'): ProblemError => problem('case-update-not-allowed', 403, title);
const codePoints = (s: string): number => [...s].length;
const iso = (ms: number): string => new Date(ms).toISOString();

const isCsRole = (role: string): boolean => CS_ROLES.has(role);
/** 그 역할이 이 건을 볼 수 있는가(CS 담당자에게 지급·대사·KYC 건은 없다) */
const canSee = (actor: CsActor, c: Pick<CsCase, 'kind' | 'category'>): boolean => LIST_ROLES.has(actor.role) && !(isCsRole(actor.role) && isOpsSideCase(c));
/** 그 역할이 이 건을 고칠 수 있는가 */
const canUpdate = (actor: CsActor, c: Pick<CsCase, 'kind' | 'category'>): boolean => {
  if (isCsRole(actor.role)) return !isOpsSideCase(c);
  if (!OPS_ROLES.has(actor.role) || !isOpsSideCase(c)) return false;
  return actor.role === 'commander' || !isCommanderOnlyCase(c);
};

/** If-Match 판 읽기(admin-accounts parseIfMatch와 같은 꼴: "7" 또는 W/"7") */
function parseIfMatch(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(?:W\/)?"(\d{1,15})"$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 불투명 커서: 이른 기한(없으면 null)과 건 ID */
function encodeCursor(c: CsCase): string {
  return Buffer.from(JSON.stringify({ d: nextDueOf(c), i: c.caseId }), 'utf8').toString('base64url');
}
function decodeCursor(raw: string): { nextDueMs: number | null; caseId: string } {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { d?: unknown; i?: unknown };
    const d = v.d;
    if ((d !== null && (typeof d !== 'number' || !Number.isSafeInteger(d))) || typeof v.i !== 'string' || !UUID.test(v.i)) throw new Error('bad');
    return { nextDueMs: d, caseId: v.i.toLowerCase() };
  } catch {
    throw badQuery('cursor가 올바르지 않습니다');
  }
}

export class CsCases {
  readonly #calendar: BusinessCalendar;

  constructor(private readonly d: CsCasesDeps) {
    this.#calendar = d.calendar ?? weekendOnlyCalendar;
  }

  view(c: CsCase, nowMs: number): CsCaseView {
    return {
      caseId: c.caseId,
      kind: c.kind,
      targetRef: c.targetRef,
      ...(c.progressDueAtMs !== null ? { progressDueAt: iso(c.progressDueAtMs) } : {}),
      ...(c.resultDueAtMs !== null ? { resultDueAt: iso(c.resultDueAtMs) } : {}),
      status: c.status,
      category: c.category,
      assignee: c.assignee,
      version: c.version,
      dueState: dueStateOf(c, nowMs, this.#calendar),
      createdAt: iso(c.createdAtMs),
      resolvedAt: c.resolvedAtMs !== null ? iso(c.resolvedAtMs) : null,
      resultNote: c.resultNote,
    };
  }

  async list(actor: CsActor, q: { kind?: string | undefined; status?: string | undefined; dueWithinDays?: string | number | undefined; cursor?: string | undefined; limit?: string | number | undefined }): Promise<{ items: CsCaseView[]; nextCursor: string | null }> {
    // 경로 역할(RolesGuard)이 먼저 막는다. 여기는 다른 조립에서 부를 때의 두 번째 확인이다
    if (!LIST_ROLES.has(actor.role)) throw notAllowed('CS 처리함을 쓸 수 있는 역할이 아닙니다');
    if (q.kind !== undefined && !(CS_CASE_KINDS as readonly string[]).includes(q.kind)) throw badQuery('모르는 건 종류입니다');
    if (q.status !== undefined && !(CS_CASE_STATUSES as readonly string[]).includes(q.status)) throw badQuery('모르는 상태입니다');
    const within = q.dueWithinDays === undefined || q.dueWithinDays === '' ? undefined : Number(q.dueWithinDays);
    if (within !== undefined && (!Number.isSafeInteger(within) || within < 0 || within > MAX_DUE_WITHIN_DAYS)) throw badQuery('dueWithinDays는 0~30입니다');
    const limit = q.limit === undefined || q.limit === '' ? DEFAULT_LIMIT : Number(q.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw badQuery('limit은 1~100입니다');
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const kind = q.kind as CsCaseKind | undefined;
    // CS 담당자가 지급·대사·KYC 종류로 걸러도 0건이다(오류가 아니다, openapi listOpsCases)
    if (kind && isCsRole(actor.role) && SETTLEMENT_OPS_KINDS.has(kind)) return { items: [], nextCursor: null };
    const nowMs = this.d.clock.now();
    const dueAtOrBeforeMs = within === undefined ? undefined : within === 0 ? nowMs : addBusinessDays(this.#calendar, nowMs, within);
    const rows = await this.d.store.list({
      statuses: q.status ? [q.status as CsCaseStatus] : OPEN_STATUSES,
      ...(kind ? { kinds: [kind] } : {}),
      ...(isCsRole(actor.role) ? { excludeKinds: [...SETTLEMENT_OPS_KINDS], excludeCategories: { kind: 'APPROVAL_EXECUTION_FAILED' as const, categories: [...OPS_APPROVAL_FAILURE_CATEGORIES] } } : {}),
      ...(dueAtOrBeforeMs !== undefined ? { dueAtOrBeforeMs } : {}),
      ...(after ? { after } : {}),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return { items: page.map((c) => this.view(c, nowMs)), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null };
  }

  async #visible(actor: CsActor, caseId: string): Promise<CsCase> {
    const c = UUID.test(caseId) ? await this.d.store.find(caseId.toLowerCase()) : undefined;
    if (!c || !canSee(actor, c)) throw notFound();
    return c;
  }

  async get(actor: CsActor, caseId: string): Promise<{ view: CsCaseView & Record<string, unknown>; version: number }> {
    const c = await this.#visible(actor, caseId);
    const reader = this.d.detailReaders?.get(c.kind);
    const extra = reader ? await reader.read(c, actor) : {};
    return { view: { ...extra, ...this.view(c, this.d.clock.now()) }, version: c.version };
  }

  async update(actor: CsActor, caseId: string, ifMatch: string | undefined, body: CsCaseUpdateBody): Promise<{ view: CsCaseView; version: number }> {
    const c = await this.#visible(actor, caseId);
    if (!canUpdate(actor, c)) throw notAllowed();
    const version = parseIfMatch(ifMatch);
    if (version === null) throw problem('precondition-required', 428, '고칠 판(If-Match)을 보내 주세요');
    if (version !== c.version) throw problem('precondition-failed', 412, '다른 곳에서 이 건을 먼저 고쳤습니다');
    if (c.status === 'RESOLVED') throw problem('case-already-resolved', 409, '이미 해결한 건입니다');
    if (body.assignee === undefined && body.status === undefined && body.resultNote === undefined) throw problem('invalid-body', 400, '고칠 칸이 없습니다');
    const status = body.status ?? c.status;
    if (status !== c.status && !NEXT_STATUSES[c.status].includes(status)) throw problem('case-status-transition-invalid', 422, '지금 상태에서 바꿀 수 없는 상태입니다');
    if (body.resultNote !== undefined && codePoints(body.resultNote) > RESULT_NOTE_MAX) throw problem('invalid-body', 400, '결과 메모는 2,000자까지입니다');
    const note = body.resultNote !== undefined && body.resultNote.trim() !== '' ? body.resultNote : undefined;
    if (status === 'RESOLVED' && note === undefined) throw problem('case-result-note-required', 422, '결과 메모를 적어 주세요');
    const assignee = body.assignee === undefined ? c.assignee : await this.#assigneeOf(actor, c, body.assignee);
    const nowMs = this.d.clock.now();
    const next: CsCase = {
      ...c,
      status,
      assignee,
      resultNote: note ?? c.resultNote,
      resolvedAtMs: status === 'RESOLVED' ? nowMs : null,
      version: c.version + 1,
      updatedAtMs: nowMs,
    };
    if (!(await this.d.store.update(next, c.version, this.#audit(c, next, actor, nowMs)))) throw problem('precondition-failed', 412, '다른 곳에서 이 건을 먼저 고쳤습니다');
    if (next.status === 'RESOLVED') await this.#releaseAlerts(next, nowMs);
    return { view: this.view(next, nowMs), version: next.version };
  }

  /**
   * 시스템이 건을 해결로 닫는다(실패한 승인 업무의 다시 실행 성공, ADR-0364 결정 6. F-06-7 이의 결정도 쓴다).
   * 이미 해결됐거나 없으면 undefined. 판이 겨루면 한 번 다시 읽어 시도한다
   */
  async resolveAsSystem(caseId: string, resultNote: string, nowMs: number, actorRef = 'system'): Promise<CsCase | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = await this.d.store.find(caseId);
      if (!c || c.status === 'RESOLVED') return undefined;
      const next: CsCase = { ...c, status: 'RESOLVED', resultNote, resolvedAtMs: nowMs, version: c.version + 1, updatedAtMs: nowMs };
      if (await this.d.store.update(next, c.version, this.#audit(c, next, { accountId: actorRef, role: 'system' }, nowMs))) {
        await this.#releaseAlerts(next, nowMs);
        return next;
      }
    }
    return undefined;
  }

  async #assigneeOf(actor: CsActor, c: CsCase, raw: string | null): Promise<string | null> {
    // 빈 글은 받는 층이 400으로 막는다. 여기 오는 빈 글(다른 조립)도 풀기로 읽지 않는다
    if (raw === '') throw problem('invalid-body', 400, '배정 풀기는 assignee: null로 보내 주세요');
    const target = raw === null ? null : raw.toLowerCase();
    if (target === c.assignee) return target;
    if (target !== null && !UUID.test(target)) throw problem('case-assignee-invalid', 422, '맡길 수 없는 계정입니다');
    const self = actor.accountId.toLowerCase();
    if (actor.role === 'cs_lead') {
      if (target === null || target === self) return target;
      let active: boolean;
      try {
        if (!this.d.assignees) throw new Error('배정 대상 확인기가 없다');
        active = await this.d.assignees.isActiveCsAgent(target);
      } catch {
        throw problem('authz-unavailable', 503, '맡길 계정을 확인하지 못했습니다');
      }
      if (!active) throw problem('case-assignee-invalid', 422, '맡길 수 없는 계정입니다');
      return target;
    }
    // cs_agent·operator·commander: 아무도 맡지 않은 건을 자기에게 맡거나 자기 배정을 풀 때만. 맡은 사람이 있는 건을 바꾸는 것은 cs_lead다
    const current = c.assignee?.toLowerCase() ?? null;
    if (target === self && current === null) return target;
    if (target === null && current === self) return null;
    throw notAllowed(current !== null && current !== self ? '맡은 사람이 있는 건은 CS 책임자(cs_lead)가 바꿉니다' : '자기에게 맡기거나 자기 배정을 풀 때만 고칠 수 있습니다');
  }

  #audit(prev: CsCase, next: CsCase, actor: CsActor, nowMs: number): AuditRecord {
    return {
      recordType: 'CS_CASE_UPDATED',
      recordId: next.caseId,
      payload: {
        caseId: next.caseId,
        kind: next.kind,
        actorAdminAccountId: actor.accountId,
        actorRole: actor.role,
        fromStatus: prev.status,
        toStatus: next.status,
        fromAssignee: prev.assignee,
        toAssignee: next.assignee,
        version: next.version,
        // 메모 본문은 남기지 않고 바뀌었는지만 적는다(ADR-0364 결정 5)
        resultNoteChanged: prev.resultNote !== next.resultNote,
      },
      nowMs,
    };
  }

  async #releaseAlerts(c: CsCase, nowMs: number): Promise<void> {
    if (!this.d.alerts || (c.dueSoonAlertedForMs === null && c.overdueAlertedForMs === null)) return;
    try {
      await this.d.alerts.release(c, nowMs);
    } catch (err) {
      this.d.log?.warn({ event: 'cs-case-alert-release-failed', caseId: c.caseId, err: err instanceof Error ? err.name : 'unknown' }, '해결한 건의 기한 경보를 풀지 못했다(배경 작업이 다시 푼다)');
    }
  }
}
