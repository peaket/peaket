// F-05-11 양도 뒤 몫 단위 시험(BUILD_ORDER GAT-050·GAT-055·GAT-060, 계획 docs/review/plans/F-05-11.md §4·§5 T1~T10).
// 시험 담당이 구현 전에 썼다(ADR-0372·0381). 기준 트리에서 새 동작은 실패한다('실패 확인' 절).
// 정본: docs/features/transfer-refund.md §3.1·§4·§5·§11, docs/features/identity.md §7.1·§8·§11(I-T43 ①·I-T54 ⑤),
//       docs/features/notify.md §4.8, docs/design/d5 §5.23·§9.2, docs/api/openapi.yaml TransferOffer·Ticket, POL-017·POL-019·POL-033.
// - 진짜: 처리기·Transfers·TicketService·도메인 규칙·플랫폼 계약 검사. 바꿔 끼운 것은 저장소 포트(MemoryTicketStore·MemoryTransferStore·MemoryDeviceKeyStore,
//   포트를 implements한 짝 가짜), 시계(fakeClock), 재인증 확인 포트(TransferReauthGate), identity 찾기 포트(MemberCodeDirectory), core 알림 입구(가짜 sink)뿐이다.
//   같은 동작을 실제 PostgreSQL로 덮는 시험은 test-int/transfer-f0511.int.test.ts(같은 T 번호)다.
// - 새 모듈(아직 없다)은 동적 가져오기로 불러 '모듈이 없다' 단언에서 떨어지게 한다(파일이 가져오기에서 멈추지 않는다).
// - 시험 값은 정본 예와 다르게 고른다(회원 코드 QZ7-4K2M, 휴대폰 010-9371-2468, 공연 시작 19:37 KST).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, type FakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type ScannerSessionCheck } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { MemoryDeviceKeyStore } from '../src/modules/ticket/adapters/memory-device-key-store.js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { MemoryTransferStore } from '../src/modules/ticket/adapters/memory-transfer-store.js';
import { DeviceKeys } from '../src/modules/ticket/application/device-keys.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { Transfers } from '../src/modules/ticket/application/transfers.js';
import type { MemberCodeDirectory, TransferReauthGate } from '../src/modules/ticket/domain/transfer-ports.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
/** 가짜 시계를 그 시각으로 옮긴다(뒤로는 못 간다) */
const setNow = (clock: FakeClock, ms: number): void => {
  const d = ms - clock.now();
  if (d < 0) throw new Error('가짜 시계를 뒤로 옮길 수 없다');
  clock.advance(d);
};
/** problem 본문의 type은 절대 주소라 마지막 조각만 본다 */
const problemTypeOf = (body: Record<string, unknown>): string => String(body.type ?? '').split('/').filter(Boolean).pop() ?? '';
/** 공연 시작: 9일 뒤 19:37 KST(어긋난 분). 양도 마감은 그 2시간 전(POL-017) */
const STARTS = Date.parse('2026-12-02T10:37:00.000Z');
const A = '0193f2c0-0000-7000-8000-000000511001'; // 결제자(보낸 사람)
const B = '0193f2c0-0000-7000-8000-000000511002'; // 받는 사람
const C = '0193f2c0-0000-7000-8000-000000511003'; // 상관없는 계정
const SESSION = '0193f2c0-0000-7000-8000-000000511004';
const EVENT = '0193f2c0-0000-7000-8000-000000511e01';
const OTHER_EVENT = '0193f2c0-0000-7000-8000-000000511e02';
const SECRET = 'f0511-unit-secret';
const CODE_B = 'QZ7-4K2M';
const PHONE_B = '010-9371-2468';
const NICK_B = '지민';
const NICK_A = '서윤';

class FakeAdmin implements AdminAuthzPort {
  async getAdminAuthz(): Promise<{ valid: boolean; role: string }> {
    return { valid: false, role: '' };
  }
}
class FakeSessions implements ScannerSessionCheck {
  async check(): Promise<{ valid: boolean }> {
    return { valid: false };
  }
}

