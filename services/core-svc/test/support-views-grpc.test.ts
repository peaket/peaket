// F-06-4 core-svc 화면용 사본 gRPC 두 서비스 시험(시험 담당 lane2-freeze-F-06-4-reviewfix, 시험 리뷰 TR-07·TR-24 반영).
// 정본: docs/api/proto/peaket/core/v1/core.proto BookingRestrictionViewService·FraudAppealViewService, docs/data.md §3 sup:rst·sup:far.
// 구현 전에는 키트가 없어 각 RPC가 UNIMPLEMENTED로 끝나 시험이 그 자리에서 실패한다(모듈 없음으로 멈추지 않는다).
import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { startGrpcServer, type StartedGrpcServer } from '@peaket/platform';
import { coreV1Core } from '@peaket/contracts/proto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ACTIVE_VIEW, FRAUD_VIEW, INTERNAL, NOW_MS, SUPPORT_KIT, supportHarness, type CoreSupportKit, type SupportHarness } from './support-appeal-support.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const pkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(coreV1Core as never, LOAD)) as unknown as { peaket: { core: { v1: { BookingRestrictionViewService: grpc.ServiceClientConstructor; FraudAppealViewService: grpc.ServiceClientConstructor } } } }).peaket.core.v1;

let current: SupportHarness | undefined;
let server: StartedGrpcServer;
let restriction: grpc.Client & Record<string, (...a: unknown[]) => void>;
let fraud: grpc.Client & Record<string, (...a: unknown[]) => void>;

const kit = (): CoreSupportKit | undefined => {
  if (!current) return undefined;
  try {
    return current.svc.app.get(SUPPORT_KIT) as CoreSupportKit | undefined;
  } catch {
    return undefined;
  }
};

function wrap(name: 'SetBookingRestrictionView' | 'SetFraudAppealView', which: 'bookingRestrictionView' | 'fraudAppealView'): grpc.handleUnaryCall<Record<string, unknown>, Record<string, unknown>> {
  return (call, cb) => {
    const handler = kit()?.grpcHandlers?.[which]?.[name] as grpc.handleUnaryCall<Record<string, unknown>, Record<string, unknown>> | undefined;
    if (!handler) return cb({ code: grpc.status.UNIMPLEMENTED, details: 'support 키트가 없다' });
    handler(call, cb);
  };
}

const md = (o: { token?: string | null; caller?: string | null } = {}) => {
  const m = new grpc.Metadata();
  if (o.token !== null) m.set('x-peaket-internal-token', o.token ?? INTERNAL);
  if (o.caller !== null) m.set('x-peaket-caller', o.caller ?? 'ops-svc');
  return m;
};
const call = (client: grpc.Client, method: string, req: Record<string, unknown>, m = md()) =>
  new Promise<Record<string, unknown>>((resolve, reject) => (client as unknown as Record<string, (r: unknown, m: grpc.Metadata, cb: (e: unknown, v?: unknown) => void) => void>)[method]!(req, m, (e, v) => (e ? reject(e) : resolve(v as Record<string, unknown>))));

const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

beforeAll(async () => {
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    profile: 'service',
    drainMs: 0,
    services: [
      { definition: pkg.BookingRestrictionViewService.service, handlers: { SetBookingRestrictionView: wrap('SetBookingRestrictionView', 'bookingRestrictionView') } },
      { definition: pkg.FraudAppealViewService.service, handlers: { SetFraudAppealView: wrap('SetFraudAppealView', 'fraudAppealView') } },
    ],
  });
  const url = `127.0.0.1:${server.port}`;
  restriction = new pkg.BookingRestrictionViewService(url, grpc.credentials.createInsecure()) as typeof restriction;
  fraud = new pkg.FraudAppealViewService(url, grpc.credentials.createInsecure()) as typeof fraud;
});
beforeEach(async () => {
  current = await supportHarness();
});
afterEach(async () => {
  await current?.close();
  current = undefined;
});
afterAll(async () => {
  await server?.close();
});

