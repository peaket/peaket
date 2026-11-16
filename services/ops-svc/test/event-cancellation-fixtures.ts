// 회차 취소 요청 단위 시험 공용 대역(BAT-420 GAT-110). 정본 값은 시험마다 글자로 적고, 여기는 대역과 흐름 도우미만 둔다.
import { createHash, randomUUID } from 'node:crypto';
import type { IdempotencyRequest } from '@peaket/platform';
import { expect } from 'vitest';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  EventCancellationProblem,
  EventCancellations,
  EventRefundHoldConflict,
  MemoryEventCancellationStore,
  type EventCancellationCases,
  type EventCancellationDryRun,
  type EventCancellationReauth,
  type EventCancellationRecord,
  type EventOwnerLookup,
  type EventRefundHolds,
  type EventRefundJobProgress,
  type EventRefundReader,
  type EventRefundStartInput,
  type EventRefundStarter,
  type EventSaleStopper,
  type OpsActor,
  type SaleSuspensionLookup,
} from '../src/modules/event-cancellations/index.js';

export const NOW = Date.parse('2026-11-16T01:00:00.000Z');
export const EVENT = '0194b000-0000-7000-8000-000000000001';
export const COMMANDER_A: OpsActor = { accountId: '0194b000-0000-7000-8000-0000000000a1', sessionId: 's-a', role: 'commander' };
export const OPERATOR_B: OpsActor = { accountId: '0194b000-0000-7000-8000-0000000000b2', sessionId: 's-b', role: 'operator' };
export const COMMANDER_C: OpsActor = { accountId: '0194b000-0000-7000-8000-0000000000c3', sessionId: 's-c', role: 'commander' };
export const TENANT = '0194b000-0000-7000-8000-00000000f001';
export const OTHER_TENANT = '0194b000-0000-7000-8000-00000000f002';
export const PARTNER_ADMIN = { accountId: '0194b000-0000-7000-8000-0000000000d4', sessionId: 's-d', role: 'partner_admin', tenantId: TENANT };

/** 재인증 토큰 대역: `${act}:${accountId}:${factors를 +로 이은 것}` */
export const tokenFor = (accountId: string, o: { act?: string; factors?: readonly string[] } = {}): string => `${o.act ?? 'APPROVAL'}:${accountId}:${(o.factors ?? ['passkey']).join('+')}`;

/** identity 재인증 검증기 대역. 토큰이 없거나 동작이 다르면 403, 그 밖은 토큰에 적힌 계정·요소를 돌려준다 */
export const fakeReauth = (calls: string[] = []): EventCancellationReauth => ({
  verify: async (token, o) => {
    calls.push(`verify:${o.act}:${o.sessionId}`);
    if (token === undefined) throw new EventCancellationProblem('reauth-required', 403, '다시 인증해 주세요');
    const [act, accountId, factors] = token.split(':');
    if (act !== o.act) throw new EventCancellationProblem('reauth-required', 403, '다시 인증해 주세요');
    return { accountId: accountId ?? '', factors: (factors ?? '').split('+').filter((x) => x !== '') };
  },
});

/** 멱등 요청 값(platform IdempotencyRequest). 같은 body 글이면 같은 지문이다 */
export const idemOf = (accountRef: string, key: string = randomUUID(), body = 'same-body', operation = 'CREATE_EVENT_CANCELLATION'): IdempotencyRequest => ({
  accountRef,
  operation,
  key,
  requestHash: new Uint8Array(createHash('sha256').update(body).digest()),
});

/** EventCancellationProblem(type = 이름)과 ProblemError(type = URI) 둘 다 맞는 조건 */
export const problem = (slug: string, status: number, extensions?: Record<string, unknown>) => ({
  status,
  type: expect.stringMatching(new RegExp(`(^|/)${slug}$`)),
  ...(extensions ? { extensions: expect.objectContaining(extensions) } : {}),
});

/** 정본 R-T37 ①의 회차: 표 둘인 주문(TOSS)과 표 하나인 주문 둘(PORTONE), 권면 33,333원 */
export const DRY_RUN: EventCancellationDryRun = {
  targetOrders: 3,
  refundTotal: 133_332,
  compensationTargets: 3,
  compensationTotal: 13_335,
  perPg: [
    { pg: 'TOSS', orders: 1, estimatedSeconds: 1 },
    { pg: 'PORTONE', orders: 2, estimatedSeconds: 1 },
  ],
};

/** 진행률 대역(값을 서로 다르게 골라 칸이 바뀌면 드러나게 한다) */
export const JOB: EventRefundJobProgress = {
  state: 'RUNNING',
  total: 30,
  done: 8,
  failed: 5,
  perPg: [
    { pg: 'TOSS', state: 'RUNNING', done: 5, failed: 1, unknown: 2 },
    { pg: 'PORTONE', state: 'PAUSED', pauseReason: 'MANUAL', done: 3, failed: 4, unknown: 6 },
  ],
};

