// 받는 층: gRPC WithdrawalParticipantService.ProcessAccountWithdrawal·QuoteAccountWithdrawal(docs/api/proto/peaket/purchase/v1/account.proto,
// docs/features/payment.md §4.1 '탈퇴 참여자의 첫 구현' '계약' '답' '미사용 티켓 견적', docs/features/identity.md §8 '미사용 티켓 확인과 취소',
// ADR-0284 결정 1·7, BUILD_ORDER PRF-169·PRF-174, P-T55 ⑥, I-T26 ①, BAT-010·BAT-013 시험 담당).
// 실제 grpc-js 서버를 루프백에 띄우고 계약 설명자로 만든 클라이언트로 부른다. 쓰임새는 기록 대역이다(실제 DB·payment-svc는 test-int/withdrawal-participant.int.test.ts).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { type ProcessAccountWithdrawalResult, type QuoteAccountWithdrawal, type UnusedTicketsQuote, withdrawalParticipantHandlers, WithdrawalOrdersUnavailable } from '../src/modules/booking/index.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Pkg = { WithdrawalParticipantService: grpc.ServiceClientConstructor };
const pkg = (() => {
  const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], LOAD);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: Pkg } } }).peaket.purchase.v1;
})();
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
type Client = grpc.Client & { ProcessAccountWithdrawal: Unary; QuoteAccountWithdrawal: Unary };