describe('BookingRestrictionViewService', () => {
  test('Q-T59 ①·ASVS v5.0.0-2.3.4 같은 판은 false, 큰 판만 반영하고 사유·시작·끝·소명 기한을 보관한다', async () => {
    const accountId = '0194f064-0000-7000-8000-000000000011';
    const view = ACTIVE_VIEW({ accountId });
    const req = { account_id: accountId, restriction_id: view.restrictionId, state: 'BOOKING_RESTRICTION_VIEW_STATE_ACTIVE', reason_code: 'ABUSE_TRANSFER', starts_at: ts(view.startsAtMs), ends_at: ts(view.endsAtMs), appeal_due_at: ts(view.appealDueAtMs), version: 1 };
    expect(await call(restriction, 'SetBookingRestrictionView', req)).toEqual({ changed: true });
    expect(await call(restriction, 'SetBookingRestrictionView', req)).toEqual({ changed: false });
    expect(await call(restriction, 'SetBookingRestrictionView', { ...req, version: 0 })).toEqual({ changed: false });
    expect(await call(restriction, 'SetBookingRestrictionView', { ...req, reason_code: 'ABUSE_RESALE', version: 2 })).toEqual({ changed: true });
    const stored = await kit()!.views.restriction.get(accountId, view.restrictionId);
    expect(stored).toMatchObject({ accountId, restrictionId: view.restrictionId, reasonCode: 'ABUSE_RESALE', startsAtMs: view.startsAtMs, endsAtMs: view.endsAtMs, appealDueAtMs: view.appealDueAtMs, state: 'ACTIVE', version: 2 });
  });

  test('TR-07 큰 판 LIFTED를 gRPC로 넣으면 팬 GET /v1/booking-restrictions/me가 NONE이 된다', async () => {
    const accountId = '0194f064-0000-7000-8000-000000000012';
    const view = ACTIVE_VIEW({ accountId });
    const base = { account_id: accountId, restriction_id: view.restrictionId, reason_code: 'ABUSE_CANCEL', starts_at: ts(view.startsAtMs), ends_at: ts(view.endsAtMs), appeal_due_at: ts(view.appealDueAtMs) };
    expect(await call(restriction, 'SetBookingRestrictionView', { ...base, state: 'BOOKING_RESTRICTION_VIEW_STATE_ACTIVE', version: 1 })).toEqual({ changed: true });
    expect((await current!.restriction(current!.fanHeaders(accountId))).body).toMatchObject({ status: 'ACTIVE', restrictionId: view.restrictionId });
    expect(await call(restriction, 'SetBookingRestrictionView', { ...base, state: 'BOOKING_RESTRICTION_VIEW_STATE_LIFTED', ends_at: undefined, version: 2 })).toEqual({ changed: true });
    expect((await current!.restriction(current!.fanHeaders(accountId))).body).toEqual({ status: 'NONE' });
  });

  test('TR-07 끝 시각이 지난 ACTIVE 사본은 팬 GET에서 NONE이다', async () => {
    const accountId = '0194f064-0000-7000-8000-000000000013';
    const view = ACTIVE_VIEW({ accountId, endsAtMs: NOW_MS - 1 });
    const req = { account_id: accountId, restriction_id: view.restrictionId, state: 'BOOKING_RESTRICTION_VIEW_STATE_ACTIVE', reason_code: 'ABUSE_CANCEL', starts_at: ts(view.startsAtMs), ends_at: ts(view.endsAtMs), appeal_due_at: ts(view.appealDueAtMs), version: 1 };
    expect(await call(restriction, 'SetBookingRestrictionView', req)).toEqual({ changed: true });
    expect((await current!.restriction(current!.fanHeaders(accountId))).body).toEqual({ status: 'NONE' });
  });

  test('ASVS v5.0.0-8.2.1·8.3.1 내부 토큰·호출자 ops-svc가 아니면 모두 PERMISSION_DENIED이고 아무것도 쓰지 않는다', async () => {
    const accountId = '0194f064-0000-7000-8000-000000000014';
    const view = ACTIVE_VIEW({ accountId });
    const req = { account_id: accountId, restriction_id: view.restrictionId, state: 'BOOKING_RESTRICTION_VIEW_STATE_ACTIVE', reason_code: 'ABUSE_CANCEL', starts_at: ts(view.startsAtMs), appeal_due_at: ts(view.appealDueAtMs), version: 1 };
    const bad = [
      md({ token: null }),
      md({ token: 'wrong-token' }),
      md({ caller: 'purchase-svc' }),
      md({ caller: 'core-svc' }),
      md({ caller: 'ticket-svc' }),
      md({ caller: '' }),
      md({ caller: null }),
    ];
    for (const m of bad) await expect(call(restriction, 'SetBookingRestrictionView', req, m)).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    expect(await kit()!.views.restriction.get(accountId, view.restrictionId)).toBeUndefined();
  });

  test('ASVS v5.0.0-2.2.1 계정 ID·제한 ID·판·시각 모양이 틀리면 INVALID_ARGUMENT다', async () => {
    for (const req of [
      { account_id: 'not-a-uuid', restriction_id: 'x', state: 'BOOKING_RESTRICTION_VIEW_STATE_ACTIVE', reason_code: 'ABUSE_CANCEL', version: 1 },
      { account_id: '0194f064-0000-7000-8000-000000000015', restriction_id: '', state: 'BOOKING_RESTRICTION_VIEW_STATE_ACTIVE', reason_code: 'ABUSE_CANCEL', version: 1 },
      { account_id: '0194f064-0000-7000-8000-000000000015', restriction_id: 'r', state: 'BOOKING_RESTRICTION_VIEW_STATE_ACTIVE', reason_code: 'ABUSE_CANCEL', version: 0 },
    ]) {
      await expect(call(restriction, 'SetBookingRestrictionView', req)).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    }
  });
});

