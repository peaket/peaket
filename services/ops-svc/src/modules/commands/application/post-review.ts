// 명령 3·11 사후 검토 보고서 쓰임새(ADR-0349 결정 7, docs/features/control-tower.md §6 '사후 검토 보고서의 항목'·'첫 구현', C-T10 ②, C-T46 ②).
// - 열기: 처음 DISPATCHED와 같은 트랜잭션에서 command-writes.ts openPostReviewIn이 연다. 런북으로 실행한 명령 3(OPS-310)과 놓친 명령은 open(commandId)·정비가 같은 함수로 연다.
// - 제출: 실행한 commander만(아니면 403 post-review-not-executor). 계기가 명령에 맞지 않거나 명령 11인데 이유가 없으면 422, 두 번이면 409. 늦은 제출도 받고 late.
// - 검토: 실행자가 아닌 commander만(아니면 403 post-review-self-confirm). 활성 commander가 실행자 한 명뿐인 1인 기간에만 실행자의 검토를 받고 감사 기록에 남긴다.
//   활성 commander 목록을 읽지 못하면 503 admin-account-unavailable이고 자기 검토를 받지 않는다. 제출 전·두 번이면 409. 늦은 검토도 받고 late.
// - 기한: 작성 48시간·검토 7일, 정각이면 넘김. 넘기면 SEV3 ops 경보(post-review-overdue·post-review-confirm-overdue, 명령마다 하나)를 정비가 한 번 낸다.
// - 조회: 보고서와 ★ 칸(실행 기록, 정지부터 재개까지 같은 범위의 명령, 재개 시각과 승인자)을 ops DB로 채우고, 지표 칸은 원천이 생길 때까지 unavailable이다.
import { randomUUID } from 'node:crypto';
import { ProblemError } from '@peaket/platform';
import type { OpsAlertStore } from '../../alerts/index.js';
import type { Command } from '../domain/command.js';
import { openPostReviewIn, recordDigest } from '../domain/command-writes.js';
import {
  POST_REVIEW_CONFIRM_DUE_MS,
  POST_REVIEW_CONFIRM_OVERDUE_ALERT,
  POST_REVIEW_OVERDUE_ALERT,
  PostReviewInvalid,
  isOverdue,
  isPostReviewType,
  postReviewConfirmationOf,
  postReviewReportOf,
  type PostReviewAlertKind,
  type PostReviewAssessment,
  type PostReviewReport,
  type PostReviewRow,
} from '../domain/post-review.js';
import { ActiveCommandersUnavailable, type ActiveCommanders, type CommandStore, type CommandTimelineEntry } from '../domain/ports.js';

/** 원천이 아직 없는 칸의 까닭(dry-run unavailable과 같은 말) */
const SOURCE_NOT_WIRED = 'source-not-wired';

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

const notFound = (): ProblemError => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const conflict = (detail: string): ProblemError => new ProblemError({ type: 'post-review-conflict', status: 409, title: '지금 사후 검토 상태에서는 할 수 없습니다', detail });
const invalid = (field: string): ProblemError => new ProblemError({ type: 'post-review-invalid', status: 422, title: '사후 검토 보고서 값이 올바르지 않습니다', detail: field });
const notExecutor = (): ProblemError => new ProblemError({ type: 'post-review-not-executor', status: 403, title: '명령을 실행한 commander만 제출할 수 있습니다' });
const selfConfirm = (): ProblemError =>
  new ProblemError({ type: 'post-review-self-confirm', status: 403, title: '실행한 분은 검토할 수 없습니다. 다른 commander가 검토합니다' });
const commandersUnavailable = (): ProblemError => new ProblemError({ type: 'admin-account-unavailable', status: 503, title: '관리 계정 서비스에 닿지 못했습니다', retryAfterSeconds: 5 });
const roleForbidden = (): ProblemError => new ProblemError({ type: 'command-role-forbidden', status: 403, title: '이 명령을 할 수 있는 역할이 아닙니다' });

/** 원천이 없어 비워 둔 ★ 지표 칸(명령마다) */
const UNAVAILABLE_KEYS: Readonly<Record<'KILL_SWITCH' | 'AUTOMATION_STOP', readonly string[]>> = {
  KILL_SWITCH: ['impact.blockedHolds', 'impact.blockedPaymentAttempts', 'impact.completedPayments', 'impact.waitingDuringStop'],
  AUTOMATION_STOP: ['impact.admissionTargetChange', 'impact.errorBudgetChange', 'impact.preTurnAdmissions', 'impact.etaError'],
};

