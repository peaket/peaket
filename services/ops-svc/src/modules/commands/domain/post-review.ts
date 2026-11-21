// 명령 3·11 사후 검토 보고서의 값·기한·검사(ADR-0349 결정 7, docs/features/control-tower.md §6 '사후 검토 보고서의 첫 구현', docs/data.md command_post_review).
// 대상은 승인 없이 실행한 명령 3(KILL_SWITCH)·11(AUTOMATION_STOP)이다. 작성 기한은 처음 DISPATCHED + 48시간, 검토 기한은 제출 + 7일이고 정각이면 넘긴 것이다.
// 보고서 글은 명령 사유와 같은 규칙(앞뒤 공백 지우기, NFC 한 번, 2,000자, 제어 문자·양방향 제어 문자 거절, ADR-0340 결정 10)이되,
// 여러 줄 설명이라 줄바꿈(U+000A)과 탭(U+0009)만 받는다. 상태 쓰기는 명령 행을 잠근 같은 트랜잭션의 PostReviewWriter가 조건부로 한다.
import type { CommandType } from './command.js';

/** 사후 검토 대상 유형(명령 3·11, 늘 승인 없이 1인 실행이다) */
export const POST_REVIEW_TYPES: readonly CommandType[] = ['KILL_SWITCH', 'AUTOMATION_STOP'];
export const isPostReviewType = (type: CommandType): boolean => POST_REVIEW_TYPES.includes(type);

/** 작성 기한: 처음 DISPATCHED + 48시간(정각이면 넘김) */
export const POST_REVIEW_DUE_MS = 48 * 60 * 60_000;
/** 검토 기한: 제출 + 7일(정각이면 넘김) */
export const POST_REVIEW_CONFIRM_DUE_MS = 7 * 24 * 60 * 60_000;
/** 기한 넘김 경보(SEV3, 명령마다 하나) */
export const POST_REVIEW_OVERDUE_ALERT = 'post-review-overdue';
export const POST_REVIEW_CONFIRM_OVERDUE_ALERT = 'post-review-confirm-overdue';
/** 보고서 글 상한(openapi maxLength) */
export const POST_REVIEW_TEXT_MAX = 2000;

/** 기한을 넘겼는가(정각 포함) */
export const isOverdue = (dueAtMs: number, nowMs: number): boolean => nowMs >= dueAtMs;

/** 계기(openapi post-review 본문 trigger). 명령마다 받는 값이 다르다 */
export const KILL_SWITCH_TRIGGERS = ['MONEY_OR_SEAT_SUSPICION', 'PRICE_OR_DISPLAY_ERROR', 'SYSTEM_FAILURE', 'PREVENTIVE_STOP', 'OTHER'] as const;
export const AUTOMATION_STOP_TRIGGERS = ['METRIC_OR_INPUT_ERROR', 'CONTROL_MALFUNCTION', 'MISHANDLED_EXTERNAL_CAUSE', 'PREVENTIVE_STOP', 'OTHER'] as const;
/** 계기 전체(openapi 열거 차례) */
export const POST_REVIEW_TRIGGERS = ['METRIC_OR_INPUT_ERROR', 'CONTROL_MALFUNCTION', 'MISHANDLED_EXTERNAL_CAUSE', 'MONEY_OR_SEAT_SUSPICION', 'PRICE_OR_DISPLAY_ERROR', 'SYSTEM_FAILURE', 'PREVENTIVE_STOP', 'OTHER'] as const;
export type PostReviewTrigger = (typeof POST_REVIEW_TRIGGERS)[number];
export const POST_REVIEW_ASSESSMENTS = ['APPROPRIATE', 'INAPPROPRIATE', 'INCONCLUSIVE'] as const;
export type PostReviewAssessment = (typeof POST_REVIEW_ASSESSMENTS)[number];

