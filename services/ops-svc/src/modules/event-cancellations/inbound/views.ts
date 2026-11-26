// 받는 층 공용: 회차 취소 응답의 직렬화 스키마와 도메인 문제를 Problem으로 바꾸는 함수(BAT-420 GAT-110).
// 응답 스키마에 없는 칸은 내보내지 않으므로(platform contractRouteSchema) 미리보기·진행률 칸을 여기서 다 적는다.
import { ProblemError } from '@peaket/platform';
import { z } from 'zod';
import { EventCancellationProblem } from '../domain/event-cancellation.js';

const PGS = ['TOSS', 'PORTONE', 'SIMULATOR'] as const;
export const FAULTS = ['ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE'] as const;
export const KINDS = ['CANCEL', 'POSTPONE'] as const;
export const STATUSES = ['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED', 'REJECTED'] as const;

const DryRun = z.object({
  targetOrders: z.number().int(),
  refundTotal: z.number().int(),
  compensationTargets: z.number().int(),
  compensationTotal: z.number().int(),
  perPg: z.array(z.object({ pg: z.enum(PGS), orders: z.number().int(), estimatedSeconds: z.number().int() })),
});
const Progress = z.object({
  state: z.string(),
  total: z.number().int().optional(),
  done: z.number().int().optional(),
  failed: z.number().int().optional(),
  /** 가상계좌 계좌 대기 항목 수(있을 때만, BAT-420-rest 리뷰 반영 RV-05, R-T40 ⑤) */
  accountPending: z.number().int().optional(),
  perPg: z
    .array(
      z.object({
        pg: z.enum(PGS),
        state: z.string(),
        pauseReason: z.string().nullable().optional(),
        done: z.number().int(),
        failed: z.number().int(),
        unknown: z.number().int(),
        /** 최근 5분 재개 조건(F-07-15 I-06). 서킷을 읽지 못하면 circuitState null·CIRCUIT_UNAVAILABLE */
        resume: z
          .object({
            circuitState: z.enum(['closed', 'half_open', 'open']).nullable(),
            calls: z.number().int().min(0),
            failures: z.number().int().min(0),
            failureRateBp: z.number().int().min(0).nullable(),
            windowSeconds: z.literal(300),
            state: z.enum(['ELIGIBLE', 'NO_SAMPLE', 'FAILURE_RATE_HIGH', 'CIRCUIT_OPEN', 'CIRCUIT_UNAVAILABLE']),
          })
          .optional(),
      }),
    )
    .optional(),
});

/** 관제·파트너 요청 응답(openapi EventCancellationRequest의 몫). 목록 항목은 dryRun·perPg를 싣지 않는다 */
export const View = z
  .object({
    requestId: z.string(),
    eventId: z.string(),
    title: z.string().optional(),
    kind: z.enum(KINDS),
    status: z.enum(STATUSES),
    reason: z.string(),
    partnerReason: z.string().nullable(),
    faultOpinion: z.enum(FAULTS).nullable(),
    evidenceRef: z.string().nullable(),
    newStartsAt: z.string().nullable(),
    fault: z.enum(FAULTS).optional(),
    fanNoticeReason: z.string().optional(),
    requestedAt: z.string(),
    // openapi OpsActor(판정자). 표시 이름은 계정 읽기 계약이 없어 null이다
    judgedBy: z.object({ adminAccountId: z.string(), displayName: z.string().nullable(), role: z.string() }).optional(),
    dryRun: DryRun.optional(),
    progress: Progress.optional(),
  })
  .passthrough();
export const Page = z.object({ items: z.array(View), nextCursor: z.string().nullable() });

/** 파트너가 보는 상태(openapi PartnerEventCancellationStatus). 미리보기·결제사별 몫·판정자·내부 판정 사유 칸이 없다 */
export const PartnerStatus = z.object({
  requestId: z.string(),
  eventId: z.string(),
  kind: z.enum(KINDS),
  status: z.enum(STATUSES),
  requestedAt: z.string(),
  reason: z.string().nullable(),
  evidenceRef: z.string().nullable(),
  faultOpinion: z.enum(FAULTS).nullable(),
  newStartsAt: z.string().nullable(),
  judgementDueAt: z.string().nullable(),
  fault: z.enum(FAULTS).nullable(),
  judgementSummary: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  refundProgress: z.object({ total: z.number().int(), done: z.number().int(), failed: z.number().int() }).nullable(),
  pausedBy: z.enum(['AUTOMATIC', 'OPERATOR']).nullable(),
  postponement: z.object({ refundApplicationCount: z.number().int(), refundDeadlineAt: z.string() }).nullable(),
  // 배상 대상 수·합계(확정 뒤 미리보기의 값, 개인 명단 없음, d5 §6.12 ④ '배상 대상 수·합계')
  compensation: z.object({ targetCount: z.number().int(), totalAmount: z.number().int() }).nullable(),
});

/** 도메인 문제는 Problem으로(확장 칸 requestId 등을 싣는다), 그 밖은 그대로 던진다 */
export const fail = (err: unknown): never => {
  if (err instanceof EventCancellationProblem) {
    throw new ProblemError({ type: err.type, status: err.status, title: err.title, ...(err.extensions ? { extensions: { ...err.extensions } } : {}) });
  }
  throw err;
};