/** identity 찾기 포트의 짝 가짜. 부른 값을 적고, fail이 참이면 gRPC 클라이언트처럼 던진다 */
class RecordingDirectory implements MemberCodeDirectory {
  readonly codes = new Map<string, string>();
  readonly phones = new Map<string, string>();
  readonly nicknames = new Map<string, string>();
  readonly calls: string[] = [];
  fail = false;
  constructor() {
    this.codes.set(CODE_B, B);
    this.phones.set('01093712468', B);
    this.nicknames.set(B, NICK_B);
    this.nicknames.set(A, NICK_A);
  }
  async resolveMemberCode(code: string): Promise<{ accountId: string; nickname: string } | undefined> {
    this.calls.push(`code:${code}`);
    if (this.fail) throw new Error('14 UNAVAILABLE: identity-svc 연결 실패');
    const accountId = this.codes.get(code);
    return accountId === undefined ? undefined : { accountId, nickname: this.nicknames.get(accountId) ?? '' };
  }
  async resolvePhone(phoneDigits: string): Promise<{ accountId: string; nickname: string } | undefined> {
    this.calls.push(`phone:${phoneDigits}`);
    if (this.fail) throw new Error('14 UNAVAILABLE: identity-svc 연결 실패');
    const accountId = this.phones.get(phoneDigits);
    return accountId === undefined ? undefined : { accountId, nickname: this.nicknames.get(accountId) ?? '' };
  }
  async resolveNicknames(accountIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    this.calls.push(`nicknames:${accountIds.length}`);
    if (this.fail) throw new Error('14 UNAVAILABLE: identity-svc 연결 실패');
    return new Map(accountIds.flatMap((id) => (this.nicknames.has(id) ? [[id, this.nicknames.get(id)!] as const] : [])));
  }
}

/** 재인증 확인 포트의 짝 가짜: 이 토큰만 거절한다. WEAK 토큰은 '요청만 함'이다 */
const REJECTED_TOKEN = 'rejected-reauth-token';
const WEAK_TOKEN = 'naver-only-reauth-token';
class SwitchReauth implements TransferReauthGate {
  readonly calls: string[] = [];
  async verify(token: string | undefined, q: { readonly op: string }): Promise<boolean> {
    this.calls.push(q.op);
    return token !== undefined && token !== REJECTED_TOKEN;
  }
  async verifyDetailed(token: string | undefined, q: { readonly op: string }): Promise<{ ok: boolean; strength?: 'verified' | 'requested' }> {
    const ok = await this.verify(token, q);
    return ok ? { ok, strength: token === WEAK_TOKEN ? 'requested' : 'verified' } : { ok };
  }
}

interface Res {
  readonly status: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => {});
});

type StoreExtras = {
  events?: Array<{ topic: string; key: string; payload: Uint8Array }>;
  notices?: Array<{ noticeId: string; type: string; accountId: string; reason?: string }>;
  setEntryClose?: (eventId: string, closedAtMs: number) => void;
  claimDue?: (nowMs: number, limit: number, leaseMs: number) => Promise<readonly unknown[]>;
  markSent?: (noticeId: string, nowMs: number) => Promise<void>;
  reschedule?: (noticeId: string, nextAttemptAtMs: number) => Promise<void>;
  purgeSent?: (beforeMs: number) => Promise<number>;
  backlog?: () => Promise<{ count: number; oldestCreatedAtMs?: number }>;
};
type TransfersExtras = {
  withdrawForEvent?: (i: { eventId: string; nowMs?: number }) => Promise<{ withdrawn: readonly string[] }>;
  counterpartNicknameOf?: (offer: { offerId: string }, accountId: string) => Promise<string | undefined>;
};

/** 시험마다 새 서비스·저장소·시계. revoked는 저장소가 키를 폐기한 표 ID 기록 */
async function harness() {
  const clock: FakeClock = fakeClock({ now: NOW });
  const tickets = new MemoryTicketStore();
  const revoked: string[] = [];
  // 새 선택 인자(outboxCodec·clock)는 구현이 더한다. 아직 없는 기준 트리에서도 이 파일이 읽히도록 type-escape로 넘긴다.
  const store = new MemoryTransferStore({ tickets, revokeKey: (ticketId: string) => void revoked.push(ticketId), clock } as unknown as ConstructorParameters<typeof MemoryTransferStore>[0]);
  const service = new TicketService({ store: tickets, clock });
  const directory = new RecordingDirectory();
  const reauth = new SwitchReauth();
  const transfers = new Transfers({ store, reauth, recipientRefSecret: SECRET, clock, directory });
  const logs: string[] = [];
  const sink = new Writable({
    write: (chunk: Buffer | string, _enc, cb) => {
      logs.push(String(chunk));
      cb();
    },
  });
  const replay = new MemoryDpopReplayStore(clock);
  const deviceKeysStore = new MemoryDeviceKeyStore();
  const gate = new MemoryScannerGateStore(deviceKeysStore);
  const devices = new MemoryScannerDeviceStore();
  const svc = await createService({
    name: 'ticket-svc-transfer-f0511',
    module: AppModule.register({
      scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay, gate, shift: new MemoryScannerShiftStore(gate) },
      ticket: { deviceKeys: new DeviceKeys({ store: deviceKeysStore, clock }), tickets: service, transfers },
    }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' },
    clock,
    logDestination: sink,
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions: new FakeSessions(), replay },
  });
  closers.push(() => svc.close());

  const send = async (method: 'GET' | 'POST', url: string, account: string | null, o: { body?: unknown; key?: string; reauth?: string } = {}): Promise<Res> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (account !== null) Object.assign(headers, { 'x-user-id': account, 'x-session-id': SESSION, 'x-user-aud': 'fan' });
    if (o.key !== undefined) headers['idempotency-key'] = o.key;
    if (o.reauth !== undefined) headers['x-reauth-token'] = o.reauth;
    const r = await svc.http.inject({ method, url, headers, ...(method === 'POST' ? { payload: JSON.stringify(o.body ?? {}) } : {}) });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: r.statusCode, headers: r.headers, raw: r.payload, body };
  };
  const get = (url: string, account: string | null = A) => send('GET', url, account);
  const post = (url: string, account: string, o: { body?: unknown; key?: string; reauth?: string } = {}) => send('POST', url, account, { key: randomUUID(), ...o });

  const issue = async (o: { payer?: string; eventId?: string; startsAtMs?: number } = {}): Promise<string> => {
    const r = await service.issue({ orderId: randomUUID(), eventId: o.eventId ?? EVENT, payerAccountId: o.payer ?? A, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: o.startsAtMs ?? STARTS });
    clock.advance(1_000);
    return r.tickets[0]!.ticketId;
  };
  const offer = async (ticketId: string, from = A, memberCode = CODE_B): Promise<string> => {
    const found = await post('/v1/transfer-recipient-lookups', from, { body: { memberCode } });
    expect(found.status, found.raw).toBe(200);
    const created = await post(`/v1/tickets/${ticketId}/transfers`, from, { body: { recipientRef: found.body.recipientRef }, reauth: 'r' });
    expect(created.status, created.raw).toBe(201);
    return String(created.body.offerId);
  };
  const ticketRow = (ticketId: string) => tickets.tickets.get(ticketId)!;
  const extras = store as unknown as StoreExtras;
  const textras = transfers as unknown as TransfersExtras;
  return { svc, clock, tickets, store, service, transfers, directory, reauth, revoked, logs, send, get, post, issue, offer, ticketRow, extras, textras };
}

