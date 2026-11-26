// core-svc support 화면용 사본 gRPC 두 서비스(F-06-4, core.proto).
// 부르는 쪽은 ops-svc만이고 내부 토큰·x-peaket-caller로 확인한다. 판이 클 때만 쓴다.
import * as grpc from '@grpc/grpc-js';
import { constantTimeEqual } from '@peaket/platform';
import type { FraudAppealViewRow, RestrictionViewRow } from '../domain/appeal.js';
import { redactFraudView } from '../domain/appeal.js';
import type { FraudAppealViewStore, RestrictionViewStore } from '../domain/ports.js';
import type { Metadata } from '@grpc/grpc-js';

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ts = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object') return Number.NaN;
  const o = v as { seconds?: unknown; nanos?: unknown };
  const seconds = typeof o.seconds === 'number' ? o.seconds : Number(o.seconds);
  const nanos = o.nanos === undefined ? 0 : typeof o.nanos === 'number' ? o.nanos : Number(o.nanos);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1_000_000_000) return Number.NaN;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const timestamp = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
const VIEW_STATE = new Set(['BOOKING_RESTRICTION_VIEW_STATE_ACTIVE', 'BOOKING_RESTRICTION_VIEW_STATE_LIFTED']);
const FRAUD_STATE = new Set(['FRAUD_APPEAL_VIEW_STATE_OPEN', 'FRAUD_APPEAL_VIEW_STATE_SUBMITTED', 'FRAUD_APPEAL_VIEW_STATE_ACCEPTED', 'FRAUD_APPEAL_VIEW_STATE_REJECTED', 'FRAUD_APPEAL_VIEW_STATE_EXPIRED']);
const stateOfView = (s: string): 'ACTIVE' | 'LIFTED' => (s.endsWith('_LIFTED') ? 'LIFTED' : 'ACTIVE');
const stateOfFraud = (s: string): FraudAppealViewRow['state'] => {
  if (s.endsWith('_SUBMITTED')) return 'SUBMITTED';
  if (s.endsWith('_ACCEPTED')) return 'ACCEPTED';
  if (s.endsWith('_REJECTED')) return 'REJECTED';
  if (s.endsWith('_EXPIRED')) return 'EXPIRED';
  return 'OPEN';
};
const denied = (cb: grpc.sendUnaryData<object>) => cb({ code: grpc.status.PERMISSION_DENIED, details: '내부 호출자만' });
/** 이 기능의 gRPC 사본 계약은 HTTP와 같은 이름의 내부 토큰·호출자 머리를 쓴다(F-06-4 시험 고정) */
const allowed = (metadata: Metadata, token: string | undefined): boolean => {
  if (metadata.get('x-peaket-caller')[0] !== 'ops-svc') return false;
  if (token === undefined) return true;
  const got = metadata.get('x-peaket-internal-token')[0];
  return typeof got === 'string' && constantTimeEqual(got, token);
};

export interface SupportGrpcOptions {
  readonly restrictionViews: RestrictionViewStore;
  readonly fraudViews: FraudAppealViewStore;
  readonly internalToken?: string;
}

export function supportGrpcHandlers(o: SupportGrpcOptions): grpc.UntypedServiceImplementation {
  const SetBookingRestrictionView: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    if (!allowed(call.metadata, o.internalToken)) return denied(cb);
    const r = call.request;
    const accountId = text(r.account_id);
    const restrictionId = text(r.restriction_id);
    const state = text(r.state);
    const reasonCode = text(r.reason_code);
    const version = int(r.version);
    const startsAtMs = ts(r.starts_at);
    const endsAtMs = ts(r.ends_at);
    const appealDueAtMs = ts(r.appeal_due_at);
    if (!uuid.test(accountId) || !uuid.test(restrictionId) || !VIEW_STATE.has(state) || !reasonCode || !Number.isSafeInteger(version) || version < 0) return cb({ code: grpc.status.INVALID_ARGUMENT, details: '요청 모양' });
    if (startsAtMs === undefined || !Number.isSafeInteger(startsAtMs) || appealDueAtMs === undefined || !Number.isSafeInteger(appealDueAtMs)) return cb({ code: grpc.status.INVALID_ARGUMENT, details: '시각' });
    if (endsAtMs !== undefined && !Number.isSafeInteger(endsAtMs)) return cb({ code: grpc.status.INVALID_ARGUMENT, details: '시각' });
    // 판 0은 '모르는 판'이라 아무것도 바꾸지 않는다(TR-07 작은 판)
    if (version === 0) return cb(null, { changed: false });
    o.restrictionViews
      .apply({ accountId, restrictionId, state: stateOfView(state), reasonCode, startsAtMs, endsAtMs: endsAtMs ?? null, appealDueAtMs, version })
      .then((x) => cb(null, { changed: x.changed }), () => cb({ code: grpc.status.INTERNAL, details: '저장 실패' }));
  };
  const SetFraudAppealView: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    if (!allowed(call.metadata, o.internalToken)) return denied(cb);
    const r = call.request;
    const accountId = text(r.account_id);
    const caseId = text(r.case_id);
    const eventId = text(r.event_id);
    const state = text(r.state);
    const version = int(r.version);
    const party = text(r.party) || 'PAYER';
    const dueAtMs = ts(r.due_at);
    if (!uuid.test(accountId) || !uuid.test(caseId) || !eventId || !FRAUD_STATE.has(state) || !Number.isSafeInteger(version) || version < 1) return cb({ code: grpc.status.INVALID_ARGUMENT, details: '요청 모양' });
    if (party !== 'PAYER' && party !== 'HOLDER') return cb({ code: grpc.status.INVALID_ARGUMENT, details: 'party' });
    if (dueAtMs === undefined || !Number.isSafeInteger(dueAtMs)) return cb({ code: grpc.status.INVALID_ARGUMENT, details: '기한' });
    const priority = Array.isArray(r.priority_purchases)
      ? (r.priority_purchases as Record<string, unknown>[]).map((p) => ({
          grantId: text(p.grant_id),
          seatLabel: text(p.seat_label),
          price: int(p.price) || 0,
          expiresAtMs: ts(p.expires_at) ?? 0,
          status: text(p.status),
        }))
      : [];
    const view: FraudAppealViewRow = {
      accountId,
      caseId,
      eventId,
      party,
      reasonCategories: list(r.reason_categories),
      dueAtMs,
      heldTicketIds: list(r.held_ticket_ids),
      excludedTicketIds: list(r.excluded_ticket_ids),
      lockedTicketIds: list(r.locked_ticket_ids),
      state: stateOfFraud(state),
      version,
      objectionDueAtMs: ts(r.objection_due_at) ?? null,
      objectionStatus: text(r.objection_state) === 'SUBMITTED' || text(r.objection_state) === 'ACCEPTED' || text(r.objection_state) === 'REJECTED' ? (text(r.objection_state) as 'SUBMITTED' | 'ACCEPTED' | 'REJECTED') : 'NONE',
      objectionNote: text(r.objection_note) || null,
      cancelledTicketIds: list(r.cancelled_ticket_ids),
      restrictedUntilMs: ts(r.restricted_until) ?? null,
      lockExpiresAtMs: ts(r.lock_expires_at) ?? null,
      lockActive: r.lock_active === true,
      priorityPurchases: priority,
      actionResult: null,
    };
    o.fraudViews.apply(redactFraudView(view)).then((x) => cb(null, { changed: x.changed }), () => cb({ code: grpc.status.INTERNAL, details: '저장 실패' }));
  };
  return { SetBookingRestrictionView, SetFraudAppealView };
}

export { timestamp };