export const triggersOf = (type: CommandType): readonly string[] => (type === 'KILL_SWITCH' ? KILL_SWITCH_TRIGGERS : type === 'AUTOMATION_STOP' ? AUTOMATION_STOP_TRIGGERS : []);

export interface PostReviewFollowUp {
  readonly task?: string;
  readonly owner?: string;
  readonly dueDate?: string;
  readonly issueUrl?: string;
}

/** 제출한 보고서(command_post_review.report). 사람 이름 칸은 없다 */
export interface PostReviewReport {
  readonly trigger: PostReviewTrigger;
  readonly triggerDetail: string;
  readonly whyNoSecondApproval?: string;
  readonly actionsNote?: string;
  readonly impactNote?: string;
  readonly followUps: readonly PostReviewFollowUp[];
}

/** 명령마다 한 행(command_post_review) */
export interface PostReviewRow {
  readonly commandId: string;
  /** 실행한 commander의 가명 참조(명령 3·11은 요청한 commander가 실행한다, command_actor로 푼다) */
  readonly executorRef: string;
  readonly dueAtMs: number;
  readonly submittedAtMs?: number;
  readonly report?: PostReviewReport;
  readonly confirmDueAtMs?: number;
  readonly confirmedAtMs?: number;
  /** 검토한 commander의 가명 참조 */
  readonly reviewerRef?: string;
  readonly assessment?: PostReviewAssessment;
  readonly soloSelfReview: boolean;
  /** 기한 뒤 제출 또는 검토 */
  readonly late: boolean;
  readonly dueAlertedAtMs?: number;
  readonly confirmAlertedAtMs?: number;
}

/** 잠근 명령 행 하나의 트랜잭션 안에서 command_post_review를 고친다. 조건부 쓰기는 바꿨으면 참이다 */
export interface PostReviewWriter {
  read(): Promise<PostReviewRow | undefined>;
  /** 처음 DISPATCHED 사건 시각(없으면 undefined) */
  firstDispatchedAtMs(): Promise<number | undefined>;
  /** 행이 없을 때만 넣는다 */
  open(r: { readonly executorRef: string; readonly dueAtMs: number }): Promise<boolean>;
  /** submitted_at IS NULL일 때만 */
  submit(r: { readonly report: PostReviewReport; readonly submittedAtMs: number; readonly confirmDueAtMs: number; readonly late: boolean }): Promise<boolean>;
  /** submitted_at IS NOT NULL AND confirmed_at IS NULL일 때만. late는 제출 때 값과 OR로 합친다 */
  confirm(r: { readonly reviewerRef: string; readonly assessment: PostReviewAssessment; readonly confirmedAtMs: number; readonly soloSelfReview: boolean; readonly late: boolean }): Promise<boolean>;
  /** DUE: 제출 전이고 due_alerted_at IS NULL일 때만, CONFIRM: 제출 뒤 검토 전이고 confirm_alerted_at IS NULL일 때만 */
  markAlerted(kind: PostReviewAlertKind, nowMs: number): Promise<boolean>;
}

export type PostReviewAlertKind = 'DUE' | 'CONFIRM';

/** 보고서·검토 본문 거절(받는 층이 422 post-review-invalid로 바꾼다) */
export class PostReviewInvalid extends Error {
  constructor(readonly field: string) {
    super(`post-review-invalid:${field}`);
    this.name = 'PostReviewInvalid';
  }
}

const CONTROL_EXCEPT_LF_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const BIDI = /[‪-‮⁦-⁩]/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 보고서 글 하나: 앞뒤 공백을 지우고 NFC로 한 번 정규화한 뒤 길이를 본다(ASVS 1.1.1·1.3.3). 비면 required면 거절, 아니면 undefined.
 * @throws PostReviewInvalid
 */