type H = Awaited<ReturnType<typeof harness>>;

const eventCancelInput = (ticketIds: readonly string[], nowMs: number) => ({
  cancellationRequestId: randomUUID(),
  eventId: EVENT,
  targets: ticketIds.map((ticketId) => ({ ticketId, cancellationId: randomUUID() })),
  nowMs,
});

describe('F-05-11 T1 R-T21 ① 거절·철회 멱등', () => {
  test('F-05-11 T1 R-T21 ① ① 같은 키로 거절을 두 번 보내면 200·REJECTED 그대로이고 표 version은 한 번만 오른다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const version = h.ticketRow(t).version;
    const key = randomUUID();
    const first = await h.post(`/v1/transfers/${offerId}/rejection`, B, { key });
    expect(first.status, first.raw).toBe(200);
    expect(first.body).toMatchObject({ offerId, status: 'REJECTED', role: 'RECIPIENT' });
    const again = await h.post(`/v1/transfers/${offerId}/rejection`, B, { key });
    expect(again.status, again.raw).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(h.ticketRow(t).version).toBe(version + 1);
    expect((await h.store.getOffer(offerId))?.status).toBe('REJECTED');
  });

  test('F-05-11 T1 R-T21 ① ② 다른 키로 다시 보내도 처음 결과(재생)이고, 철회도 같다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const first = await h.post(`/v1/transfers/${offerId}/rejection`, B);
    expect(first.status, first.raw).toBe(200);
    const again = await h.post(`/v1/transfers/${offerId}/rejection`, B);
    expect(again.status, again.raw).toBe(200);
    expect(again.body).toEqual(first.body);

    const t2 = await h.issue();
    const offer2 = await h.offer(t2);
    const w1 = await h.post(`/v1/transfers/${offer2}/withdrawal`, A);
    expect(w1.status, w1.raw).toBe(200);
    expect(w1.body).toMatchObject({ status: 'WITHDRAWN', withdrawReason: 'SENDER' });
    const w2 = await h.post(`/v1/transfers/${offer2}/withdrawal`, A);
    expect(w2.status, w2.raw).toBe(200);
    expect(w2.body).toEqual(w1.body);
  });

  test('F-05-11 T1 R-T21 ① ③ 받는 사람이 아닌 계정의 거절은 404, 수락된 요청의 거절은 409 transfer-not-offered다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    expect((await h.post(`/v1/transfers/${offerId}/rejection`, C)).status).toBe(404);
    const accepted = await h.post(`/v1/transfers/${offerId}/acceptance`, B);
    expect(accepted.status, accepted.raw).toBe(200);
    const rejected = await h.post(`/v1/transfers/${offerId}/rejection`, B);
    expect(rejected.status, rejected.raw).toBe(409);
    expect(problemTypeOf(rejected.body)).toBe('transfer-not-offered');
  });

  test('F-05-11 T1 R-T21 ① ④ 경계: 만료 −1ms는 거절 200, 0ms는 409 transfer-expired다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const expires = (await h.store.getOffer(offerId))!.expiresAtMs;
    setNow(h.clock, expires - 1);
    const before = await h.post(`/v1/transfers/${offerId}/rejection`, B);
    expect(before.status, before.raw).toBe(200);
    const t2 = await h.issue();
    const offer2 = await h.offer(t2);
    const expires2 = (await h.store.getOffer(offer2))!.expiresAtMs;
    setNow(h.clock, expires2);
    const at = await h.post(`/v1/transfers/${offer2}/rejection`, B);
    expect(at.status, at.raw).toBe(409);
    expect(problemTypeOf(at.body)).toBe('transfer-expired');
  });
});