const TOKEN = 'bat010-purchase-internal-token';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000055b1';
const ZERO_QUOTE: UnusedTicketsQuote = { count: 0, ticketAmount: 0, deductionAmount: 0, refundAmount: 0, transferableCount: 0, deferredRefundCount: 0 };
const runs: { accountId: string; deadlineAtMs: number; at: number }[] = [];
const quoteRuns: { accountId: string; deadlineAtMs: number; at: number }[] = [];
const errors: string[] = [];
let next: () => Promise<ProcessAccountWithdrawalResult> = async () => ({ state: 'DONE', reasons: [], paymentPendingOrders: 0, depositOrdersCancelled: 0, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
let quoteNext: () => Promise<UnusedTicketsQuote> = async () => ZERO_QUOTE;
const service = {
  run: async (i: { accountId: string; deadlineAtMs: number }) => {
    runs.push({ ...i, at: Date.now() });
    return next();
  },
  quote: {
    run: async (i: { accountId: string; deadlineAtMs: number }): Promise<UnusedTicketsQuote> => {
      quoteRuns.push({ ...i, at: Date.now() });
      return quoteNext();
    },
  } satisfies Pick<QuoteAccountWithdrawal, 'run'>,
};

const servers: grpc.Server[] = [];
const clients: Client[] = [];
async function start(internalToken?: string, withQuote = true): Promise<Client> {
  const s = new grpc.Server();
  s.addService(pkg.WithdrawalParticipantService.service, withdrawalParticipantHandlers(withQuote ? service : { run: service.run }, { ...(internalToken ? { internalToken } : {}), onError: (m) => void errors.push(m) }));
  const port = await new Promise<number>((res, rej) => s.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  servers.push(s);
  const c = new pkg.WithdrawalParticipantService(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as unknown as Client;
  clients.push(c);
  return c;
}

let guarded: Client;
let open: Client;
beforeAll(async () => {
  guarded = await start(TOKEN);
  open = await start();
});
afterAll(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.tryShutdown(() => r()))));
});
beforeEach(() => {
  runs.length = 0;
  quoteRuns.length = 0;
  errors.length = 0;
  next = async () => ({ state: 'DONE', reasons: [], paymentPendingOrders: 0, depositOrdersCancelled: 0, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
  quoteNext = async () => ZERO_QUOTE;
});

const md = (o: { token?: string | null; caller?: string | null } = {}) => {
  const m = new grpc.Metadata();
  if (o.token !== null) m.set('x-peaket-internal-grpc-token', o.token ?? TOKEN);
  if (o.caller !== null) m.set('x-peaket-internal-grpc-caller', o.caller ?? 'identity-svc');
  return m;
};
const call = (c: Client, accountId: string, metadata = md(), deadlineMs = 3_000) =>
  new Promise<Record<string, unknown>>((res, rej) => c.ProcessAccountWithdrawal({ account_id: accountId }, metadata, { deadline: new Date(Date.now() + deadlineMs) }, (e, v) => (e ? rej(e) : res(v!))));
const quoteCall = (c: Client, accountId: string, metadata = md(), deadlineMs = 2_000) =>
  new Promise<Record<string, unknown>>((res, rej) => c.QuoteAccountWithdrawal({ account_id: accountId }, metadata, { deadline: new Date(Date.now() + deadlineMs) }, (e, v) => (e ? rej(e) : res(v!))));
const codeOf = async (p: Promise<unknown>) => p.then(() => 'OK', (e: grpc.ServiceError) => grpc.status[e.code]);

describe('부르는 쪽 확인과 입력 검사(P-T55 ⑥)', () => {
  test('P-T55⑥_내부토큰이설정되면토큰이없거나틀린호출은UNAUTHENTICATED이고쓰임새를부르지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    expect(await codeOf(call(guarded, ACCOUNT, md({ token: null })))).toBe('UNAUTHENTICATED');
    expect(await codeOf(call(guarded, ACCOUNT, md({ token: 'wrong-token' })))).toBe('UNAUTHENTICATED');
    expect(await codeOf(call(guarded, ACCOUNT, md({ token: `${TOKEN}x` })))).toBe('UNAUTHENTICATED');
    expect(runs).toEqual([]);
  });

  test('P-T55⑥_부르는쪽이름이identity-svc가아니면(없음·다른서비스·대소문자다름)PERMISSION_DENIED이고쓰임새를부르지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    for (const caller of [null, 'ops-svc', 'purchase-svc', 'Identity-svc', 'identity-svc ']) {
      expect({ caller, code: await codeOf(call(guarded, ACCOUNT, md({ caller }))) }).toEqual({ caller, code: 'PERMISSION_DENIED' });
    }
    expect(runs).toEqual([]);
  });

  test('P-T55⑥_계정ID가대문자이거나UUID가아니거나비면INVALID_ARGUMENT이고아무것도부르지않는다 [ASVS v5.0.0-8.2.2]', async () => {
    for (const bad of [ACCOUNT.toUpperCase(), '0190F3A1-7c2e-7a00-8000-0000000055b1', 'not-a-uuid', '', `${ACCOUNT} `, `${ACCOUNT}0`]) {
      expect({ bad, code: await codeOf(call(guarded, bad)) }).toEqual({ bad, code: 'INVALID_ARGUMENT' });
    }
    expect(runs).toEqual([]);
  });

  test('P-T55⑥_identity-svc가맞은토큰으로부르면그계정ID와호출의데드라인을마감시각으로넘긴다', async () => {
    const before = Date.now();
    expect(await call(guarded, ACCOUNT, md(), 2_500)).toMatchObject({ state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE' });
    expect(runs.map((r) => r.accountId)).toEqual([ACCOUNT]);
    expect(runs[0]!.deadlineAtMs).toBeGreaterThan(before + 2_000);
    expect(runs[0]!.deadlineAtMs).toBeLessThanOrEqual(Date.now() + 2_500);
  });

  test('P-T55⑥_내부토큰이없는local·ci는토큰·호출자를보지않는다(계정ID검사는그대로)', async () => {
    expect(await call(open, ACCOUNT, md({ token: null, caller: null }))).toMatchObject({ state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE' });
    expect(await codeOf(call(open, 'NOT-A-UUID', md({ token: null, caller: null })))).toBe('INVALID_ARGUMENT');
    expect(runs).toHaveLength(1);
  });
});

describe('답과 오류(P-T55 ⑥, payment §4.1 답)', () => {
  test('P-T55②④_PENDING답은state·reasons(겹치지않게)·세수와미사용티켓두칸을계약모양으로싣는다', async () => {
    next = async () => ({ state: 'PENDING', reasons: ['PAYMENT_PENDING_ORDER', 'DEPOSIT_CANCEL_PENDING'], paymentPendingOrders: 2, depositOrdersCancelled: 1, depositOrdersPending: 3, unusedTicketsCancelled: 0, unusedTicketsPending: 0 });
    expect(await call(guarded, ACCOUNT)).toEqual({
      state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING',
      reasons: ['WITHDRAWAL_PENDING_REASON_PAYMENT_PENDING_ORDER', 'WITHDRAWAL_PENDING_REASON_DEPOSIT_CANCEL_PENDING'],
      payment_pending_orders: 2,
      deposit_orders_cancelled: 1,
      deposit_orders_pending: 3,
      unused_tickets_cancelled: 0,
      unused_tickets_pending: 0,
    });
  });

  test('P-T55①③_DONE답은이유가비고세수와미사용티켓두칸을싣는다', async () => {
    next = async () => ({ state: 'DONE', reasons: [], paymentPendingOrders: 0, depositOrdersCancelled: 2, depositOrdersPending: 0, unusedTicketsCancelled: 1, unusedTicketsPending: 0 });
    expect(await call(guarded, ACCOUNT)).toEqual({
      state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE',
      reasons: [],
      payment_pending_orders: 0,
      deposit_orders_cancelled: 2,
      deposit_orders_pending: 0,
      unused_tickets_cancelled: 1,
      unused_tickets_pending: 0,
    });
  });

  test('I-T26②③_TICKET_REFUND_PENDING이유와미사용티켓두칸을계약이름그대로싣는다', async () => {
    next = async () => ({ state: 'PENDING', reasons: ['TICKET_REFUND_PENDING'], paymentPendingOrders: 0, depositOrdersCancelled: 0, depositOrdersPending: 0, unusedTicketsCancelled: 0, unusedTicketsPending: 2 });
    expect(await call(guarded, ACCOUNT)).toEqual({
      state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING',
      reasons: ['WITHDRAWAL_PENDING_REASON_TICKET_REFUND_PENDING'],
      payment_pending_orders: 0,
      deposit_orders_cancelled: 0,
      deposit_orders_pending: 0,
      unused_tickets_cancelled: 0,
      unused_tickets_pending: 2,
    });
  });

  test('P-T55⑥_purchase DB에닿지못하면(WithdrawalOrdersUnavailable)UNAVAILABLE이고_그밖의오류는INTERNAL이다(DONE으로답하지않는다)', async () => {
    next = async () => {
      throw new WithdrawalOrdersUnavailable(new Error('연결 끊김'));
    };
    expect(await codeOf(call(guarded, ACCOUNT))).toBe('UNAVAILABLE');
    next = async () => {
      throw new Error('문법 오류(주입)');
    };
    expect(await codeOf(call(guarded, ACCOUNT))).toBe('INTERNAL');
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---- QuoteAccountWithdrawal(읽기 전용 견적) 받는 층(I-T26 ①, BAT-013) ----
describe('QuoteAccountWithdrawal의 부르는 쪽 확인과 답(I-T26 ①)', () => {
  test('I-T26①_견적도같은내부토큰·호출자검사를한다_토큰없음·틀림은UNAUTHENTICATED_다른호출자는PERMISSION_DENIED [ASVS v5.0.0-8.2.1]', async () => {
    expect(await codeOf(quoteCall(guarded, ACCOUNT, md({ token: null })))).toBe('UNAUTHENTICATED');
    expect(await codeOf(quoteCall(guarded, ACCOUNT, md({ token: `${TOKEN}x` })))).toBe('UNAUTHENTICATED');
    for (const caller of [null, 'ops-svc', 'purchase-svc', 'Identity-svc']) expect({ caller, code: await codeOf(quoteCall(guarded, ACCOUNT, md({ caller }))) }).toEqual({ caller, code: 'PERMISSION_DENIED' });
    expect(quoteRuns).toEqual([]);
  });

  test('I-T26①_견적도계정ID가소문자UUID가아니면INVALID_ARGUMENT이고아무것도읽지않는다 [ASVS v5.0.0-8.2.2]', async () => {
    for (const bad of [ACCOUNT.toUpperCase(), 'not-a-uuid', '', `${ACCOUNT} `, `${ACCOUNT}0`]) expect({ bad, code: await codeOf(quoteCall(guarded, bad)) }).toEqual({ bad, code: 'INVALID_ARGUMENT' });
    expect(quoteRuns).toEqual([]);
  });

  test('I-T26①_견적답여섯칸을계약이름그대로돌려주고_계정ID와호출데드라인을쓰임새에넘긴다', async () => {
    quoteNext = async () => ({ count: 2, ticketAmount: 165_833, deductionAmount: 19_916, refundAmount: 145_917, transferableCount: 1, deferredRefundCount: 1 });
    const before = Date.now();
    expect(await quoteCall(guarded, ACCOUNT, md(), 2_000)).toEqual({ unused_tickets: 2, ticket_amount: 165_833, deduction_amount: 19_916, refund_amount: 145_917, transferable_tickets: 1, refund_deferred_tickets: 1 });
    expect(quoteRuns.map((r) => r.accountId)).toEqual([ACCOUNT]);
    expect(quoteRuns[0]!.deadlineAtMs).toBeGreaterThan(before + 1_500);
    expect(quoteRuns[0]!.deadlineAtMs).toBeLessThanOrEqual(Date.now() + 2_000);
  });

  test('I-T26①_0장이면모든칸0을돌려준다', async () => {
    expect(await quoteCall(guarded, ACCOUNT)).toEqual({ unused_tickets: 0, ticket_amount: 0, deduction_amount: 0, refund_amount: 0, transferable_tickets: 0, refund_deferred_tickets: 0 });
  });

  test('I-T26①_purchase DB·판매설정에닿지못하면UNAVAILABLE이고_그밖의오류는INTERNAL이다', async () => {
    quoteNext = async () => {
      throw new WithdrawalOrdersUnavailable(new Error('연결 끊김'));
    };
    expect(await codeOf(quoteCall(guarded, ACCOUNT))).toBe('UNAVAILABLE');
    quoteNext = async () => {
      throw new Error('문법 오류(주입)');
    };
    expect(await codeOf(quoteCall(guarded, ACCOUNT))).toBe('INTERNAL');
    expect(errors).toContain('QuoteAccountWithdrawal');
  });

  test('I-T26①_견적을주지않은옛조립(quote없음)은Process만열고_견적RPC는UNIMPLEMENTED다', async () => {
    const old = await start(TOKEN, false);
    expect(await call(old, ACCOUNT)).toMatchObject({ state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE' });
    expect(await codeOf(quoteCall(old, ACCOUNT))).toBe('UNIMPLEMENTED');
    expect(quoteRuns).toEqual([]);
  });
});