export const recordOf = (over: Partial<EventCancellationRecord> = {}): EventCancellationRecord => ({
  requestId: randomUUID(),
  eventId: EVENT,
  kind: 'CANCEL',
  status: 'REQUESTED',
  reason: '공연 취소',
  requestedBy: COMMANDER_A.accountId,
  requestedAt: new Date(NOW - 60_000),
  fault: null,
  judgementReason: null,
  fanNoticeReason: null,
  judgedBy: null,
  judgedAt: null,
  approvedBy: null,
  approvedAt: null,
  refundJobState: null,
  version: 1,
  updatedAt: new Date(NOW - 60_000),
  requestedVia: 'COMMANDER',
  promoterId: null,
  faultOpinion: null,
  evidenceRef: null,
  newStartsAt: null,
  dryRun: null,
  rejectionReason: null,
  ...over,
});

type Dep = 'refunds' | 'reader' | 'stopper' | 'owners' | 'cases' | 'suspension' | 'holds';

export interface FixtureOptions {
  /** null이면 재인증 검증기를 조립하지 않는다 */
  readonly reauth?: EventCancellationReauth | null;
  /** 빼고 조립할 의존 */
  readonly without?: readonly Dep[];
  /** 판매 중지 확인을 이 대역으로 바꾼다(메모리 명령 기록을 읽는 어댑터 시험) */
  readonly suspension?: SaleSuspensionLookup;
}

export type OwnerAnswer = { promoterId: string; startsAtMs: number; endsAtMs?: number } | 'throw';

export function fixture(o: FixtureOptions = {}) {
  const clock = { now: NOW };
  const audit = new MemoryAuditChain();
  const store = new MemoryEventCancellationStore(audit);
  const log: string[] = [];
  const previewCalls: Array<{ eventId: string; requestId: string; fault: string }> = [];
  const stopCalls: Array<{ eventId: string; requestId: string }> = [];
  const startCalls: EventRefundStartInput[] = [];
  const jobCalls: string[] = [];
  const caseCalls: Array<{ requestId: string; nowMs: number }> = [];
  const suspensionCalls: string[] = [];
  const ownerCalls: string[] = [];
  /** BAT-420 몫 D: purchase-svc SetEventRefundHold 호출(차례대로) */
  const holdCalls: Array<{ eventId: string; requestId: string; held: boolean; expiresAtMs?: number }> = [];
  /** 회차 취소 모듈이 남긴 경고 로그(BAT-420 몫 D 보충 2: event-refund-hold-conflict 등) */
  const warns: Array<{ obj: object; msg: string }> = [];
  const behaviour = {
    holdFails: false,
    releaseFails: false,
    /** 걸기가 ALREADY_EXISTS(어댑터가 EventRefundHoldConflict로 던짐)로 끝난다 */
    holdConflict: false,
    /** 걸기 직전에 부른다(그사이 다른 요청이 저장된 차례를 만든다) */
    onHold: undefined as ((q: { eventId: string; requestId: string; held: boolean }) => Promise<void>) | undefined,
    /** 미룸을 거는 순간 그 회차의 요청 행이 저장소에 있었는가(요청 저장 전에 거는지 본다) */
    rowsWhenHeld: [] as number[],
    previewFails: false,
    stopFails: false,
    startFails: false,
    jobFails: false,
    casesFail: false,
    dryRun: DRY_RUN,
    job: JOB,
    suspended: new Set<string>(),
    owners: new Map<string, OwnerAnswer>(),
  };
  const refunds: EventRefundStarter = {
    start: async (i) => {
      log.push(`start:${i.requestId}`);
      startCalls.push(i);
      if (behaviour.startFails) throw new Error('purchase down');
      return { jobId: i.requestId, state: i.kind === 'POSTPONE' ? 'REFUND_WINDOW' : 'RUNNING' };
    },
    pause: async (i) => {
      log.push(`pause:${i.requestId}:${i.pg ?? 'ALL'}`);
      return { jobId: i.requestId, state: 'PAUSED' };
    },
    resume: async (i) => {
      log.push(`resume:${i.requestId}:${i.pg ?? 'ALL'}`);
      return { jobId: i.requestId, state: 'RUNNING' };
    },
  };
  const reader: EventRefundReader = {
    preview: async (q) => {
      log.push(`preview:${q.requestId}`);
      previewCalls.push({ ...q });
      if (behaviour.previewFails) throw new Error('preview down');
      return behaviour.dryRun;
    },
    job: async (q) => {
      log.push(`job:${q.requestId}`);
      jobCalls.push(q.requestId);
      if (behaviour.jobFails) throw new Error('job down');
      return behaviour.job;
    },
  };
  const stopper: EventSaleStopper = {
    stop: async (q) => {
      log.push(`stop:${q.requestId}`);
      stopCalls.push({ ...q });
      if (behaviour.stopFails) throw new Error('sale stop down');
    },
  };
  const suspension: SaleSuspensionLookup = {
    isSuspended: async (eventId) => {
      suspensionCalls.push(eventId);
      return behaviour.suspended.has(eventId);
    },
  };
  const owners: EventOwnerLookup = {
    find: async (eventId) => {
      ownerCalls.push(eventId);
      const v = behaviour.owners.get(eventId);
      if (v === 'throw') throw new Error('core down');
      return v;
    },
  };
  const cases: EventCancellationCases = {
    judgementPending: async (requestId, nowMs) => {
      caseCalls.push({ requestId, nowMs });
      if (behaviour.casesFail) throw new Error('cs down');
    },
  };
  const holds: EventRefundHolds = {
    hold: async (q) => {
      log.push(`hold:${q.held ? 'on' : 'off'}:${q.requestId}`);
      holdCalls.push({ ...q });
      if (q.held) behaviour.rowsWhenHeld.push([...store.rows.values()].filter((r) => r.eventId === q.eventId && r.requestId === q.requestId).length);
      if (behaviour.onHold) await behaviour.onHold(q);
      if (q.held && behaviour.holdFails) throw new Error('purchase-svc 14 UNAVAILABLE');
      if (q.held && behaviour.holdConflict) throw new EventRefundHoldConflict();
      if (!q.held && behaviour.releaseFails) throw new Error('purchase-svc 4 DEADLINE_EXCEEDED');
      return { held: q.held };
    },
  };
  const without = new Set(o.without ?? []);
  const reauth = o.reauth === null ? undefined : (o.reauth ?? fakeReauth(log));
  const app = new EventCancellations(store, without.has('refunds') ? undefined : refunds, () => clock.now, audit, reauth, {
    ...(without.has('suspension') ? {} : { suspension: o.suspension ?? suspension }),
    ...(without.has('stopper') ? {} : { stopper }),
    ...(without.has('reader') ? {} : { reader }),
    ...(without.has('owners') ? {} : { owners }),
    ...(without.has('cases') ? {} : { cases }),
    ...(without.has('holds') ? {} : { holds }),
    log: { warn: (obj: object, msg: string) => void warns.push({ obj, msg }) },
  });
  return { app, store, audit, log, warns, previewCalls, stopCalls, startCalls, jobCalls, caseCalls, suspensionCalls, ownerCalls, holdCalls, behaviour, clock };
}