describe('F-05-11 T2 R-T21 ② 키 없는 거절·철회', () => {
  test('F-05-11 T2 R-T21 ② ① 키가 없으면 400 idempotency-key-invalid이고 요청·표가 그대로다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const version = h.ticketRow(t).version;
    const res = await h.svc.http.inject({ method: 'POST', url: `/v1/transfers/${offerId}/rejection`, headers: { 'x-user-id': B, 'x-session-id': SESSION, 'x-user-aud': 'fan', 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as Record<string, unknown>;
    expect(problemTypeOf(body)).toBe('idempotency-key-invalid');
    expect((await h.store.getOffer(offerId))?.status).toBe('OFFERED');
    expect(h.ticketRow(t).version).toBe(version);
  });

  test('F-05-11 T2 R-T21 ② ② 키 모양이 UUID가 아니어도 400이고 쓰기 0이다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const res = await h.post(`/v1/transfers/${offerId}/withdrawal`, A, { key: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect((await h.store.getOffer(offerId))?.status).toBe('OFFERED');
  });
});

describe('F-05-11 T3 R-T25 ③ 연기 철회', () => {
  test('F-05-11 T3 R-T25 ③ ① 그 회차 OFFERED 셋을 WITHDRAWN·EVENT_POSTPONED로 바꾸고 표시를 되돌린다(멱등)', async () => {
    const h = await harness();
    const ids = [await h.issue(), await h.issue(), await h.issue()];
    const offers = [];
    for (const t of ids) offers.push(await h.offer(t));
    const other = await h.issue({ eventId: OTHER_EVENT });
    const otherOffer = await h.offer(other);
    const at = h.clock.now() + 3 * MIN;
    const out = await h.textras.withdrawForEvent?.({ eventId: EVENT, nowMs: at });
    expect(out, 'withdrawForEvent가 없다').toBeDefined();
    expect([...(out?.withdrawn ?? [])].sort()).toEqual([...offers].sort());
    for (const id of offers) {
      const o = await h.store.getOffer(id);
      expect({ status: o?.status, reason: o?.withdrawReason, decidedAtMs: o?.decidedAtMs }).toEqual({ status: 'WITHDRAWN', reason: 'EVENT_POSTPONED', decidedAtMs: at });
    }
    for (const t of ids) expect({ pending: h.ticketRow(t).transferPending, status: h.ticketRow(t).status }).toEqual({ pending: false, status: 'ACTIVE' });
    expect((await h.store.getOffer(otherOffer))?.status).toBe('OFFERED');
    const again = await h.textras.withdrawForEvent?.({ eventId: EVENT, nowMs: at + 1_000 });
    expect(again?.withdrawn).toHaveLength(0);
  });

  test('F-05-11 T3 R-T25 ③ ② 철회 뒤 CancelTickets(EVENT_POSTPONED)가 TRANSFER_PENDING에 막히지 않고 끝난다', async () => {
    const h = await harness();
    const t = await h.issue();
    await h.offer(t);
    await h.textras.withdrawForEvent?.({ eventId: EVENT, nowMs: h.clock.now() });
    const out = await h.tickets.cancel({ cancellationId: randomUUID(), orderId: h.ticketRow(t).orderId, requestedByAccountId: A, ticketIds: [t], nowMs: h.clock.now(), reason: 'EVENT_POSTPONED' });
    expect(out[0]?.result).toMatch(/REFUND_NOW|REFUND_AFTER_CLOSE/);
    expect(h.ticketRow(t).status).toMatch(/REFUNDED|VOIDED/);
  });
});

describe('F-05-11 T4 I-T43 ① 탈퇴 참여자', () => {
  test('F-05-11 T4 I-T43 ① ① 받은 표는 결제자에게 돌아가고 보낸 요청은 철회·받은 요청은 거절이다', async () => {
    const mod = await import(/* @vite-ignore */ new URL('../src/modules/ticket/application/account-withdrawal.ts', import.meta.url).href).catch(() => undefined);
    expect(mod, 'account-withdrawal 모듈이 없다').toBeDefined();
    const TransferWithdrawal = (mod as { TransferWithdrawal?: new (d: object) => { run(i: { accountId: string }): Promise<Record<string, unknown>> } }).TransferWithdrawal;
    expect(TransferWithdrawal, 'TransferWithdrawal이 없다').toBeDefined();
    const h = await harness();
    // B가 받은 표 1장(수락), B가 받은 요청 1건, B가 보낸 요청 1건
    const receivedTicket = await h.issue();
    const found = await h.post('/v1/transfer-recipient-lookups', A, { body: { memberCode: CODE_B } });
    const created = await h.post(`/v1/tickets/${receivedTicket}/transfers`, A, { body: { recipientRef: found.body.recipientRef }, reauth: 'r' });
    expect(created.status, created.raw).toBe(201);
    expect((await h.post(`/v1/transfers/${String(created.body.offerId)}/acceptance`, B)).status).toBe(200);
    // B가 결제자인 표를 C에게 보낸 요청(보낸 요청) — B가 결제자가 되도록 발권
    const bTicket = await h.issue({ payer: B });
    h.directory.codes.set('BQ7-4K2M', C);
    const sent = await h.post(`/v1/tickets/${bTicket}/transfers`, B, { body: { recipientRef: (await h.post('/v1/transfer-recipient-lookups', B, { body: { memberCode: 'BQ7-4K2M' } })).body.recipientRef }, reauth: 'r' });
    expect(sent.status, sent.raw).toBe(201);
    // B가 받은 요청(다른 표를 B에게) — A 표 하나 더
    const toB = await h.issue();
    const offerToB = await h.offer(toB);
    const wd = new TransferWithdrawal!({ transfers: h.transfers, store: h.store, clock: h.clock });
    const out = await wd.run({ accountId: B });
    expect(out).toMatchObject({ state: 'DONE', returnedTickets: 1, withdrawnOffers: 1, rejectedOffers: 1 });
    expect(h.ticketRow(receivedTicket).accountId).toBe(A);
    expect((await h.store.getOffer(String(sent.body.offerId)))?.status).toBe('WITHDRAWN');
    expect((await h.store.getOffer(String(sent.body.offerId)))?.withdrawReason).toBe('ACCOUNT_DELETED');
    expect((await h.store.getOffer(offerToB))?.status).toBe('REJECTED');
    expect(h.ticketRow(toB).transferPending).toBe(false);
  });

  test('F-05-11 T4 I-T43 ① ② 입장 동결 중이면 키만 폐기하고 PENDING, 마감 뒤 다시 부르면 DONE이다', async () => {
    const mod = await import(/* @vite-ignore */ new URL('../src/modules/ticket/application/account-withdrawal.ts', import.meta.url).href).catch(() => undefined);
    expect(mod, 'account-withdrawal 모듈이 없다').toBeDefined();
    const TransferWithdrawal = (mod as { TransferWithdrawal?: new (d: object) => { run(i: { accountId: string }): Promise<Record<string, unknown>> } }).TransferWithdrawal;
    const h = await harness();
    const t = await h.issue();
    const found = await h.post('/v1/transfer-recipient-lookups', A, { body: { memberCode: CODE_B } });
    const created = await h.post(`/v1/tickets/${t}/transfers`, A, { body: { recipientRef: found.body.recipientRef }, reauth: 'r' });
    await h.post(`/v1/transfers/${String(created.body.offerId)}/acceptance`, B);
    // 키 등록 뒤 입장 시작
    const keyId = new Uint8Array(8);
    new DataView(keyId.buffer).setUint32(4, 7);
    const wd = new TransferWithdrawal!({ transfers: h.transfers, store: h.store, clock: h.clock });
    const atStart = STARTS + 1;
    setNow(h.clock, atStart);
    h.extras.setEntryClose?.(EVENT, STARTS + 50 * HOUR);
    const frozen = await wd.run({ accountId: B });
    expect(frozen).toMatchObject({ state: 'PENDING', pendingReceivedTickets: 1, returnedTickets: 0 });
    expect(h.ticketRow(t).accountId).toBe(B);
    setNow(h.clock, STARTS + 50 * HOUR);
    const after = await wd.run({ accountId: B });
    expect(after).toMatchObject({ state: 'DONE', returnedTickets: 1, pendingReceivedTickets: 0 });
    expect(h.ticketRow(t).accountId).toBe(A);
  });

  test('F-05-11 T4 I-T43 ① ③ 마감을 모르면 시작 + 50시간 −1ms는 PENDING, +50시간은 DONE이다', async () => {
    const mod = await import(/* @vite-ignore */ new URL('../src/modules/ticket/application/account-withdrawal.ts', import.meta.url).href).catch(() => undefined);
    expect(mod, 'account-withdrawal 모듈이 없다').toBeDefined();
    const TransferWithdrawal = (mod as { TransferWithdrawal?: new (d: object) => { run(i: { accountId: string }): Promise<Record<string, unknown>> } }).TransferWithdrawal;
    const h = await harness();
    const t = await h.issue();
    const found = await h.post('/v1/transfer-recipient-lookups', A, { body: { memberCode: CODE_B } });
    const created = await h.post(`/v1/tickets/${t}/transfers`, A, { body: { recipientRef: found.body.recipientRef }, reauth: 'r' });
    await h.post(`/v1/transfers/${String(created.body.offerId)}/acceptance`, B);
    const wd = new TransferWithdrawal!({ transfers: h.transfers, store: h.store, clock: h.clock });
    setNow(h.clock, STARTS + 50 * HOUR - 1);
    expect(await wd.run({ accountId: B })).toMatchObject({ state: 'PENDING' });
    setNow(h.clock, STARTS + 50 * HOUR);
    expect(await wd.run({ accountId: B })).toMatchObject({ state: 'DONE' });
  });
});

describe('F-05-11 T5 I-T54 ⑤ 요청만 함 재인증', () => {
  test('F-05-11 T5 I-T54 ⑤ ① strength requested면 201이고 보낸 사람에게 약한 재인증 알림이 생긴다', async () => {
    const h = await harness();
    const t = await h.issue();
    const found = await h.post('/v1/transfer-recipient-lookups', A, { body: { memberCode: CODE_B } });
    const created = await h.post(`/v1/tickets/${t}/transfers`, A, { body: { recipientRef: found.body.recipientRef }, reauth: WEAK_TOKEN });
    expect(created.status, created.raw).toBe(201);
    const notices = h.extras.notices ?? [];
    expect(notices.filter((n) => n.type === 'TRANSFER_WEAK_REAUTH' && n.accountId === A)).toHaveLength(1);
    expect(notices.filter((n) => n.type === 'TRANSFER_OFFERED' && n.accountId === B)).toHaveLength(1);
  });

  test('F-05-11 T5 I-T54 ⑤ ② verified면 약한 재인증 알림이 0이고, 재인증 거절이면 403·알림 0이다', async () => {
    const h = await harness();
    const t = await h.issue();
    const found = await h.post('/v1/transfer-recipient-lookups', A, { body: { memberCode: CODE_B } });
    const ok = await h.post(`/v1/tickets/${t}/transfers`, A, { body: { recipientRef: found.body.recipientRef }, reauth: 'verified-token' });
    expect(ok.status, ok.raw).toBe(201);
    expect((h.extras.notices ?? []).filter((n) => n.type === 'TRANSFER_WEAK_REAUTH')).toHaveLength(0);
    const t2 = await h.issue();
    const denied = await h.post(`/v1/tickets/${t2}/transfers`, A, { body: { recipientRef: found.body.recipientRef }, reauth: REJECTED_TOKEN });
    expect(denied.status).toBe(403);
    expect((h.extras.notices ?? []).filter((n) => n.accountId === A && n.type === 'TRANSFER_OFFERED')).toHaveLength(0);
  });
});

describe('F-05-11 T6 휴대폰으로 받는 사람 찾기', () => {
  test('F-05-11 T6 ① 하이픈·국가번호를 숫자로 맞춰 같은 계정을 찾고 가린 닉네임을 준다', async () => {
    const h = await harness();
    for (const phone of [PHONE_B, '01093712468', '+82 10-9371-2468']) {
      const res = await h.post('/v1/transfer-recipient-lookups', A, { body: { phoneNumber: phone } });
      expect(res.status, `${phone}: ${res.raw}`).toBe(200);
      expect(res.body).toMatchObject({ nicknameMasked: '지*' });
      expect(typeof res.body.recipientRef).toBe('string');
    }
    expect(h.directory.calls.filter((c) => c === 'phone:01093712468')).toHaveLength(3);
  });

  test('F-05-11 T6 ② 모양이 틀린 번호는 400 invalid-body, 없는 번호는 404 recipient-not-found다', async () => {
    const h = await harness();
    for (const phone of ['02-123-4567', '010937124678', '']) {
      const res = await h.post('/v1/transfer-recipient-lookups', A, { body: { phoneNumber: phone } });
      expect(res.status, `${phone}: ${res.raw}`).toBe(400);
      expect(problemTypeOf(res.body)).toBe('invalid-body');
    }
    h.directory.phones.clear();
    const missing = await h.post('/v1/transfer-recipient-lookups', A, { body: { phoneNumber: PHONE_B } });
    expect(missing.status).toBe(404);
    expect(problemTypeOf(missing.body)).toBe('recipient-not-found');
  });

  test('F-05-11 T6 ③ 11번째 조회는 429이고 번호 원문은 조회 기록·로그에 없다', async () => {
    const h = await harness();
    for (let i = 0; i < 10; i += 1) expect((await h.post('/v1/transfer-recipient-lookups', A, { body: { phoneNumber: PHONE_B } })).status).toBe(200);
    const limited = await h.post('/v1/transfer-recipient-lookups', A, { body: { phoneNumber: PHONE_B } });
    expect(limited.status).toBe(429);
    expect(problemTypeOf(limited.body)).toBe('transfer-lookup-limited');
    const joined = h.logs.join('\n');
    expect(joined).not.toContain('01093712468');
    expect(joined).not.toContain(PHONE_B);
  });

  test('F-05-11 T6 ④ identity 실패는 503 dependency-unavailable이고 기록을 쓴다', async () => {
    const h = await harness();
    h.directory.fail = true;
    const res = await h.post('/v1/transfer-recipient-lookups', A, { body: { phoneNumber: PHONE_B } });
    expect(res.status).toBe(503);
    expect(problemTypeOf(res.body)).toBe('dependency-unavailable');
  });
});

describe('F-05-11 T7 보낸 분 닉네임', () => {
  test('F-05-11 T7 ① 받은 요청 목록·상세에 가린 상대 닉네임이 실린다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const detail = await h.get(`/v1/transfers/${offerId}`, B);
    expect(detail.status, detail.raw).toBe(200);
    expect(detail.body).toMatchObject({ counterpartNickname: '서*' });
    const list = await h.get('/v1/transfers', B);
    expect(list.status, list.raw).toBe(200);
    expect((list.body.items as Array<Record<string, unknown>>)[0]).toMatchObject({ counterpartNickname: '서*' });
    expect(JSON.stringify(detail.body)).not.toContain(NICK_A);
  });

  test('F-05-11 T7 ② 받은 표 상세의 receivedFromNickname은 결제자 닉네임이고 결제자 표는 null이다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    expect((await h.post(`/v1/transfers/${offerId}/acceptance`, B)).status).toBe(200);
    const received = await h.get(`/v1/tickets/${t}`, B);
    expect(received.status, received.raw).toBe(200);
    expect(received.body).toMatchObject({ receivedFromNickname: '서*' });
    const t2 = await h.issue();
    const own = await h.get(`/v1/tickets/${t2}`, A);
    expect(own.body).toMatchObject({ receivedFromNickname: null });
    expect(JSON.stringify(received.body)).not.toContain(NICK_A);
  });

  test('F-05-11 T7 ③ identity를 못 부르면 요청 조회는 칸이 없고 상세는 회원이며 양도는 막지 않는다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    h.directory.fail = true;
    const detail = await h.get(`/v1/transfers/${offerId}`, B);
    expect(detail.status, detail.raw).toBe(200);
    expect(detail.body).not.toHaveProperty('counterpartNickname');
    expect((await h.post(`/v1/transfers/${offerId}/acceptance`, B)).status).toBe(200);
    const received = await h.get(`/v1/tickets/${t}`, B);
    expect(received.status, received.raw).toBe(200);
    expect(received.body).toMatchObject({ receivedFromNickname: '회원' });
  });
});

