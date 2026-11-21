// 받는 층: 명령 3·11 사후 검토 보고서 제출·검토·조회(openapi /v1/ops/commands/{commandId}/post-review·post-review-confirmation, ADR-0349 결정 7).
// 제출·검토는 commander, 조회는 viewer 이상이다. 본문 꼴은 계약 그대로 닫고(모르는 칸 400), 글의 NFC 정규화·2,000자·제어 문자 검사와 계기·이유 검사는
// 도메인이 해서 422 post-review-invalid다(ASVS 1.1.1: 정규화를 길이 검사보다 먼저 한 번만). 403마다 보안 사건 로그 한 줄을 남긴다(ASVS 16.3.2).
import { Controller, Get, Header, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { CLOCK, type Clock, ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { PostReviews } from '../application/post-review.js';
import { POST_REVIEW_ASSESSMENTS, POST_REVIEW_TRIGGERS } from '../domain/post-review.js';
import { noCommandSecurityEvents, type CommandSecurityEvents } from '../domain/ports.js';
import { COMMAND_SECURITY_EVENTS } from '../tokens.js';
import { CommandIdParams } from './command-view.js';

/** 글 칸의 날것 상한(정규화 전, 본문 크기 막이). 정규화한 뒤 2,000자는 도메인이 422로 본다 */
const RAW_TEXT_MAX = 8000;
const text = z.string().max(RAW_TEXT_MAX);

export const PostReviewBody = z
  .object({
    trigger: z.enum(POST_REVIEW_TRIGGERS),
    triggerDetail: text,
    whyNoSecondApproval: text.optional(),
    actionsNote: text.optional(),
    impactNote: text.optional(),
    followUps: z
      .array(z.object({ task: text.optional(), owner: text.optional(), dueDate: z.string().max(10).optional(), issueUrl: z.string().max(RAW_TEXT_MAX).optional() }).strict())
      .max(50)
      .optional(),
  })
  .strict();
export const PostReviewConfirmationBody = z.object({ assessment: z.enum(POST_REVIEW_ASSESSMENTS), comment: text }).strict();

const ActorView = z.object({ adminAccountId: z.string().optional(), displayName: z.string().nullable(), role: z.string() });
const ReportView = z.object({
  trigger: z.string(),
  triggerDetail: z.string(),
  whyNoSecondApproval: z.string().optional(),
  actionsNote: z.string().optional(),
  impactNote: z.string().optional(),
  followUps: z.array(z.object({ task: z.string().optional(), owner: z.string().optional(), dueDate: z.string().optional(), issueUrl: z.string().optional() })),
});
export const PostReviewView = z.object({
  commandId: z.string(),
  type: z.string(),
  state: z.string(),
  reason: z.string(),
  executor: ActorView,
  dueAt: z.string(),
  late: z.boolean(),
  submittedAt: z.string().nullable(),
  report: ReportView.nullable(),
  confirmDueAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  reviewer: ActorView.nullable(),
  assessment: z.enum(POST_REVIEW_ASSESSMENTS).nullable(),
  comment: z.string().nullable(),
  soloSelfReview: z.boolean(),
  execution: z.object({ dispatchedAt: z.string().nullable(), ackedAt: z.string().nullable(), attempts: z.number() }),
  actionsDuringStop: z.array(z.object({ commandId: z.string(), type: z.string(), state: z.string(), createdAt: z.string() })),
  impact: z.object({ stopped: z.boolean(), stopDurationSec: z.number().nullable() }),
  resumption: z.object({ revertRequestedAt: z.string().nullable(), revertedAt: z.string().nullable(), requestedBy: ActorView.nullable(), approvedBy: ActorView.nullable() }),
  unavailable: z.array(z.object({ key: z.string(), source: z.string(), reason: z.string() })),
});

@Controller('v1/ops/commands')
export class PostReviewController {
  readonly #security: CommandSecurityEvents;

  constructor(
    private readonly reviews: PostReviews,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(COMMAND_SECURITY_EVENTS) security?: CommandSecurityEvents,
  ) {
    this.#security = security ?? noCommandSecurityEvents;
  }

  async #guarded<T>(action: string, me: Principal, commandId: string, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ProblemError && e.status === 403) this.#security.authzDenied({ commandId, role: me.role ?? 'unknown', reason: e.slug, action });
      throw e;
    }
  }

  @Post(':commandId/post-review')
  @HttpCode(201)
  @Roles(['commander'])
  @ContractRouteSchema({ params: CommandIdParams, body: PostReviewBody, responses: { 201: PostReviewView } })
  async submit(
    @ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>,
    @ContractBody(PostReviewBody) body: z.output<typeof PostReviewBody>,
    @CurrentPrincipal() me: Principal,
  ): Promise<z.output<typeof PostReviewView>> {
    return this.#guarded('post-review', me, params.commandId, async () =>
      this.reviews.submit({ commandId: params.commandId, body, actor: { accountId: me.accountId, role: me.role ?? 'viewer' }, nowMs: this.clock.now() }),
    ) as Promise<z.output<typeof PostReviewView>>;
  }

  @Post(':commandId/post-review-confirmation')
  @HttpCode(200)
  @Roles(['commander'])
  @ContractRouteSchema({ params: CommandIdParams, body: PostReviewConfirmationBody, responses: { 200: PostReviewView } })
  async confirm(
    @ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>,
    @ContractBody(PostReviewConfirmationBody) body: z.output<typeof PostReviewConfirmationBody>,
    @CurrentPrincipal() me: Principal,
  ): Promise<z.output<typeof PostReviewView>> {
    return this.#guarded('post-review-confirmation', me, params.commandId, async () =>
      this.reviews.confirm({ commandId: params.commandId, body, actor: { accountId: me.accountId, role: me.role ?? 'viewer' }, nowMs: this.clock.now() }),
    ) as Promise<z.output<typeof PostReviewView>>;
  }

  @Get(':commandId/post-review')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ params: CommandIdParams, responses: { 200: PostReviewView } })
  async get(@ContractParams(CommandIdParams) params: z.output<typeof CommandIdParams>): Promise<z.output<typeof PostReviewView>> {
    return (await this.reviews.get(params.commandId)) as z.output<typeof PostReviewView>;
  }
}