export type Fixture = ReturnType<typeof fixture>;

/** 판매 중지된 회차에 commander가 재인증·멱등 키와 함께 요청한다 */
export async function requested(f: Fixture, eventId: string = EVENT, actor: OpsActor = COMMANDER_A) {
  f.behaviour.suspended.add(eventId);
  return f.app.request({ eventId, reason: '공연 취소' }, actor, tokenFor(actor.accountId), idemOf(actor.accountId));
}

export const JUDGEMENT = { fault: 'ORGANIZER', reason: '주최 측 귀책', fanNoticeReason: '공연이 취소되었습니다' } as const;

/** 요청 → 판정(미리보기 포함)까지. 상태는 PENDING_APPROVAL이어야 한다 */
export async function pendingApproval(f: Fixture, eventId: string = EVENT, judge: OpsActor = COMMANDER_A): Promise<string> {
  const r = await requested(f, eventId, judge);
  await f.app.judge(r.requestId, { ...JUDGEMENT }, judge);
  return r.requestId;
}

export const approveBy = (f: Fixture, requestId: string, actor: OpsActor = OPERATOR_B) => f.app.approve(requestId, actor, tokenFor(actor.accountId));

/** 파트너 소속 회차 하나를 판매 설정 대역에 둔다 */
export function ownEvent(f: Fixture, o: { eventId?: string; promoterId?: string; startsAtMs?: number; endsAtMs?: number } = {}): string {
  const eventId = o.eventId ?? randomUUID();
  const startsAtMs = o.startsAtMs ?? NOW + 10 * 86_400_000;
  f.behaviour.owners.set(eventId, { promoterId: o.promoterId ?? TENANT, startsAtMs, ...(o.endsAtMs !== undefined ? { endsAtMs: o.endsAtMs } : { endsAtMs: startsAtMs + 3 * 3_600_000 }) });
  return eventId;
}

/** BAT-420 몫 D: 늘 받는 SetEventRefundHold 대역(미룸을 보지 않는 다른 시험용). 호출은 calls에 남긴다 */
export const okHolds = (calls: string[] = []): EventRefundHolds => ({
  hold: async (q) => {
    calls.push(`hold:${q.held ? 'on' : 'off'}:${q.requestId}`);
    return { held: q.held };
  },
});