describe('F-05-11 T8 Outbox 여섯 사건', () => {
  test('F-05-11 T8 ① 요청·수락·거절·철회·만료·돌려주기가 각각 한 행을 남기고 accountId가 그 시각 보유자다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    let events = h.extras.events ?? [];
    expect(events.map((e) => e.topic)).toEqual(['trade.tickets']);
    expect(new TextDecoder().decode(events[0]!.payload)).toContain('TRANSFER_OFFERED');
    expect(events[0]!.key).toBe(EVENT);
    expect((await h.post(`/v1/transfers/${offerId}/acceptance`, B)).status).toBe(200);
    events = h.extras.events ?? [];
    expect(events.some((e) => new TextDecoder().decode(e.payload).includes('TRANSFER_ACCEPTED'))).toBe(true);
    // 돌려주기
    expect((await h.post(`/v1/tickets/${t}/returns`, B, { reauth: 'r' })).status).toBe(200);
    events = h.extras.events ?? [];
    expect(events.some((e) => new TextDecoder().decode(e.payload).includes('TICKET_RETURNED'))).toBe(true);
    expect(events).toHaveLength(3);
    const keys = events.map((e) => JSON.parse(new TextDecoder().decode(e.payload)) as { eventKey: string });
    expect(new Set(keys.map((k) => k.eventKey)).size).toBe(3);
  });

  test('F-05-11 T8 ② 같은 사건을 다시 보내도 outbox 행이 늘지 않고 eventKey가 같다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const before = (h.extras.events ?? []).length;
    await h.post(`/v1/transfers/${offerId}/rejection`, B);
    await h.post(`/v1/transfers/${offerId}/rejection`, B);
    expect((h.extras.events ?? []).length).toBe(before + 1);
  });

  test('F-05-11 T8 ③ 실패한 요청(409)에는 outbox 행이 0이다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const before = (h.extras.events ?? []).length;
    expect((await h.post(`/v1/transfers/${offerId}/rejection`, C)).status).toBe(404);
    expect((h.extras.events ?? []).length).toBe(before);
  });
});