export interface PostReviewActor {
  readonly accountId: string;
  readonly role: string;
}

export interface PostReviewView {
  readonly commandId: string;
  readonly type: string;
  readonly state: string;
  readonly reason: string;
  readonly executor: { readonly adminAccountId?: string; readonly displayName: null; readonly role: string };
  readonly dueAt: string;
  readonly late: boolean;
  readonly submittedAt: string | null;
  readonly report: PostReviewReport | null;
  readonly confirmDueAt: string | null;
  readonly confirmedAt: string | null;
  readonly reviewer: { readonly adminAccountId?: string; readonly displayName: null; readonly role: string } | null;
  readonly assessment: PostReviewAssessment | null;
  readonly comment: string | null;
  readonly soloSelfReview: boolean;
  readonly execution: { readonly dispatchedAt: string | null; readonly ackedAt: string | null; readonly attempts: number };
  readonly actionsDuringStop: readonly { readonly commandId: string; readonly type: string; readonly state: string; readonly createdAt: string }[];
  readonly impact: { readonly stopped: boolean; readonly stopDurationSec: number | null };
  readonly resumption: {
    readonly revertRequestedAt: string | null;
    readonly revertedAt: string | null;
    readonly requestedBy: { readonly adminAccountId?: string; readonly displayName: null; readonly role: string } | null;
    readonly approvedBy: { readonly adminAccountId?: string; readonly displayName: null; readonly role: string } | null;
  };
  readonly unavailable: readonly { readonly key: string; readonly source: string; readonly reason: string }[];
}

export interface PostReviewsDeps {
  readonly store: CommandStore;
  /** 1인 기간 판정(identity). 없으면 실행자의 검토는 503이다(닫힌 쪽) */
  readonly commanders?: ActiveCommanders;
  /** 기한 넘김 SEV3(ops 경보). 없으면 정비가 경보 없이 표시만 한다 */
  readonly alerts?: OpsAlertStore;
}

const actorOf = (accountId: string | undefined, role: string) => ({ ...(accountId ? { adminAccountId: accountId } : {}), displayName: null, role });
const eventIdsOf = (c: Command): readonly string[] => (Array.isArray(c.params.eventIds) ? (c.params.eventIds as unknown[]).filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()) : []);

export class PostReviews {
  constructor(private readonly deps: PostReviewsDeps) {}

  /** 할 일을 연다(명령 3·11, 처음 DISPATCHED 뒤). 이미 있거나 대상이 아니면 거짓. 런북 명령 3(OPS-310)이 부른다 */
  async open(commandId: string, nowMs: number): Promise<boolean> {
    return (await this.deps.store.mutate(commandId, (w) => openPostReviewIn(w, nowMs))) ?? false;
  }

  /** 활성 commander 수(identity). 읽지 못하면 ActiveCommandersUnavailable을 던진다 */
  async activeCommanderCount(): Promise<number> {
    if (!this.deps.commanders) throw new ActiveCommandersUnavailable('not-wired');
    return (await this.deps.commanders.list()).length;
  }