export function postReviewText(raw: unknown, field: string, required: boolean): string | undefined {
  if (raw === undefined || raw === null) {
    if (required) throw new PostReviewInvalid(field);
    return undefined;
  }
  if (typeof raw !== 'string') throw new PostReviewInvalid(field);
  const text = raw.trim().normalize('NFC');
  if (text.length > POST_REVIEW_TEXT_MAX || CONTROL_EXCEPT_LF_TAB.test(text) || BIDI.test(text)) throw new PostReviewInvalid(field);
  if (text.length === 0) {
    if (required) throw new PostReviewInvalid(field);
    return undefined;
  }
  return text;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 제출 본문을 그 명령의 보고서로 바꾼다. 계기가 그 명령의 값이 아니면, 명령 11인데 2인 승인을 기다리지 않은 이유가 없으면 거절한다.
 * @throws PostReviewInvalid
 */
export function postReviewReportOf(type: CommandType, body: Record<string, unknown>): PostReviewReport {
  if (typeof body.trigger !== 'string' || !triggersOf(type).includes(body.trigger)) throw new PostReviewInvalid('trigger');
  const triggerDetail = postReviewText(body.triggerDetail, 'triggerDetail', true)!;
  const whyNoSecondApproval = postReviewText(body.whyNoSecondApproval, 'whyNoSecondApproval', type === 'AUTOMATION_STOP');
  const actionsNote = postReviewText(body.actionsNote, 'actionsNote', false);
  const impactNote = postReviewText(body.impactNote, 'impactNote', false);
  const rawFollowUps = body.followUps ?? [];
  if (!Array.isArray(rawFollowUps)) throw new PostReviewInvalid('followUps');
  const followUps = rawFollowUps.map((f, i): PostReviewFollowUp => {
    if (!isObject(f)) throw new PostReviewInvalid(`followUps.${i}`);
    const task = postReviewText(f.task, `followUps.${i}.task`, false);
    const owner = postReviewText(f.owner, `followUps.${i}.owner`, false);
    if (f.dueDate !== undefined && (typeof f.dueDate !== 'string' || !DATE.test(f.dueDate) || !Number.isFinite(Date.parse(`${f.dueDate}T00:00:00Z`)))) throw new PostReviewInvalid(`followUps.${i}.dueDate`);
    let issueUrl: string | undefined;
    if (f.issueUrl !== undefined) {
      if (typeof f.issueUrl !== 'string' || f.issueUrl.length > POST_REVIEW_TEXT_MAX) throw new PostReviewInvalid(`followUps.${i}.issueUrl`);
      let url: URL;
      try {
        url = new URL(f.issueUrl);
      } catch {
        throw new PostReviewInvalid(`followUps.${i}.issueUrl`);
      }
      // 링크는 https만(관제 화면이 그대로 걸 수 있는 값, javascript: 등 거절)
      if (url.protocol !== 'https:') throw new PostReviewInvalid(`followUps.${i}.issueUrl`);
      issueUrl = f.issueUrl;
    }
    return { ...(task !== undefined ? { task } : {}), ...(owner !== undefined ? { owner } : {}), ...(typeof f.dueDate === 'string' ? { dueDate: f.dueDate } : {}), ...(issueUrl !== undefined ? { issueUrl } : {}) };
  });
  return {
    trigger: body.trigger as PostReviewTrigger,
    triggerDetail,
    ...(whyNoSecondApproval !== undefined ? { whyNoSecondApproval } : {}),
    ...(actionsNote !== undefined ? { actionsNote } : {}),
    ...(impactNote !== undefined ? { impactNote } : {}),
    followUps,
  };
}

/** 검토 본문(assessment·comment). comment는 1~2,000자 */
export function postReviewConfirmationOf(body: Record<string, unknown>): { assessment: PostReviewAssessment; comment: string } {
  if (typeof body.assessment !== 'string' || !POST_REVIEW_ASSESSMENTS.includes(body.assessment as PostReviewAssessment)) throw new PostReviewInvalid('assessment');
  const comment = postReviewText(body.comment, 'comment', true)!;
  return { assessment: body.assessment as PostReviewAssessment, comment };
}