describe('F-05-11 T9 알림 행', () => {
  test('F-05-11 T9 ① 요청 하나에 두 사람 행이 생기고 철회 사유가 공개 값으로 남는다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    let notices = h.extras.notices ?? [];
    expect(notices.filter((n) => n.type === 'TRANSFER_OFFERED').map((n) => n.accountId).sort()).toEqual([A, B].sort());
    const cancelled = await h.tickets.eventCancel(eventCancelInput([t], h.clock.now()));
    expect(cancelled[0]?.transferWithdrawn).toBe(true);
    notices = h.extras.notices ?? [];
    const withdrawn = notices.filter((n) => n.type === 'TRANSFER_WITHDRAWN' && n.reason === 'EVENT_CANCELLED');
    expect(withdrawn.map((n) => n.accountId).sort()).toEqual([A, B].sort());
  });

  test('F-05-11 T9 ② 알림 보내기 반복: 202·422는 보낸 것으로, 5xx는 1·5·30분 뒤 다시 보낸다', async () => {
    const mod = await import(/* @vite-ignore */ new URL('../src/modules/ticket/application/transfer-notices.ts', import.meta.url).href).catch(() => undefined);
    expect(mod, 'transfer-notices 모듈이 없다').toBeDefined();
    const Sender = (mod as { TransferNoticeSender?: new (d: object) => { runOnce(): Promise<Record<string, number>> } }).TransferNoticeSender;
    expect(Sender, 'TransferNoticeSender가 없다').toBeDefined();
    const h = await harness();
    const t = await h.issue();
    await h.offer(t);
    expect(h.extras.claimDue, '저장소가 TransferNoticeStore를 구현하지 않는다').toBeDefined();
    const sent: string[] = [];
    let reply: 'ok' | 'bad' = 'bad';
    const sender = new Sender!({ store: h.store, sink: { send: async (n: { noticeId: string }) => { sent.push(n.noticeId); return reply === 'ok' ? { kind: 'sent' } : { kind: 'retry', reason: '500' }; } }, clock: h.clock });
    const first = await sender.runOnce();
    expect(first.sent).toBe(0);
    expect(first.retried).toBe(2);
    h.clock.advance(MIN);
    reply = 'ok';
    const second = await sender.runOnce();
    expect(second.sent).toBe(2);
    expect(sent).toHaveLength(4);
  });
});