  /**
   * 보고서 제출(실행한 commander만).
   * @throws ProblemError 404, 403 post-review-not-executor·command-role-forbidden, 409 post-review-conflict, 422 post-review-invalid
   */
  async submit(q: { commandId: string; body: Record<string, unknown>; actor: PostReviewActor; nowMs: number }): Promise<PostReviewView> {
    if (q.actor.role !== 'commander') throw roleForbidden();
    const command = await this.deps.store.find(q.commandId);
    if (!command) throw notFound();
    if (!isPostReviewType(command.type)) throw conflict('not-post-review-command');
    let report: PostReviewReport;
    try {
      report = postReviewReportOf(command.type, q.body);
    } catch (e) {
      if (e instanceof PostReviewInvalid) throw invalid(e.field);
      throw e;
    }
    const out = await this.deps.store.mutate(q.commandId, async (w) => {
      const pr = w.postReviews;
      const row = await pr?.read();
      if (!pr || !row) return 'NOT_OPEN' as const;
      const executor = await w.requesterOf(0);
      // 실행자 대조: 그 명령을 요청(곧 실행)한 commander의 관리 계정이어야 한다. 대응이 지워졌으면 누구도 실행자로 보지 않는다
      if (!executor?.accountId || executor.ref !== row.executorRef || executor.accountId !== q.actor.accountId) return 'NOT_EXECUTOR' as const;
      if (row.submittedAtMs !== undefined) return 'ALREADY' as const;
      const late = isOverdue(row.dueAtMs, q.nowMs);
      const confirmDueAtMs = q.nowMs + POST_REVIEW_CONFIRM_DUE_MS;
      if (!(await pr.submit({ report, submittedAtMs: q.nowMs, confirmDueAtMs, late }))) return 'ALREADY' as const;
      const ref = await w.actor('ACTOR', w.current.round ?? 0, q.actor.accountId, q.nowMs);
      await w.audit('POST_REVIEW_SUBMITTED', { submitterRef: ref, trigger: report.trigger, late, reportSha256: recordDigest(report), confirmDueAt: iso(confirmDueAtMs) }, q.nowMs);
      await w.event({ type: 'POST_REVIEW_SUBMITTED', actorRef: ref, actorRole: q.actor.role, reason: report.triggerDetail, detail: { trigger: report.trigger, late }, nowMs: q.nowMs });
      return late ? ('LATE' as const) : ('OK' as const);
    });
    if (out === undefined) throw notFound();
    if (out === 'NOT_OPEN') throw conflict('post-review-not-open');
    if (out === 'NOT_EXECUTOR') throw notExecutor();
    if (out === 'ALREADY') throw conflict('already-submitted');
    // 늦게 낸 제출이면 작성 기한 경보를 푼다(검토 기한은 따로 센다)
    if (out === 'LATE') await this.#resolve(q.commandId, POST_REVIEW_OVERDUE_ALERT, 'submitted', q.nowMs);
    return this.get(q.commandId);
  }

  /**
   * 검토(실행자가 아닌 commander, 1인 기간이면 실행자).
   * @throws ProblemError 404, 403 post-review-self-confirm·command-role-forbidden, 409 post-review-conflict, 422 post-review-invalid, 503 admin-account-unavailable
   */
  async confirm(q: { commandId: string; body: Record<string, unknown>; actor: PostReviewActor; nowMs: number }): Promise<PostReviewView> {
    if (q.actor.role !== 'commander') throw roleForbidden();
    let confirmation: { assessment: PostReviewAssessment; comment: string };
    try {
      confirmation = postReviewConfirmationOf(q.body);
    } catch (e) {
      if (e instanceof PostReviewInvalid) throw invalid(e.field);
      throw e;
    }
    const command = await this.deps.store.find(q.commandId);
    if (!command) throw notFound();
    if (!isPostReviewType(command.type)) throw conflict('not-post-review-command');
    // 1인 기간 판정은 실행자가 검토할 때만 묻는다. 묻는 동안 명령 행을 잠그지 않는다(identity 지연이 다른 쓰기를 막지 않게)
    const current = await this.deps.store.postReviewOf?.(q.commandId);
    let solo = false;
    if (current && command.requestedBy !== '' && command.requestedBy === q.actor.accountId) {
      let active: readonly string[];
      try {
        if (!this.deps.commanders) throw new ActiveCommandersUnavailable('not-wired');
        active = await this.deps.commanders.list();
      } catch {
        throw commandersUnavailable();
      }
      if (!(active.length === 1 && active[0] === q.actor.accountId)) throw selfConfirm();
      solo = true;
    }
    const out = await this.deps.store.mutate(q.commandId, async (w) => {
      const pr = w.postReviews;
      const row = await pr?.read();
      if (!pr || !row) return 'NOT_OPEN' as const;
      const executor = await w.requesterOf(0);
      const isExecutor = executor?.accountId !== undefined && executor.accountId === q.actor.accountId;
      // 잠근 뒤 다시 본다: 1인 기간 판정 없이 실행자가 오면 거절한다
      if (isExecutor && !solo) return 'SELF' as const;
      if (row.submittedAtMs === undefined) return 'NOT_SUBMITTED' as const;
      if (row.confirmedAtMs !== undefined) return 'ALREADY' as const;
      const late = row.confirmDueAtMs !== undefined && isOverdue(row.confirmDueAtMs, q.nowMs);
      const reviewerRef = await w.actor('ACTOR', w.current.round ?? 0, q.actor.accountId, q.nowMs);
      const soloSelfReview = isExecutor && solo;
      if (!(await pr.confirm({ reviewerRef, assessment: confirmation.assessment, confirmedAtMs: q.nowMs, soloSelfReview, late }))) return 'ALREADY' as const;
      await w.audit(
        'POST_REVIEW_CONFIRMED',
        { reviewerRef, assessment: confirmation.assessment, late, soloSelfReview, commentSha256: recordDigest(confirmation.comment), ...(soloSelfReview ? { note: '1인 기간 자기 검토' } : {}) },
        q.nowMs,
      );
      await w.event({ type: 'POST_REVIEW_CONFIRMED', actorRef: reviewerRef, actorRole: q.actor.role, reason: confirmation.comment, detail: { assessment: confirmation.assessment, late, soloSelfReview }, nowMs: q.nowMs });
      return late ? ('LATE' as const) : ('OK' as const);
    });
    if (out === undefined) throw notFound();
    if (out === 'NOT_OPEN' || out === 'NOT_SUBMITTED') throw conflict(out === 'NOT_OPEN' ? 'post-review-not-open' : 'not-submitted');
    if (out === 'SELF') throw selfConfirm();
    if (out === 'ALREADY') throw conflict('already-confirmed');
    if (out === 'LATE') await this.#resolve(q.commandId, POST_REVIEW_CONFIRM_OVERDUE_ALERT, 'confirmed', q.nowMs);
    return this.get(q.commandId);
  }