describe('FraudAppealViewService', () => {
  test('R-T32 ⑦ HOLDER 사본은 사유 범주·잠금·우선 구매·이의 칸을 비우고 가진 표만 쓴다', async () => {
    const accountId = '0194f064-0000-7000-8000-000000000016';
    const caseId = '0194f064-0000-7000-8000-000000000116';
    const held = ['0194f064-0000-7000-8000-000000000216', '0194f064-0000-7000-8000-000000000217'];
    const req = {
      account_id: accountId,
      case_id: caseId,
      event_id: '0194f064-0000-7000-8000-000000000316',
      reason_categories: ['MACRO_BOT', 'LIMIT_EVASION'],
      due_at: ts(NOW_MS + 86_400_000),
      locked_ticket_ids: ['0194f064-0000-7000-8000-000000000218'],
      state: 'FRAUD_APPEAL_VIEW_STATE_OPEN',
      version: 3,
      objection_due_at: ts(NOW_MS + 30 * 86_400_000),
      objection_state: 'SUBMITTED',
      restricted_until: ts(NOW_MS + 365 * 86_400_000),
      lock_expires_at: ts(NOW_MS + 14 * 86_400_000),
      lock_active: true,
      party: 'HOLDER',
      held_ticket_ids: held,
    };
    expect(await call(fraud, 'SetFraudAppealView', req)).toEqual({ changed: true });
    const stored = await kit()!.views.fraud.get(accountId, caseId);
    expect(stored).toMatchObject({ accountId, caseId, party: 'HOLDER', heldTicketIds: held, reasonCategories: [], lockedTicketIds: [], priorityPurchases: [], lockActive: false, objectionDueAtMs: null, restrictedUntilMs: null });
    expect(stored!.lockExpiresAtMs ?? null).toBeNull();
  });

  test('R-T32 ⑦ PAYER 사본은 사유 범주·잠금·우선 구매·이의 칸을 그대로 보관한다', async () => {
    const accountId = '0194f064-0000-7000-8000-000000000017';
    const caseId = '0194f064-0000-7000-8000-000000000117';
    const req = {
      account_id: accountId,
      case_id: caseId,
      event_id: '0194f064-0000-7000-8000-000000000317',
      reason_categories: ['ACCOUNT_LENDING'],
      due_at: ts(NOW_MS + 3 * 86_400_000),
      state: 'FRAUD_APPEAL_VIEW_STATE_SUBMITTED',
      version: 1,
      objection_due_at: ts(NOW_MS + 30 * 86_400_000),
      objection_state: 'NONE',
      restricted_until: ts(NOW_MS + 365 * 86_400_000),
      lock_expires_at: ts(NOW_MS + 14 * 86_400_000),
      lock_active: false,
      party: 'PAYER',
    };
    expect(await call(fraud, 'SetFraudAppealView', req)).toEqual({ changed: true });
    const stored = await kit()!.views.fraud.get(accountId, caseId);
    expect(stored).toMatchObject({ party: 'PAYER', reasonCategories: ['ACCOUNT_LENDING'], objectionDueAtMs: NOW_MS + 30 * 86_400_000, objectionStatus: 'NONE', lockActive: false, state: 'SUBMITTED', version: 1 });
    expect(stored!.lockExpiresAtMs).toBe(NOW_MS + 14 * 86_400_000);
  });

  test('IR-09 PAYER 사본의 취소 표·제한 끝이 GET /v1/fraud-appeal-requests의 actionResult에 실린다', async () => {
    const accountId = '0194f064-0000-7000-8000-000000000020';
    const caseId = '0194f064-0000-7000-8000-000000000120';
    const cancelled = '0194f064-0000-7000-8000-000000000220';
    const restrictedUntil = NOW_MS + 365 * 86_400_000;
    const req = {
      account_id: accountId,
      case_id: caseId,
      event_id: '0194f064-0000-7000-8000-000000000320',
      due_at: ts(NOW_MS + 86_400_000),
      state: 'FRAUD_APPEAL_VIEW_STATE_ACCEPTED',
      version: 4,
      party: 'PAYER',
      cancelled_ticket_ids: [cancelled],
      restricted_until: ts(restrictedUntil),
    };
    expect(await call(fraud, 'SetFraudAppealView', req)).toEqual({ changed: true });
    const page = await current!.fraudAppeals(current!.fanHeaders(accountId));
    expect((page.body.items as Array<Record<string, unknown>>)[0]).toMatchObject({ caseId, actionResult: { cancelledTicketIds: [cancelled], restrictedUntil: new Date(restrictedUntil).toISOString() } });
  });

  test('ASVS v5.0.0-2.3.4·8.3.1 판이 작으면 false, 내부 토큰·호출자가 틀리면 모두 PERMISSION_DENIED다', async () => {
    const accountId = '0194f064-0000-7000-8000-000000000018';
    const caseId = '0194f064-0000-7000-8000-000000000118';
    const req = { account_id: accountId, case_id: caseId, event_id: '0194f064-0000-7000-8000-000000000318', due_at: ts(NOW_MS), state: 'FRAUD_APPEAL_VIEW_STATE_OPEN', version: 2, party: 'PAYER' };
    expect(await call(fraud, 'SetFraudAppealView', req)).toEqual({ changed: true });
    expect(await call(fraud, 'SetFraudAppealView', req)).toEqual({ changed: false });
    for (const m of [md({ token: null }), md({ token: 'wrong-token' }), md({ caller: 'core-svc' }), md({ caller: 'ticket-svc' }), md({ caller: '' })]) {
      await expect(call(fraud, 'SetFraudAppealView', { ...req, version: 3 }, m)).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    }
  });

  test('ASVS v5.0.0-2.2.1 모르는 state·party·판 0은 INVALID_ARGUMENT다', async () => {
    const base = { account_id: '0194f064-0000-7000-8000-000000000019', case_id: '0194f064-0000-7000-8000-000000000119', event_id: '0194f064-0000-7000-8000-000000000319', due_at: ts(NOW_MS), version: 1 };
    for (const req of [
      { ...base, state: 'FRAUD_APPEAL_VIEW_STATE_UNSPECIFIED' },
      { ...base, state: 'FRAUD_APPEAL_VIEW_STATE_OPEN', party: 'SOMEONE' },
      { ...base, state: 'FRAUD_APPEAL_VIEW_STATE_OPEN', party: 'PAYER', version: 0 },
    ]) {
      await expect(call(fraud, 'SetFraudAppealView', req)).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    }
  });
});