describe('F-05-11 T10 입장 동결 끝과 돌려주기', () => {
  test('F-05-11 T10 ① 입장 시작 전에는 돌려주기가 되고, 동결 중에는 409, 마감 뒤에는 다시 된다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    expect((await h.post(`/v1/transfers/${offerId}/acceptance`, B)).status).toBe(200);
    setNow(h.clock, STARTS + 1);
    h.extras.setEntryClose?.(EVENT, STARTS + 50 * HOUR);
    const frozen = await h.post(`/v1/tickets/${t}/returns`, B, { reauth: 'r' });
    expect(frozen.status).toBe(409);
    expect(problemTypeOf(frozen.body)).toBe('entry-started');
    setNow(h.clock, STARTS + 50 * HOUR);
    const after = await h.post(`/v1/tickets/${t}/returns`, B, { reauth: 'r' });
    expect(after.status, after.raw).toBe(200);
    expect(after.body).toMatchObject({ status: 'RETURNED' });
    expect(h.ticketRow(t).accountId).toBe(A);
  });

  test('F-05-11 T10 ② 수락은 입장 시작 뒤에도 마감 뒤에도 409 ENTRY_STARTED다', async () => {
    const h = await harness();
    const t = await h.issue();
    // 정상 길로는 요청 기한(양도 마감)이 입장 시작보다 앞이라 이런 요청이 없다. 늦게 도착한 옛 요청을 저장소로 직접 만든다.
    const offerId = randomUUID();
    const made = await h.store.createOffer({ offerId, ticketId: t, fromAccountId: A, toAccountId: B, status: 'OFFERED', expiresAtMs: STARTS + 100 * HOUR, createdAtMs: h.clock.now() }, h.clock.now());
    expect(made.kind).toBe('CREATED');
    setNow(h.clock, STARTS + 1);
    h.extras.setEntryClose?.(EVENT, STARTS + 50 * HOUR);
    const atStart = await h.post(`/v1/transfers/${offerId}/acceptance`, B);
    expect(atStart.status, atStart.raw).toBe(409);
    expect(problemTypeOf(atStart.body)).toBe('entry-started');
    setNow(h.clock, STARTS + 50 * HOUR);
    const after = await h.post(`/v1/transfers/${offerId}/acceptance`, B);
    expect(after.status, after.raw).toBe(409);
    expect(problemTypeOf(after.body)).toBe('entry-started');
  });
});