  /** 조회(viewer 이상). 행이 없으면 404 */
  async get(commandId: string): Promise<PostReviewView> {
    const command = await this.deps.store.find(commandId);
    if (!command || !isPostReviewType(command.type)) throw notFound();
    const row = await this.deps.store.postReviewOf?.(commandId);
    if (!row) throw notFound();
    const timeline = (await this.deps.store.timelineOf?.(commandId)) ?? [];
    return this.#view(command, row, timeline);
  }

  async #view(c: Command, row: PostReviewRow, timeline: readonly CommandTimelineEntry[]): Promise<PostReviewView> {
    const first = (type: string) => timeline.find((e) => e.type === type);
    const last = (type: string) => [...timeline].reverse().find((e) => e.type === type);
    const dispatched = first('DISPATCHED');
    const acked = first('ACKED');
    const confirmed = last('POST_REVIEW_CONFIRMED');
    const revertRequested = last('REVERT_REQUESTED');
    const reverted = c.state === 'REVERTED' ? last('REVERTED') : undefined;
    const revertApproved = reverted ? last('REVERT_APPROVED') : undefined;
    const startMs = dispatched?.createdAtMs;
    const endMs = reverted?.createdAtMs;
    const actions = startMs === undefined ? [] : await this.#actionsDuring(c, startMs, endMs);
    const reviewerAccount = confirmed?.actorRef === row.reviewerRef ? confirmed?.actorAccountId : undefined;
    const type = c.type as 'KILL_SWITCH' | 'AUTOMATION_STOP';
    return {
      commandId: c.commandId,
      type: c.type,
      state: c.state,
      reason: c.reason,
      executor: actorOf(c.requestedBy, c.requestedRole),
      dueAt: new Date(row.dueAtMs).toISOString(),
      late: row.late,
      submittedAt: iso(row.submittedAtMs),
      report: row.report ?? null,
      confirmDueAt: iso(row.confirmDueAtMs),
      confirmedAt: iso(row.confirmedAtMs),
      reviewer: row.reviewerRef !== undefined ? actorOf(reviewerAccount, confirmed?.actorRole ?? 'commander') : null,
      assessment: row.assessment ?? null,
      comment: row.confirmedAtMs !== undefined ? (confirmed?.reason ?? null) : null,
      soloSelfReview: row.soloSelfReview,
      execution: { dispatchedAt: iso(startMs), ackedAt: iso(acked?.createdAtMs), attempts: c.attempts },
      actionsDuringStop: actions,
      impact: { stopped: c.state !== 'REVERTED', stopDurationSec: startMs !== undefined && endMs !== undefined ? Math.round((endMs - startMs) / 1000) : null },
      resumption: {
        revertRequestedAt: iso(revertRequested?.createdAtMs),
        revertedAt: iso(endMs),
        requestedBy: revertRequested ? actorOf(revertRequested.actorAccountId, revertRequested.actorRole) : null,
        approvedBy: revertApproved ? actorOf(revertApproved.actorAccountId, revertApproved.actorRole) : null,
      },
      unavailable: [
        { key: 'execution.reauthAt', source: 'ops-db', reason: 'not-recorded' },
        ...UNAVAILABLE_KEYS[type].map((key) => ({ key, source: 'not-wired', reason: SOURCE_NOT_WIRED })),
      ],
    };
  }

  /** 정지부터 재개(아직이면 지금)까지 같은 범위(전체면 모든 명령, 회차면 회차가 겹치는 명령)에서 만든 다른 명령 */
  async #actionsDuring(c: Command, startMs: number, endMs: number | undefined): Promise<PostReviewView['actionsDuringStop']> {
    const platform = c.params.scope === 'PLATFORM' || c.type === 'AUTOMATION_STOP';
    const mine = new Set(eventIdsOf(c));
    const out: { commandId: string; type: string; state: string; createdAt: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const p = await this.deps.store.list({ limit: 100, ...(cursor !== undefined ? { cursor } : {}) });
      for (const x of p.items) {
        if (x.commandId === c.commandId || x.createdAtMs < startMs || (endMs !== undefined && x.createdAtMs > endMs)) continue;
        const ids = [...eventIdsOf(x), ...(x.eventId !== undefined ? [x.eventId.toLowerCase()] : [])];
        if (!platform && !ids.some((id) => mine.has(id))) continue;
        out.push({ commandId: x.commandId, type: x.type, state: x.state, createdAt: new Date(x.createdAtMs).toISOString() });
      }
      const oldest = p.items.at(-1);
      if (!p.nextCursor || (oldest && oldest.createdAtMs < startMs)) break;
      cursor = p.nextCursor;
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async #resolve(commandId: string, kind: string, reason: string, nowMs: number): Promise<void> {
    try {
      await this.deps.alerts?.resolve({ eventKey: commandId, kind, reason, nowMs });
    } catch {
      // 경보 풀기는 제출·검토를 막지 않는다
    }
  }

  /**
   * 정비 한 바퀴: 놓친 할 일 열기와 기한 넘김 경보(SEV3, 명령마다 한 번). 경보를 먼저 열고(같은 명령·종류는 한 건으로 모인다) 그 뒤 표시를 조건부로 적는다.
   * @returns 연 할 일 수, 낸 경보 수
   */
  async maintain(nowMs: number, batch = 50): Promise<{ opened: number; alerted: number }> {
    let opened = 0;
    let alerted = 0;
    for (const id of (await this.deps.store.postReviewsToOpen?.(batch)) ?? []) if (await this.open(id, nowMs)) opened += 1;
    for (const due of (await this.deps.store.postReviewsDue?.(nowMs, batch)) ?? []) if (await this.#alert(due.commandId, due.kind, nowMs)) alerted += 1;
    return { opened, alerted };
  }

  async #alert(commandId: string, kind: PostReviewAlertKind, nowMs: number): Promise<boolean> {
    const row = await this.deps.store.postReviewOf?.(commandId);
    if (!row) return false;
    const dueAtMs = kind === 'DUE' ? row.dueAtMs : row.confirmDueAtMs;
    if (dueAtMs === undefined || !isOverdue(dueAtMs, nowMs)) return false;
    if (this.deps.alerts) {
      await this.deps.alerts.open({
        alertId: randomUUID(),
        eventKey: commandId,
        kind: kind === 'DUE' ? POST_REVIEW_OVERDUE_ALERT : POST_REVIEW_CONFIRM_OVERDUE_ALERT,
        severity: 'SEV3',
        source: 'ops-svc',
        reason: kind === 'DUE' ? '명령 3·11 사후 검토 보고서 작성 기한(48시간)을 넘겼다' : '명령 3·11 사후 검토 보고서 검토 기한(제출 + 7일)을 넘겼다',
        detail: { commandId, dueAt: new Date(dueAtMs).toISOString() },
        nowMs,
      });
    }
    // 경보를 낸 표시만 조건부로 적는다(due_alerted_at·confirm_alerted_at IS NULL). 사건은 더하지 않는다(사후 검토 사건은 OPENED·SUBMITTED·CONFIRMED뿐)
    return (await this.deps.store.mutate(commandId, async (w) => (w.postReviews ? w.postReviews.markAlerted(kind, nowMs) : false))) ?? false;
  }
}
