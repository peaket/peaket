// 결제 결과 당기기(ADR-0140)의 purchase DB 쪽(booking DrizzlePaymentPull: PaymentPullTargets)과 실행기(PaymentResultPuller)를 실제 PostgreSQL 18로 돈다(BUILD_ORDER PRF-171).
// 승인 명령 접수 뒤 작업 행을 AWAIT로 남기는 Saga 쪽(DrizzleSaga·OrderSagaRunner)과 중간 결과 뒤의 작업 행(DrizzlePaymentResults)도 실제 DB로 본다.
// 정본: docs/features/payment.md §2 '결제 결과 당기기의 첫 구현'(결과를 기다리는 주문 찾기·Saga 실행기와 갈림·대상과 주기·실행기·답을 결과 사건으로 바꾸기·반영·
// 중간 결과 뒤에도 당긴다)·'Saga 1단계의 첫 구현' 단계 CONFIRM(접수되면 작업 행을 AWAIT로 남김, 정해진 거절로 1시간 미룬 CONFIRM 행도 당기기 대상)·
// '결제 결과 반영의 첫 구현'(승인 트랜잭션의 작업 행 정리는 단계와 상관없이, 실패 트랜잭션은 작업 행을 RELEASE로), ADR-0140 결정 1~4,
// docs/data.md order_saga_job(ERD)·§4 열한 번째 마이그레이션(0010)·§5 '결과 당기기를 두 파드가 함께 잡음'·§5.1 '결과 당기기 대상',
// 시험 표 P-T47(당기기로 확정, 늦게 온 사건의 중복 반영 0건)·P-T15(사건·당기기 두 길의 중복), booking domain/ports.ts 당기기 절과
// adapters/db/drizzle-payment-pull.ts·application/payment-result-pull.ts·domain/payment-pull.ts 머리 주석.
//
// 약속:
// - 마이그레이션은 scripts/migrate.mjs의 migratePurchase(0010까지), Outbox 일 파티션은 ensureOutboxPartitions(기준 시각의 가짜 시계)로 만든다.
// - 승인 명령을 접수시킨 주문은 saga-db·payment-result-e2e.int.test.ts의 차례를 본떠 운영 경로로 만든다: 주문(T1) → READY 결제 시도 → 결제 접수(DrizzleOrderAccepts,
//   작업 RESERVE) → 판매 예약 뒤 상태(T7 + DrizzleSeatSales.reserve + 작업 행 CONFIRM, SQL) → Saga 실행기(OrderSagaRunner.runOne + DrizzleSaga, 승인 명령은 기록 대역)의
//   단계 CONFIRM. 단계 CONFIRM은 좌석 Redis를 쓰지 않으므로 Valkey 컨테이너를 띄우지 않는다(좌석 묶기·회차 설정 포트는 부르면 던지는 대역).
// - 잡기 조건 시험(DrizzlePaymentPull.claimDue·defer)은 작업 행을 SQL로 넣는다(putJob: 주문 T1 + 결제 시도 + 칸을 마음대로 둔 작업 행). Saga 쪽 고침에 기대지 않게.
// - 당기기와 Saga 잡기는 회차·주문을 가리지 않고 작업 표를 훑으므로 시험마다 작업 표를 비운다(시험은 차례로 돈다).
// - 시각은 시험마다 따로 만든 가짜 시계다. 잡기 기준·pull_next_at·작업 행·발권 큐의 '지금'은 앱 시계(각 어댑터의 clock)다.
// - payment-svc BatchGetPayments는 기록 대역이다(부른 주문 ID·데드라인을 적고, 시험이 정한 답 가운데 물은 주문의 것만 돌려준다). 반영은 실제 ApplyPaymentResult
//   (DrizzlePaymentResults)이고 커밋 뒤 일(구매 세션 끝내기·Saga 깨우기)은 기록 대역이다. 실행기는 손으로 부르는 타이머로 만들고 tick()을 직접 부른다.
// - 사건 길(trade.payments)은 payment-result-e2e.int.test.ts와 같이 플랫폼 KeyedPartition + PaymentResultHandler로 Kafka 없이 민다.
// - 기대 값은 정본에서 따로 적는다(5초·30초·60초·10분·100건·500ms·30분·1시간). 운영 상수를 기대 값으로 쓰지 않는다.
// - 리뷰 고침(2026-11-06): H1 답의 상태로 다음 점검(UNKNOWN 30초·입금 대기 60초, 건너뛴 반영도), M1 AWAIT 행의 next_attempt_at 무한대,
//   M3 보류 10분, M4 보류 사건이 있는 주문은 대상에서 뺀다(docs/features/payment.md §2 '결과를 기다리는 주문 찾기'·'Saga 실행기와 갈림'·'기록 없음이 길어질 때').
//
// 정본 모호(ports.ts·drizzle-payment-pull.ts·payment-result-pull.ts의 [정함]을 따른다):
// - attemptNo는 그 주문의 결제 시도를 만든 차례(created_at)로 ACCEPTED 시도가 몇 번째인가(1부터)이고, ACCEPTED 시도가 없으면 0이다.
// - claimDue는 pull_next_at(비었으면 confirm_sent_at) 오름차순으로 고르고 그 차례로 돌려준다. Saga 임대(lease_until)가 걸린 행도 고른다(data.md §5.1의 잡기 조건에 임대가 없다).
// - 승인 명령 접수 뒤 Saga는 pull_next_at을 쓰지 않는다(schema.ts: Saga 실행기는 이 칸을 읽거나 쓰지 않는다). 그래서 접수 직후 pull_next_at은 비어 있다.
//   AWAIT 행의 attempts·lease_until은 정본에 없어 보지 않는다(next_attempt_at은 무한대다, data.md §5.1 '결과 당기기 대상', 리뷰 고침 M1). Saga runOne이 AWAIT 행을 집지 못했을 때의 까닭(NO_JOB·LEASED)도 정본에 없어 SKIPPED만 본다.
// - 중간 결과(T12·T10)의 pull_next_at은 그 반영 트랜잭션의 '지금'(앱 시계) + 30초·60초로 본다.
// - tick()은 잡은 대상의 호출·반영·미루기를 다 마친 뒤 끝난다고 본다(PaymentPullTickResult가 틱 하나의 결과다). 잡은 것이 없으면 BatchGetPayments를 부르지 않는다.
// - 보류(HOLD)로 끝난 반영의 로그는 반영 쪽(PaymentResultLog.held)이 남기고 당기기 로그에는 줄이 없다(payment-result-pull.ts ③).
// 시험 이름의 앞 표지는 이 폴더의 꼴(PT47_·PT15_·ADR0140_)이고 ASVS는 끝에 둔다.
import { randomUUID } from 'node:crypto';
import {
  type ConsumedMessage,
  createDatabase,
  type Database,
  drizzleHeldEventStore,
  ensureOutboxPartitions,
  fakeClock,
  KeyedPartition,
  requestFingerprint,
  uuidv7,
} from '@peaket/platform';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  type AcceptInput,
  type AppliedPaymentEventType,
  ApplyPaymentResult,
  type ConfirmCommand,
  type ConfirmOutcome,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzlePaymentPull,
  DrizzlePaymentResults,
  DrizzleSaga,
  type NewOrder,
  type OrderPaymentState,
  type OrderRequestOnce,
  OrderSagaRunner,
  type PaymentConfirms,
  type PaymentPullLog,
  type PaymentPullSignals,
  type PaymentPullTarget,
  type PaymentRefs,
  type PaymentResultEvent,
  type PaymentResultLog,
  type PaymentResultReader,
  PaymentResultHandler,
  type PaymentResultRecord,
  PaymentResultPuller,
  type SagaLog,
  type TransitionId,
} from '../src/modules/booking/index.js';
import { DrizzleSeatSales } from '../src/modules/inventory/index.js';
import { accountActor, BASE_MS, HOUR, iso, makeItems, newOrderInput, rejections, SAGA } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer | undefined;
/** 어댑터가 쓰는 풀(첫째 파드) */
let database: Database;
/** 읽기·준비용 풀 */
let admin: Database;
/** 둘째 파드 쪽 풀(행 잠금을 쥐는 연결·두 번째 잡기) */
let race: Database;

const APP = 'payment-pull-test';
const RACE = 'payment-pull-race';
const LIMIT = 4;
const MIN = 60_000;
/** 승인 명령을 보낸 뒤 당기기 대상이 되기까지 5초 [가정](payment §2 '대상과 주기') */
const AFTER_SENT_MS = 5_000;
/** 잡을 때 쓰는 다음 점검 = 지금 + 5초 [가정](같은 주문은 5초에 한 번, ADR-0140 결정 1) */
const REPEAT_MS = 5_000;
/** 취소 상태·모양 틀림의 다음 점검 = 지금 + 60초 [가정](payment §2 '답을 결과 사건으로 바꾸기') */
const SLOW_MS = 60_000;
/** 보류(HOLD)·기록 없음 10분의 다음 점검 = 지금 + 10분 [가정](payment §2 '기록 없음이 길어질 때', 2026-11-06 코드 리뷰 M3) */
const LONG_MS = 10 * MIN;
/** UNKNOWN(T12) 반영 뒤 다음 점검 = 지금 + 30초 [가정](payment §2 '중간 결과 뒤에도 당긴다') */
const AFTER_UNKNOWN_MS = 30_000;
/** 입금 대기(T10·T14) 반영 뒤 다음 점검 = 지금 + 60초 [가정](payment §2 '중간 결과 뒤에도 당긴다') */
const AFTER_DEPOSIT_MS = 60_000;
/** 잡기 한 번·BatchGetPayments 한 번의 상한 100건 [가정](ADR-0140 결정 1) */
const BATCH = 100;
/** BatchGetPayments 데드라인 500ms [가정](ADR-0140 결정 3) */
const DEADLINE_MS = 500;
/** 발권 기한 = 승인 + 30분 [가정](data.md ticket_issue_job.issue_due_at) */
const ISSUE_WINDOW_MS = 30 * MIN;
/** 정해진 거절이면 작업을 1시간 [가정] 미룬다(payment §2 단계 CONFIRM) */
const PARK_MS = HOUR;
/** Saga 임대 30초 [가정](payment §2 Saga 실행기) */
const LEASE = 30_000;
/** trade.payments(asyncapi). 운영 상수를 가져오지 않고 따로 적는다 */
const TOPIC = 'trade.payments';
/** 결과 반영 전 이력(T1 생성 → T3·T4 결제 접수 → T7 판매 예약) */
const BEFORE_RESULT = ['T1', 'T3', 'T4', 'T7'];
const NO_REFS = { pg_payment_key: null, pg_tx_id: null, pg_payment_token: null };

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 10, applicationName: APP });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'payment-pull-admin' });
  race = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: RACE });
  await ensureOutboxPartitions(admin, fakeClock({ now: BASE_MS }));
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close(), race?.close()]);
  server?.stop();
});

/** 시험이 만든 실행기의 멈추기(시험마다 부른다. 뼈대의 stop은 던지므로 약속 안에서 부른다) */
const stoppers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  // 작업 표를 훑는 잡기(당기기·Saga)가 다른 시험의 행을 잡지 않게(머리 주석 '약속')
  await q('delete from order_saga_job');
});

afterEach(async () => {
  await Promise.allSettled(stoppers.splice(0).map((stop) => Promise.resolve().then(stop)));
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(text, params))[0]!.n);
const dateOrNull = (ms: number | null | undefined): Date | null => (ms === null || ms === undefined ? null : new Date(ms));

function recordingResultLog(): PaymentResultLog & { lines: { kind: string; e: unknown }[] } {
  const lines: { kind: string; e: unknown }[] = [];
  return {
    lines,
    held: (e) => void lines.push({ kind: 'held', e }),
    afterCommitFailed: (e) => void lines.push({ kind: 'afterCommitFailed', e }),
  };
}

/** 시험 하나의 가짜 시계·주문 전이 함수·접수·Saga·결제 결과 반영(실제 쓰임새, 커밋 뒤 일은 기록 대역)·당기기 대상 어댑터 */
function fresh(startMs = BASE_MS) {
  const clock = fakeClock({ now: startMs });
  const store = new DrizzleOrderStore({ clock });
  const sales = new DrizzleSeatSales(database);
  const results = new DrizzlePaymentResults({ database, store, sales, clock });
  const resultLog = recordingResultLog();
  const kicked: string[] = [];
  const apply = new ApplyPaymentResult({
    reads: results,
    writes: results,
    sessions: { complete: async () => true, unmarkPaying: async () => true },
    saga: { kick: (orderId) => void kicked.push(orderId) },
    log: resultLog,
    clock,
  });
  return {
    clock,
    store,
    sales,
    apply,
    resultLog,
    kicked,
    accepts: new DrizzleOrderAccepts({ database, store, clock }),
    saga: new DrizzleSaga({ database, store, sales, clock }),
    pull: new DrizzlePaymentPull({ database, clock }),
  };
}
type Fresh = ReturnType<typeof fresh>;

/** 주문 하나(T1, 지금 시각, 좌석 2) */
async function placed(s: Fresh): Promise<NewOrder> {
  const order = newOrderInput(s.clock, { items: makeItems(2) });
  await database.transaction((tx) => s.store.createOrder(tx, order));
  return order;
}
async function walk(s: Fresh, o: NewOrder, path: readonly TransitionId[]): Promise<void> {
  for (const transition of path) {
    const r = await database.transaction((tx) => s.store.transition(tx, { orderId: o.id, transition, actor: SAGA }));
    expect(r.status, transition).toBe('APPLIED');
  }
}

/** 결제 시도 한 행(결제 참조 없음, 만든 시각 atMs) */
async function putAttempt(s: Fresh, o: NewOrder, x: { status?: string; atMs?: number } = {}): Promise<string> {
  const id = uuidv7(s.clock);
  await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [
    id,
    o.id,
    'TOSS',
    o.id,
    x.status ?? 'READY',
    new Date(x.atMs ?? s.clock.now()),
  ]);
  return id;
}
const onceOf = (o: NewOrder): OrderRequestOnce => ({
  accountRef: o.accountId,
  operation: 'ACCEPT_PAYMENT',
  key: randomUUID(),
  requestHash: requestFingerprint('POST', `/v1/orders/${o.id}/payment-acceptance`, Buffer.from(JSON.stringify({ n: randomUUID() }), 'utf8')),
});
const tossRefs = (): PaymentRefs => ({ pg: 'TOSS', paymentKey: `tgen_${randomUUID().replaceAll('-', '')}` });

interface Accepted {
  o: NewOrder;
  attemptId: string;
}
/** 접수된 주문(ACCEPTED, 시도 ACCEPTED·결제 참조, 작업 RESERVE). 운영 접수 어댑터(PRF-162)로 만든다 */
async function accepted(s: Fresh): Promise<Accepted> {
  const o = await placed(s);
  const attemptId = await putAttempt(s, o);
  s.clock.advance(1_000);
  const input: AcceptInput = { orderId: o.id, attemptId, eventId: o.eventId, refs: tossRefs(), seatGen: 1, actor: accountActor(o.accountId) };
  expect(await s.accepts.accept(onceOf(o), input)).toEqual({ status: 'ACCEPTED' });
  return { o, attemptId };
}
/** 판매 예약 뒤 상태(RESERVED, 판매 행 PENDING·한도, 작업 CONFIRM). saga-db.int.test.ts와 같은 길 */
async function reservedByHand(s: Fresh, a: Accepted): Promise<void> {
  await walk(s, a.o, ['T7']);
  const r = await s.sales.reserve({ eventId: a.o.eventId, orderId: a.o.id, accountId: a.o.accountId, seatIds: a.o.items.map((it) => it.seatId), limit: LIMIT });
  expect(r).toEqual({ status: 'RESERVED' });
  await q(`update order_saga_job set step = 'CONFIRM', attempts = 0 where order_id = $1`, [a.o.id]);
}

/** 승인 명령 기록 대역(기본 늘 ACCEPTED). 보내기 바로 전에 beforeSend(confirm_sent_at 적기)를 부른다 */
function recordingConfirms(answer: () => ConfirmOutcome = () => ({ status: 'ACCEPTED', result: 'IN_PROGRESS' })): PaymentConfirms & { calls: ConfirmCommand[] } {
  const calls: ConfirmCommand[] = [];
  return {
    calls,
    confirm: async (c, o): Promise<ConfirmOutcome> => {
      await o?.beforeSend?.();
      calls.push(c);
      return answer();
    },
  };
}
function recordingSagaLog(): SagaLog & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    releaseFailed: () => void lines.push('releaseFailed'),
    confirmRejected: () => void lines.push('confirmRejected'),
    stepError: (e) => void lines.push(`stepError:${e.step}:${String(e.err)}`),
  };
}
const manualTimer = { setInterval: () => 1, clearInterval: () => {} };
const noSeatStore = (): never => {
  throw new Error('이 시험은 좌석 Redis·회차 설정을 쓰지 않는다(Saga 단계 CONFIRM만 돈다)');
};

/** Saga 실행기(DrizzleSaga, 승인 명령 기록 대역). 단계 CONFIRM만 도므로 좌석 묶기·회차 설정은 부르면 던지는 대역이다 */
function sagaRunnerOf(s: Fresh, answer?: () => ConfirmOutcome) {
  const confirms = recordingConfirms(answer);
  const log = recordingSagaLog();
  const runner = new OrderSagaRunner({
    jobs: s.saga,
    orders: s.saga,
    reserve: s.saga,
    failures: s.saga,
    confirmSent: s.saga,
    pins: { pin: async () => noSeatStore(), releaseFailed: async () => noSeatStore() },
    confirms,
    configs: { get: async () => noSeatStore() },
    log,
    clock: s.clock,
    timer: manualTimer,
  });
  stoppers.push(() => runner.stop());
  return { runner, confirms, log };
}

/** 승인 명령을 접수시킨 주문(RESERVED, Saga 단계 CONFIRM을 운영 경로로 한 번 돈다). sentAt = 보내기 바로 전에 적은 시각 */
async function confirmedBySaga(s: Fresh): Promise<Accepted & { sentAt: number }> {
  const a = await accepted(s);
  await reservedByHand(s, a);
  const { runner } = sagaRunnerOf(s);
  const sentAt = s.clock.now();
  expect(await runner.runOne(a.o.id)).toEqual({ kind: 'DONE' });
  return { ...a, sentAt };
}

interface JobSpec {
  step?: string;
  /** confirm_sent_at(epoch ms, null은 비움). 빠지면 지금 − 10초 */
  sentAtMs?: number | null;
  pullNextAtMs?: number | null;
  /** next_attempt_at(빠지면 지금) */
  nextAtMs?: number;
  leaseUntilMs?: number | null;
  /** 그 주문의 결제 시도(만든 차례). 빠지면 ACCEPTED 하나(지금) */
  payAttempts?: readonly { status: string; atMs: number }[];
}
interface Job {
  o: NewOrder;
  sentAtMs: number | null;
}
/** 작업 행을 직접 넣는다(주문은 T1만, 결제 시도는 payAttempts). 잡기 조건 시험이 Saga 쪽 고침에 기대지 않게 */
async function putJob(s: Fresh, x: JobSpec = {}): Promise<Job> {
  const o = await placed(s);
  const now = s.clock.now();
  for (const p of x.payAttempts ?? [{ status: 'ACCEPTED', atMs: now }]) await putAttempt(s, o, p);
  const sentAtMs = x.sentAtMs === undefined ? now - 10_000 : x.sentAtMs;
  await q(
    `insert into order_saga_job (order_id, event_id, step, attempts, next_attempt_at, lease_until, created_at, confirm_sent_at, pull_next_at)
     values ($1, $2, $3, 0, $4, $5, $6, $7, $8)`,
    [o.id, o.eventId, x.step ?? 'AWAIT', new Date(x.nextAtMs ?? now), dateOrNull(x.leaseUntilMs), new Date(now), dateOrNull(sentAtMs), dateOrNull(x.pullNextAtMs)],
  );
  return { o, sentAtMs };
}
/** 당기기 대상 하나의 기대 값 */
const targetOf = (j: Job, attemptNo = 1): PaymentPullTarget => ({ orderId: j.o.id, eventId: j.o.eventId, attemptNo, confirmSentAtMs: j.sentAtMs! });
const byOrder = <T extends { orderId: string }>(xs: readonly T[]): T[] => [...xs].sort((x, y) => (x.orderId < y.orderId ? -1 : x.orderId > y.orderId ? 1 : 0));

/** BatchGetPayments 기록 대역: 물은 주문 ID·데드라인을 적고, answers 가운데 물은 주문의 답만 돌려준다(없으면 기록 없음) */
interface ScriptedReader extends PaymentResultReader {
  readonly answers: Map<string, OrderPaymentState>;
  readonly calls: { orderIds: string[]; deadlineMs: number | undefined }[];
  /** 답하기 바로 전에 부를 것(사건 길이 먼저 반영하는 겹침) */
  beforeAnswer?: () => Promise<void>;
}
function scriptedReader(): ScriptedReader {
  const r: ScriptedReader = {
    answers: new Map(),
    calls: [],
    batchGet: async (orderIds, o) => {
      r.calls.push({ orderIds: [...orderIds], deadlineMs: o?.deadlineMs });
      await r.beforeAnswer?.();
      return orderIds.flatMap((id) => {
        const answer = r.answers.get(id);
        return answer ? [answer] : [];
      });
    },
  };
  return r;
}
/** 당기기 답 하나(OrderPaymentState). 기본은 이 주문의 금액·토스·APPROVED·순번 1 */
const stateOf = (a: Accepted, x: Partial<OrderPaymentState> = {}): OrderPaymentState => ({
  orderId: a.o.id,
  paymentId: randomUUID(),
  pg: 'TOSS',
  status: 'APPROVED',
  amount: a.o.amount,
  eventKey: randomUUID(),
  eventSeq: 1,
  ...x,
});

function recordingPullLog(): PaymentPullLog & { lines: { kind: string; e: unknown }[] } {
  const lines: { kind: string; e: unknown }[] = [];
  return {
    lines,
    missing: (e) => void lines.push({ kind: 'missing', e }),
    ignored: (e) => void lines.push({ kind: 'ignored', e }),
    runError: (e) => void lines.push({ kind: 'runError', e: { what: e.what, orderId: e.orderId, err: String(e.err) } }),
  };
}
function recordingPullSignals() {
  const seen = { pulled: [] as AppliedPaymentEventType[], batches: 0, failures: 0 };
  const signals: PaymentPullSignals = {
    pulled: (type) => void seen.pulled.push(type),
    batch: () => void (seen.batches += 1),
    failure: () => void (seen.failures += 1),
  };
  return { signals, seen };
}
/** 당기기 실행기(대상은 실제 DrizzlePaymentPull, 반영은 실제 ApplyPaymentResult, 로그·지표는 기록 대역, 손으로 부르는 타이머. 설정은 기본값) */
function pullerOf(s: Fresh, reader: PaymentResultReader) {
  const log = recordingPullLog();
  const { signals, seen } = recordingPullSignals();
  const puller = new PaymentResultPuller({ targets: s.pull, reader, apply: s.apply, log, signals, clock: s.clock, timer: manualTimer });
  stoppers.push(() => puller.stop());
  return { puller, log, seen };
}

/** 사건 길(trade.payments) 파티션 하나(Kafka 없이 KeyedPartition, 보류 표는 실제 held_event). 같은 결과일 실패 사이 쉬기는 기다리지 않는다 */
async function partitionOf(s: Fresh) {
  const errors: unknown[] = [];
  const p = new KeyedPartition<PaymentResultRecord>({
    topic: TOPIC,
    partition: 0,
    handler: new PaymentResultHandler(s.apply),
    held: drizzleHeldEventStore(database, s.clock),
    sleep: async () => {},
    onError: (e) => void errors.push(e),
  });
  await p.init();
  return { p, errors };
}
let offset = 0n;
/** trade.payments 메시지 하나(Kafka 키 = 회차 ID, 값 = PaymentEvent JSON) */
function messageOf(s: Fresh, value: Record<string, unknown>, key: string): ConsumedMessage {
  offset += 1n;
  return { topic: TOPIC, partition: 0, offset, key, value: Buffer.from(JSON.stringify(value), 'utf8'), headers: {}, timestamp: s.clock.now() };
}
/** 당기기 답과 같은 결과의 결제 사건 값(asyncapi PaymentEvent: 같은 eventKey·eventSeq·금액·결제사) */
const eventLike = (a: Accepted, st: OrderPaymentState, occurredAtMs: number): Record<string, unknown> => ({
  eventId: a.o.eventId,
  orderId: a.o.id,
  pg: st.pg,
  type: st.status,
  amount: st.amount,
  payMethodCategory: 'CARD',
  refMissing: false,
  result: 'APPROVED',
  attemptNo: 1,
  latencyMs: 120,
  occurredAt: iso(occurredAtMs),
  eventSeq: st.eventSeq,
  eventKey: st.eventKey,
});

const orderRow = async (id: string) =>
  (await q<{ status: string; failure_reason: string | null; payment_event_seq: string }>('select status, failure_reason, payment_event_seq::text as payment_event_seq from purchase_order where id = $1', [id]))[0];
const historyCauses = async (id: string) => (await q<{ cause: string }>('select cause from order_event where order_id = $1 order by seq', [id])).map((r) => r.cause);
const outboxTypes = async (eventId: string, orderId: string) =>
  (await q<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by outbox.seq', [eventId]))
    .map((r) => JSON.parse(Buffer.from(r.payload).toString('utf8')) as { type: string; orderId: string })
    .filter((e) => e.orderId === orderId)
    .map((e) => e.type);
/** 작업 행의 당기기 쪽 칸 */
const jobOf = async (orderId: string) =>
  (await q<{ step: string; confirm_sent_at: Date | null; pull_next_at: Date | null }>('select step, confirm_sent_at, pull_next_at from order_saga_job where order_id = $1', [orderId]))[0];
/** 작업 행의 Saga 실행기 칸(당기기는 읽기만 한다) */
const sagaColsOf = async (orderId: string) =>
  (
    await q<{ step: string; attempts: number; next_attempt_at: Date; lease_until: Date | null; confirm_sent_at: Date | null }>(
      'select step, attempts, next_attempt_at, lease_until, confirm_sent_at from order_saga_job where order_id = $1',
      [orderId],
    )
  )[0];
const pullNextOf = async (orderId: string) => (await jobOf(orderId))?.pull_next_at;
const issueJobOf = async (orderId: string) =>
  (await q<{ event_id: string; attempts: number; issue_due_at: Date }>('select event_id, attempts, issue_due_at from ticket_issue_job where order_id = $1', [orderId]))[0];
const issueJobCount = (orderId: string) => count('select count(*) as n from ticket_issue_job where order_id = $1', [orderId]);
const heldCount = (orderId: string) => count('select count(*) as n from held_event where business_key = $1', [orderId]);
const salesOf = (eventId: string) => q<{ seat_id: string; status: string }>('select seat_id, status from seat_sale where event_id = $1 order by seat_id', [eventId]);
const attemptRefs = async (id: string) =>
  (await q<{ pg_payment_key: string | null; pg_tx_id: string | null; pg_payment_token: string | null }>('select pg_payment_key, pg_tx_id, pg_payment_token from payment_attempt where id = $1', [id]))[0];
/** 작업 행의 next_attempt_at이 무한대(infinity)인가(드라이버마다 무한대를 읽는 모양이 달라 DB에서 견준다) */
const nextAttemptIsInfinity = async (orderId: string) =>
  (await q<{ inf: boolean }>(`select next_attempt_at = 'infinity'::timestamptz as inf from order_saga_job where order_id = $1`, [orderId]))[0]?.inf;
let heldOffset = 0;
/** 보류 표 한 행(다시 처리 전). 사건 길(KeyedPartition)이 넣는 칸과 같다. 위치는 다른 시험의 메시지와 겹치지 않게 큰 수다 */
async function putHeld(topic: string, businessKey: string, atMs: number): Promise<string> {
  const id = randomUUID();
  heldOffset += 1;
  await q(
    `insert into held_event (id, topic, partition, kafka_offset, event_key, business_key, error, msg_key, record_at, value, headers, held_at)
     values ($1, $2, 0, $3, $4, $5, 'PaymentResultHeld', null, $6, null, '{}'::jsonb, $6)`,
    [id, topic, 1_000_000_000 + heldOffset, randomUUID(), businessKey, new Date(atMs)],
  );
  return id;
}
/** 결제 결과 사건 하나(도메인 모양, 사건 길과 같은 칸). 기본은 UNKNOWN·순번 1 */
const resultEventOf = (s: Fresh, a: Accepted, x: Partial<PaymentResultEvent> = {}): PaymentResultEvent => ({
  eventId: a.o.eventId,
  orderId: a.o.id,
  pg: 'TOSS',
  type: 'UNKNOWN',
  amount: a.o.amount,
  refMissing: false,
  attemptNo: 1,
  occurredAt: iso(s.clock.now()),
  eventSeq: 1,
  eventKey: randomUUID(),
  ...x,
});

// ───────────────────────────── Saga: 접수 뒤 AWAIT ─────────────────────────────

describe('Saga 단계 CONFIRM: 승인 명령이 접수되면 작업 행을 지우지 않고 AWAIT로 남긴다(payment §2 단계 CONFIRM·결과를 기다리는 주문 찾기)', () => {
  test('ADR0140_승인 명령 접수(ACCEPTED) 뒤 runOne이 DONE이고, 작업 행은 AWAIT·confirm_sent_at = 보내기 바로 전에 적은 시각 그대로·pull_next_at 비움이며, 결제 참조는 비고 주문은 RESERVED다. 다시 돌려도 승인 명령을 더 보내지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await accepted(s);
    await reservedByHand(s, a);
    const { runner, confirms, log } = sagaRunnerOf(s);
    const sentAt = s.clock.now();

    expect(await runner.runOne(a.o.id)).toEqual({ kind: 'DONE' });

    expect(await jobOf(a.o.id)).toEqual({ step: 'AWAIT', confirm_sent_at: new Date(sentAt), pull_next_at: null });
    expect(await attemptRefs(a.attemptId)).toEqual(NO_REFS);
    expect(await orderRow(a.o.id)).toEqual({ status: 'RESERVED', failure_reason: null, payment_event_seq: '0' });
    expect(confirms.calls.map((c) => c.orderId)).toEqual([a.o.id]);
    expect(log.lines).toEqual([]);
    // 임대·다시 하기 기한이 지나도 Saga는 그 행을 집지 않는다(승인 명령은 한 번)
    s.clock.advance(LEASE + 1);
    expect((await runner.runOne(a.o.id)).kind).toBe('SKIPPED');
    expect(await runner.pollOnce()).toBe(0);
    expect(confirms.calls).toHaveLength(1);
    expect(await jobOf(a.o.id)).toEqual({ step: 'AWAIT', confirm_sent_at: new Date(sentAt), pull_next_at: null });
  });

  test('ADR0140_리뷰 고침 M1_AWAIT로 바꿀 때(승인 명령 접수 뒤 done, 중간 결과 반영 mark) Saga의 next_attempt_at을 무한대(infinity)로 둔다(Saga 잡기의 next_attempt_at 차례 앞을 막지 않게). get은 그 행을 던지지 않고 nextAttemptAtMs = Infinity로 읽고, reschedule은 AWAIT 행을 바꾸지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const done = await confirmedBySaga(s);
    expect(await nextAttemptIsInfinity(done.o.id)).toBe(true);
    expect(await s.saga.get(done.o.id)).toMatchObject({ orderId: done.o.id, step: 'AWAIT', nextAttemptAtMs: Number.POSITIVE_INFINITY });
    // Saga의 다시 하기(예: 승인 명령 답을 잃고 다시 보내려던 실행)가 AWAIT 행의 무한대를 되돌리지 않는다
    expect(await s.saga.reschedule(done.o.id, s.clock.now() + 1_000)).toBe(false);
    expect(await nextAttemptIsInfinity(done.o.id)).toBe(true);

    // 중간 결과(T12) 반영도 CONFIRM 행을 AWAIT로 바꾸며 무한대로 둔다
    const marked = await accepted(s);
    await reservedByHand(s, marked);
    expect(await nextAttemptIsInfinity(marked.o.id)).toBe(false);
    expect(await s.apply.execute(resultEventOf(s, marked))).toEqual({ status: 'APPLIED', transition: 'T12', write: 'MARK' });
    expect((await jobOf(marked.o.id))?.step).toBe('AWAIT');
    expect(await nextAttemptIsInfinity(marked.o.id)).toBe(true);
    // Saga 잡기는 둘 다 고르지 않고 던지지 않는다
    s.clock.advance(HOUR);
    expect(await s.saga.claimDue(50, LEASE)).toEqual([]);
  });
});

describe('Saga 실행기의 잡기는 AWAIT 행을 고르지 않는다(payment §2 Saga 실행기와 갈림)', () => {
  test('ADR0140_기한이 됐고 임대가 빈 AWAIT 행을 DrizzleSaga claim·claimDue가 고르지 않고(임대를 쓰지 않는다), 실행기 pollOnce·runOne이 그 주문에 승인 명령을 보내지 않는다. 같은 때 기한이 된 CONFIRM 행은 고른다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const waiting = await accepted(s);
    await reservedByHand(s, waiting);
    const now = s.clock.now();
    // 접수 뒤 남은 AWAIT 행을 손으로 만든다(Saga 쪽 고침에 기대지 않는다): 다시 하기 기한은 지났고 임대는 비었다
    await q(`update order_saga_job set step = 'AWAIT', confirm_sent_at = $2, next_attempt_at = $3, lease_until = null where order_id = $1`, [
      waiting.o.id,
      new Date(now - 10_000),
      new Date(now - 1_000),
    ]);
    const confirming = await accepted(s);
    await reservedByHand(s, confirming);
    const before = await sagaColsOf(waiting.o.id);

    expect(await s.saga.claim(waiting.o.id, LEASE)).toBeUndefined();
    expect(await sagaColsOf(waiting.o.id)).toEqual(before);

    const { runner, confirms } = sagaRunnerOf(s);
    expect(await runner.pollOnce()).toBe(1);
    expect(confirms.calls.map((c) => c.orderId)).toEqual([confirming.o.id]);
    expect((await runner.runOne(waiting.o.id)).kind).toBe('SKIPPED');
    expect(confirms.calls.map((c) => c.orderId)).toEqual([confirming.o.id]);
    expect(await sagaColsOf(waiting.o.id)).toEqual(before);
    // 임대가 지난 뒤 직접 부른 claimDue도 그 행을 고르지 않는다
    s.clock.advance(LEASE + 1);
    expect((await s.saga.claimDue(50, LEASE)).map((j) => j.orderId)).not.toContain(waiting.o.id);
    expect(await sagaColsOf(waiting.o.id)).toEqual(before);
    expect(await orderRow(waiting.o.id)).toMatchObject({ status: 'RESERVED' });
  });
});

// ───────────────────────────── DrizzlePaymentPull.claimDue ─────────────────────────────

describe('DrizzlePaymentPull.claimDue(짧은 트랜잭션: 대상 조건, FOR UPDATE SKIP LOCKED, pull_next_at = 지금 + 5초를 쓰고 커밋)', () => {
  test('ADR0140_confirm_sent_at이 지금 − 5초 이전이고 pull_next_at이 비었거나 지난 CONFIRM·AWAIT 행만 고르고(Saga 임대와 상관없이), 고른 행에 pull_next_at = 지금 + 5초를 써 커밋한다. Saga 칸은 그대로이고, 다음 점검 시각 전에는 다시 고르지 않는다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const now = s.clock.now();
    // 고르는 행
    const awaitFresh = await putJob(s, { sentAtMs: now - 10_000 });
    const confirmEdge = await putJob(s, { step: 'CONFIRM', sentAtMs: now - AFTER_SENT_MS });
    const dueNow = await putJob(s, { sentAtMs: now - MIN, pullNextAtMs: now });
    const duePast = await putJob(s, { sentAtMs: now - MIN, pullNextAtMs: now - 1 });
    const sagaLeased = await putJob(s, { step: 'CONFIRM', sentAtMs: now - MIN, leaseUntilMs: now + LEASE, nextAtMs: now + PARK_MS });
    // 고르지 않는 행
    const tooSoon = await putJob(s, { sentAtMs: now - AFTER_SENT_MS + 1 });
    const notYet = await putJob(s, { sentAtMs: now - MIN, pullNextAtMs: now + 1 });
    const neverSent = await putJob(s, { step: 'CONFIRM', sentAtMs: null });
    const reserve = await putJob(s, { step: 'RESERVE', sentAtMs: now - MIN });
    const release = await putJob(s, { step: 'RELEASE', sentAtMs: now - MIN });
    const all = [awaitFresh, confirmEdge, dueNow, duePast, sagaLeased, tooSoon, notYet, neverSent, reserve, release];
    const sagaBefore = await Promise.all(all.map((j) => sagaColsOf(j.o.id)));
    const picked = [awaitFresh, confirmEdge, dueNow, duePast, sagaLeased];

    const got = await s.pull.claimDue(BATCH);

    expect(byOrder(got)).toEqual(byOrder(picked.map((j) => targetOf(j))));
    // pull_next_at은 커밋됐다(다른 연결에서 보인다). 고르지 않은 행은 그대로다
    for (const j of picked) expect(await pullNextOf(j.o.id), j.o.id).toEqual(new Date(now + REPEAT_MS));
    expect(await pullNextOf(notYet.o.id)).toEqual(new Date(now + 1));
    for (const j of [tooSoon, neverSent, reserve, release]) expect(await pullNextOf(j.o.id), j.o.id).toBeNull();
    // Saga 실행기의 칸(step·attempts·next_attempt_at·lease_until·confirm_sent_at)은 쓰지 않는다
    expect(await Promise.all(all.map((j) => sagaColsOf(j.o.id)))).toEqual(sagaBefore);
    // 다음 점검 시각 전에는 다시 고르지 않는다(파드 여럿이어도 같은 주문은 5초에 한 번). 5초가 지나면 다시 고르고, 그사이 대상이 된 행도 고른다
    expect(await s.pull.claimDue(BATCH)).toEqual([]);
    s.clock.advance(REPEAT_MS - 1);
    expect((await s.pull.claimDue(BATCH)).map((t) => t.orderId).sort()).toEqual([tooSoon.o.id, notYet.o.id].sort());
    s.clock.advance(1);
    expect((await s.pull.claimDue(BATCH)).map((t) => t.orderId).sort()).toEqual(picked.map((j) => j.o.id).sort());
  });

  test('limit개까지만 고르고, pull_next_at(비었으면 confirm_sent_at)이 이른 것부터 그 차례로 돌려준다', async () => {
    const s = fresh();
    const now = s.clock.now();
    const jobs: Job[] = [];
    // 차례의 기준 시각: now − 9초(pull_next_at) → now − 8초 … now − 6.5초(confirm_sent_at)
    jobs.push(await putJob(s, { sentAtMs: now - 10 * MIN, pullNextAtMs: now - 9_000 }));
    for (let i = 0; i < 4; i += 1) jobs.push(await putJob(s, { sentAtMs: now - 8_000 + i * 500 }));

    expect((await s.pull.claimDue(3)).map((t) => t.orderId)).toEqual(jobs.slice(0, 3).map((j) => j.o.id));
    expect((await s.pull.claimDue(3)).map((t) => t.orderId)).toEqual(jobs.slice(3).map((j) => j.o.id));
    expect(await s.pull.claimDue(3)).toEqual([]);
  });

  test('attemptNo는 그 주문의 결제 시도를 만든 차례로 ACCEPTED 시도가 몇 번째인가다(앞에 대체된 시도가 있으면 2, ACCEPTED 시도가 없으면 0)', async () => {
    const s = fresh();
    const now = s.clock.now();
    const first = await putJob(s);
    const second = await putJob(s, {
      payAttempts: [
        { status: 'SUPERSEDED', atMs: now - 3 * MIN },
        { status: 'ACCEPTED', atMs: now - 2 * MIN },
      ],
    });
    const none = await putJob(s, {
      payAttempts: [
        { status: 'EXPIRED', atMs: now - 3 * MIN },
        { status: 'READY', atMs: now - 2 * MIN },
      ],
    });

    expect(byOrder(await s.pull.claimDue(BATCH))).toEqual(byOrder([targetOf(first, 1), targetOf(second, 2), targetOf(none, 0)]));
  });

  test('ADR0140_리뷰 고침 M4_그 주문의 trade.payments 보류 사건(held_event, 다시 처리 전)이 있으면 claimDue가 그 주문을 고르지 않고(pull_next_at 그대로), 다시 처리 표시(reprocessed_at) 뒤에는 고른다. 다른 토픽의 보류는 막지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const blocked = await putJob(s);
    const otherTopic = await putJob(s);
    const free = await putJob(s);
    const heldId = await putHeld(TOPIC, blocked.o.id, s.clock.now());
    await putHeld('trade.seats', otherTopic.o.id, s.clock.now());

    expect(byOrder(await s.pull.claimDue(BATCH))).toEqual(byOrder([targetOf(otherTopic), targetOf(free)]));
    expect(await pullNextOf(blocked.o.id)).toBeNull();

    // 운영자가 RB-11로 다시 처리했다(행마다 reprocessed_at을 적는다)
    await q('update held_event set reprocessed_at = $2 where id = $1', [heldId, new Date(s.clock.now())]);
    expect((await s.pull.claimDue(BATCH)).map((t) => t.orderId)).toEqual([blocked.o.id]);
  });

  test('다른 연결이 행 잠금을 쥔 작업 행은 기다리지 않고 건너뛰고(SKIP LOCKED), 잠금이 풀리면 고른다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const held = await putJob(s, { sentAtMs: s.clock.now() - 20_000 });
    const free = await putJob(s, { sentAtMs: s.clock.now() - 10_000 });
    const c = await race.pool.connect();
    try {
      await c.query('begin');
      await c.query('select order_id from order_saga_job where order_id = $1 for update', [held.o.id]);
      const started = Date.now();
      expect((await s.pull.claimDue(BATCH)).map((t) => t.orderId)).toEqual([free.o.id]);
      // 기다리지 않았다(문장 시간 한도까지 서지 않는다)
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
    expect(await pullNextOf(held.o.id)).toBeNull();
    expect((await s.pull.claimDue(BATCH)).map((t) => t.orderId)).toEqual([held.o.id]);
  });

  test('ADR0140_두 파드(두 연결)가 동시에 claimDue를 불러도 같은 행을 둘이 고르지 않고, 둘을 합치면 대상 전부다(다섯 번) [ASVS v5.0.0-2.3.4]', async () => {
    for (let round = 0; round < 5; round += 1) {
      await q('delete from order_saga_job');
      const s = fresh(BASE_MS + round * HOUR);
      const now = s.clock.now();
      const ids: string[] = [];
      for (let i = 0; i < 12; i += 1) ids.push((await putJob(s, { sentAtMs: now - 10_000 - i })).o.id);
      const other = new DrizzlePaymentPull({ database: race, clock: s.clock });

      const settled = await Promise.allSettled([s.pull.claimDue(8), other.claimDue(8)]);

      expect(rejections(settled), `${round}회`).toEqual([]);
      const [x, y] = settled.map((r) => (r as PromiseFulfilledResult<PaymentPullTarget[]>).value.map((t) => t.orderId));
      expect(x!.filter((id) => y!.includes(id)), `${round}회 겹침`).toEqual([]);
      expect([...x!, ...y!].sort(), `${round}회`).toEqual([...ids].sort());
    }
  });

  test.each<[string, number]>([
    ['limit 0', 0],
    ['limit 101(100건을 넘음)', BATCH + 1],
    ['limit 소수', 1.5],
    ['limit NaN', Number.NaN],
  ])('%s면 RangeError이고 아무 행도 고르지 않는다 [ASVS v5.0.0-2.2.1]', async (_label, limit) => {
    const s = fresh();
    const j = await putJob(s);
    await expect(s.pull.claimDue(limit)).rejects.toThrow(RangeError);
    expect(await pullNextOf(j.o.id)).toBeNull();
    // 맞는 상한(100)은 받는다(무엇이든 RangeError인 구현이 통과하지 않게)
    expect((await s.pull.claimDue(BATCH)).map((t) => t.orderId)).toEqual([j.o.id]);
  });
});

// ───────────────────────────── DrizzlePaymentPull.defer ─────────────────────────────

describe('DrizzlePaymentPull.defer(pull_next_at = untilMs, CONFIRM·AWAIT 행만)', () => {
  test('ADR0140_defer는 CONFIRM·AWAIT 행의 pull_next_at을 untilMs로 미루고 미룬 행 수를 돌려준다(다른 단계·없는 주문·소문자 UUID가 아닌 ID는 빼고 센다). 미룬 행은 그 시각 전에는 고르지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const s = fresh();
    const now = s.clock.now();
    const awaitA = await putJob(s);
    const awaitB = await putJob(s);
    const confirm = await putJob(s, { step: 'CONFIRM' });
    const reserve = await putJob(s, { step: 'RESERVE' });
    const until = now + SLOW_MS;
    const sagaBefore = await sagaColsOf(awaitA.o.id);

    expect(await s.pull.defer([awaitA.o.id, confirm.o.id, reserve.o.id, uuidv7(s.clock), 'order-1', awaitB.o.id.toUpperCase()], until)).toBe(2);

    expect(await pullNextOf(awaitA.o.id)).toEqual(new Date(until));
    expect(await pullNextOf(confirm.o.id)).toEqual(new Date(until));
    expect(await pullNextOf(reserve.o.id)).toBeNull();
    expect(await pullNextOf(awaitB.o.id)).toBeNull();
    expect(await sagaColsOf(awaitA.o.id)).toEqual(sagaBefore);
    // 미룬 행은 그 시각 전에는 고르지 않는다(미루지 않은 awaitB만, 그 뒤 5초마다)
    expect((await s.pull.claimDue(BATCH)).map((t) => t.orderId)).toEqual([awaitB.o.id]);
    s.clock.advance(SLOW_MS - 1);
    expect((await s.pull.claimDue(BATCH)).map((t) => t.orderId)).toEqual([awaitB.o.id]);
    s.clock.advance(1);
    expect((await s.pull.claimDue(BATCH)).map((t) => t.orderId).sort()).toEqual([awaitA.o.id, confirm.o.id].sort());
  });

  test('defer: 빈 목록이나 모두 틀린 ID면 0이고, untilMs가 날짜가 아니면 RangeError이며 아무 행도 바꾸지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = fresh();
    const j = await putJob(s);
    const until = s.clock.now() + SLOW_MS;
    expect(await s.pull.defer([], until)).toBe(0);
    expect(await s.pull.defer(['order-1', '', j.o.id.toUpperCase()], until)).toBe(0);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) await expect(s.pull.defer([j.o.id], bad)).rejects.toThrow(RangeError);
    expect(await pullNextOf(j.o.id)).toBeNull();
    // 맞는 입력은 미룬다(무엇이든 0인 구현이 통과하지 않게)
    expect(await s.pull.defer([j.o.id], until)).toBe(1);
  });
});

// ───────────────────────────── 실행기 + 실제 반영 ─────────────────────────────

describe('PaymentResultPuller + 실제 ApplyPaymentResult(사건과 같은 반영, P-T47·P-T15)', () => {
  test('PT47_PT15_ADR0140_사건이 늦은 주문(접수 뒤 AWAIT, 5초 지남)을 틱 하나가 잡아 BatchGetPayments(주문 ID, 데드라인 500ms)로 묻고, 답 APPROVED를 T9로 반영한다: 주문 APPROVED·판매 행 SOLD·ticket_issue_job(발권 기한 = approved_at + 30분)·작업 행 지움·지표 pulled{APPROVED}. 같은 결과가 뒤늦게 trade.payments로 와도(같은 eventKey·eventSeq) 다시 반영하지 않는다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await confirmedBySaga(s);
    const reader = scriptedReader();
    const { puller, log, seen } = pullerOf(s, reader);
    // 보낸 지 5초가 되기 전에는 대상이 아니다(평소에는 사건이 1초 안에 와 당기기가 돌지 않는다)
    s.clock.advance(AFTER_SENT_MS - 1);
    expect(await puller.tick()).toEqual({ claimed: 0, batches: 0, failedBatches: 0, applied: 0, deferred: 0 });
    expect(reader.calls).toEqual([]);
    s.clock.advance(1);
    const approvedAt = s.clock.now() - 3_000;
    const answer = stateOf(a, { status: 'APPROVED', approvedAtMs: approvedAt, eventSeq: 1 });
    reader.answers.set(a.o.id, answer);

    expect(await puller.tick()).toEqual({ claimed: 1, batches: 1, failedBatches: 0, applied: 1, deferred: 0 });

    expect(reader.calls).toEqual([{ orderIds: [a.o.id], deadlineMs: DEADLINE_MS }]);
    expect(await orderRow(a.o.id)).toEqual({ status: 'APPROVED', failure_reason: null, payment_event_seq: '1' });
    expect(await historyCauses(a.o.id)).toEqual([...BEFORE_RESULT, 'T9']);
    expect(await outboxTypes(a.o.eventId, a.o.id)).toEqual(['CREATED', 'ACCEPTED', 'RESERVED', 'APPROVED']);
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['SOLD', 'SOLD']);
    expect(await issueJobOf(a.o.id)).toEqual({ event_id: a.o.eventId, attempts: 0, issue_due_at: new Date(approvedAt + ISSUE_WINDOW_MS) });
    expect(await jobOf(a.o.id)).toBeUndefined();
    expect(seen).toEqual({ pulled: ['APPROVED'], batches: 1, failures: 0 });
    expect(log.lines).toEqual([]);
    expect(s.resultLog.lines).toEqual([]);
    // 다음 틱에는 할 것이 없다(작업 행이 없다)
    s.clock.advance(REPEAT_MS);
    expect(await puller.tick()).toMatchObject({ claimed: 0, batches: 0 });
    expect(reader.calls).toHaveLength(1);

    // 같은 결과가 사건 길로 뒤늦게 온다(P-T15)
    const k = await partitionOf(s);
    await k.p.push(messageOf(s, eventLike(a, answer, approvedAt), a.o.eventId));
    await k.p.drain();

    expect(k.errors).toEqual([]);
    expect(await heldCount(a.o.id)).toBe(0);
    expect(await historyCauses(a.o.id)).toEqual([...BEFORE_RESULT, 'T9']);
    expect((await outboxTypes(a.o.eventId, a.o.id)).filter((t) => t === 'APPROVED')).toHaveLength(1);
    expect(await issueJobCount(a.o.id)).toBe(1);
    expect(await orderRow(a.o.id)).toMatchObject({ status: 'APPROVED', payment_event_seq: '1' });
    expect(s.resultLog.lines).toEqual([]);
  });

  test('PT15_ADR0140_당기기가 대상을 잡아 묻는 사이 사건 길이 같은 결과를 먼저 반영하면, 당기기의 반영은 건너뛰어(이미 반영한 순번) 이력 T9·Outbox APPROVED·ticket_issue_job이 하나씩이고 지표 pulled가 없다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await confirmedBySaga(s);
    s.clock.advance(AFTER_SENT_MS);
    const approvedAt = s.clock.now() - 1_000;
    const answer = stateOf(a, { approvedAtMs: approvedAt });
    const reader = scriptedReader();
    reader.answers.set(a.o.id, answer);
    const k = await partitionOf(s);
    reader.beforeAnswer = async () => {
      await k.p.push(messageOf(s, eventLike(a, answer, approvedAt), a.o.eventId));
      await k.p.drain();
    };
    const { puller, log, seen } = pullerOf(s, reader);

    expect(await puller.tick()).toEqual({ claimed: 1, batches: 1, failedBatches: 0, applied: 0, deferred: 0 });

    expect(k.errors).toEqual([]);
    expect(await heldCount(a.o.id)).toBe(0);
    expect(await historyCauses(a.o.id)).toEqual([...BEFORE_RESULT, 'T9']);
    expect((await outboxTypes(a.o.eventId, a.o.id)).filter((t) => t === 'APPROVED')).toHaveLength(1);
    expect(await issueJobCount(a.o.id)).toBe(1);
    expect(await jobOf(a.o.id)).toBeUndefined();
    expect(seen).toEqual({ pulled: [], batches: 1, failures: 0 });
    expect(log.lines).toEqual([]);
  });

  test('PT47_ADR0140_답이 UNKNOWN이면 T12 뒤 작업 행이 AWAIT로 남고(confirm_sent_at 그대로) pull_next_at = 지금 + 30초이며, 30초 뒤 답이 APPROVED(순번 2)면 T13으로 승인하고 작업 행을 지운다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await confirmedBySaga(s);
    s.clock.advance(AFTER_SENT_MS);
    const reader = scriptedReader();
    reader.answers.set(a.o.id, stateOf(a, { status: 'UNKNOWN', eventSeq: 1 }));
    const { puller, log, seen } = pullerOf(s, reader);

    // 실행기도 답의 상태(UNKNOWN)로 다음 점검을 30초 뒤로 미룬다(리뷰 고침 H1: mark가 쓴 값과 같다)
    expect(await puller.tick()).toEqual({ claimed: 1, batches: 1, failedBatches: 0, applied: 1, deferred: 1 });

    const markedAt = s.clock.now();
    expect(await orderRow(a.o.id)).toEqual({ status: 'UNKNOWN', failure_reason: null, payment_event_seq: '1' });
    expect(await historyCauses(a.o.id)).toEqual([...BEFORE_RESULT, 'T12']);
    expect(await jobOf(a.o.id)).toEqual({ step: 'AWAIT', confirm_sent_at: new Date(a.sentAt), pull_next_at: new Date(markedAt + AFTER_UNKNOWN_MS) });
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
    expect(await issueJobOf(a.o.id)).toBeUndefined();
    // 30초 전에는 다시 묻지 않는다
    s.clock.advance(AFTER_UNKNOWN_MS - 1);
    expect(await puller.tick()).toMatchObject({ claimed: 0, batches: 0 });
    expect(reader.calls).toHaveLength(1);
    s.clock.advance(1);
    const approvedAt = s.clock.now() - 2_000;
    reader.answers.set(a.o.id, stateOf(a, { status: 'APPROVED', approvedAtMs: approvedAt, eventSeq: 2 }));

    expect(await puller.tick()).toEqual({ claimed: 1, batches: 1, failedBatches: 0, applied: 1, deferred: 0 });

    expect(await orderRow(a.o.id)).toEqual({ status: 'APPROVED', failure_reason: null, payment_event_seq: '2' });
    expect(await historyCauses(a.o.id)).toEqual([...BEFORE_RESULT, 'T12', 'T13']);
    expect(await jobOf(a.o.id)).toBeUndefined();
    // T13(UNKNOWN을 푼 승인)의 발권 기한은 max(결제사 승인 시각, 반영 시각) + 30분이다(PRF-182, 늦게 푼 주문이 발권 전에 기한을 넘기지 않게)
    expect(await issueJobOf(a.o.id)).toEqual({ event_id: a.o.eventId, attempts: 0, issue_due_at: new Date(s.clock.now() + ISSUE_WINDOW_MS) });
    expect(seen).toEqual({ pulled: ['UNKNOWN', 'APPROVED'], batches: 2, failures: 0 });
    expect(log.lines).toEqual([]);
  });

  test('PT47_ADR0140_답이 입금 대기(AWAITING_DEPOSIT)면 T10 뒤 작업 행이 AWAIT로 남고 pull_next_at = 지금 + 60초이며, 60초 뒤 답이 APPROVED(순번 2)면 T16으로 승인하고 작업 행을 지운다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await confirmedBySaga(s);
    s.clock.advance(AFTER_SENT_MS);
    const reader = scriptedReader();
    reader.answers.set(a.o.id, stateOf(a, { status: 'AWAITING_DEPOSIT', eventSeq: 1 }));
    const { puller, seen } = pullerOf(s, reader);

    // 실행기도 답의 상태(입금 대기)로 다음 점검을 60초 뒤로 미룬다(리뷰 고침 H1: mark가 쓴 값과 같다)
    expect(await puller.tick()).toEqual({ claimed: 1, batches: 1, failedBatches: 0, applied: 1, deferred: 1 });

    const markedAt = s.clock.now();
    expect(await orderRow(a.o.id)).toEqual({ status: 'AWAITING_DEPOSIT', failure_reason: null, payment_event_seq: '1' });
    expect(await historyCauses(a.o.id)).toEqual([...BEFORE_RESULT, 'T10']);
    expect(await outboxTypes(a.o.eventId, a.o.id)).toEqual(['CREATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT']);
    expect(await jobOf(a.o.id)).toEqual({ step: 'AWAIT', confirm_sent_at: new Date(a.sentAt), pull_next_at: new Date(markedAt + AFTER_DEPOSIT_MS) });
    expect((await salesOf(a.o.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
    // 60초 전에는 다시 묻지 않는다(입금 기한은 며칠일 수 있어 촘촘히 묻지 않는다)
    s.clock.advance(AFTER_DEPOSIT_MS - 1);
    expect(await puller.tick()).toMatchObject({ claimed: 0, batches: 0 });
    s.clock.advance(1);
    const approvedAt = s.clock.now() - 2_000;
    reader.answers.set(a.o.id, stateOf(a, { status: 'APPROVED', approvedAtMs: approvedAt, eventSeq: 2 }));

    expect(await puller.tick()).toEqual({ claimed: 1, batches: 1, failedBatches: 0, applied: 1, deferred: 0 });

    expect(await orderRow(a.o.id)).toEqual({ status: 'APPROVED', failure_reason: null, payment_event_seq: '2' });
    expect(await historyCauses(a.o.id)).toEqual([...BEFORE_RESULT, 'T10', 'T16']);
    expect(await jobOf(a.o.id)).toBeUndefined();
    expect((await issueJobOf(a.o.id))?.issue_due_at).toEqual(new Date(approvedAt + ISSUE_WINDOW_MS));
    expect(seen.pulled).toEqual(['AWAITING_DEPOSIT', 'APPROVED']);
  });

  test.each<['UNKNOWN' | 'AWAITING_DEPOSIT', number]>([
    ['UNKNOWN', AFTER_UNKNOWN_MS],
    ['AWAITING_DEPOSIT', AFTER_DEPOSIT_MS],
  ])(
    'ADR0140_리뷰 고침 H1_%s 반영 뒤 그 간격(%dms)이 지나 같은 답(같은 순번)이 다시 오면 반영은 건너뛰지만 다음 점검은 다시 지금 + 그 간격이다: 5초 뒤 틱은 잡지 않는다 [ASVS v5.0.0-16.5.2]',
    async (status, gap) => {
      const s = fresh();
      const a = await confirmedBySaga(s);
      s.clock.advance(AFTER_SENT_MS);
      const reader = scriptedReader();
      reader.answers.set(a.o.id, stateOf(a, { status, eventSeq: 1 }));
      const { puller, seen } = pullerOf(s, reader);
      expect((await puller.tick()).applied).toBe(1);

      s.clock.advance(gap);
      expect(await puller.tick()).toMatchObject({ claimed: 1, batches: 1, failedBatches: 0, applied: 0 });

      expect(await pullNextOf(a.o.id)).toEqual(new Date(s.clock.now() + gap));
      expect(await orderRow(a.o.id)).toMatchObject({ status, payment_event_seq: '1' });
      s.clock.advance(REPEAT_MS);
      expect(await puller.tick()).toMatchObject({ claimed: 0, batches: 0 });
      expect(reader.calls).toHaveLength(2);
      expect(seen.pulled).toEqual([status]);
    },
  );

  test('PT47_답이 FAILED(CARD_DECLINED)면 사건과 같은 실패 반영으로 T11: 주문 FAILED·failure_reason·판매 행 PENDING 지움이고, 작업 행은 RELEASE(Saga 실패 해제가 이어 받는다)로 바뀌며 커밋 뒤 Saga를 깨운다. RELEASE 행은 당기기 대상이 아니다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await confirmedBySaga(s);
    s.clock.advance(AFTER_SENT_MS);
    const reader = scriptedReader();
    reader.answers.set(a.o.id, stateOf(a, { status: 'FAILED', failureCategory: 'CARD_DECLINED' }));
    const { puller, log, seen } = pullerOf(s, reader);

    expect(await puller.tick()).toEqual({ claimed: 1, batches: 1, failedBatches: 0, applied: 1, deferred: 0 });

    expect(await orderRow(a.o.id)).toEqual({ status: 'FAILED', failure_reason: 'CARD_DECLINED', payment_event_seq: '1' });
    expect(await historyCauses(a.o.id)).toEqual([...BEFORE_RESULT, 'T11']);
    expect(await salesOf(a.o.eventId)).toEqual([]);
    expect(await issueJobOf(a.o.id)).toBeUndefined();
    expect((await jobOf(a.o.id))?.step).toBe('RELEASE');
    expect(s.kicked).toEqual([a.o.id]);
    expect(seen.pulled).toEqual(['FAILED']);
    expect(log.lines).toEqual([]);
    s.clock.advance(REPEAT_MS);
    expect(await puller.tick()).toMatchObject({ claimed: 0, batches: 0 });
  });

  test('ADR0140_답의 금액이 주문 금액과 다르면 반영이 보류(AMOUNT_MISMATCH)로 끝나고, 당기기는 held_event에 넣지 않고 그 주문의 다음 점검을 지금 + 10분으로 미룬다(리뷰 고침 M3, 주문 RESERVED 그대로, 보류 로그는 반영 쪽 한 줄) [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await confirmedBySaga(s);
    s.clock.advance(AFTER_SENT_MS);
    const reader = scriptedReader();
    reader.answers.set(a.o.id, stateOf(a, { amount: a.o.amount + 1, approvedAtMs: s.clock.now() }));
    const { puller, log, seen } = pullerOf(s, reader);

    expect(await puller.tick()).toEqual({ claimed: 1, batches: 1, failedBatches: 0, applied: 0, deferred: 1 });

    const at = s.clock.now();
    expect(await orderRow(a.o.id)).toEqual({ status: 'RESERVED', failure_reason: null, payment_event_seq: '0' });
    expect(await jobOf(a.o.id)).toEqual({ step: 'AWAIT', confirm_sent_at: new Date(a.sentAt), pull_next_at: new Date(at + LONG_MS) });
    expect(await heldCount(a.o.id)).toBe(0);
    expect(s.resultLog.lines.filter((l) => l.kind === 'held').map((l) => (l.e as { reason: string }).reason)).toEqual(['AMOUNT_MISMATCH']);
    expect(seen.pulled).toEqual([]);
    expect(log.lines).toEqual([]);
    s.clock.advance(LONG_MS - 1);
    expect(await puller.tick()).toMatchObject({ claimed: 0, batches: 0 });
  });

  test('ADR0140_승인 명령이 정해진 거절(REJECTED)로 1시간 미뤄진 CONFIRM 행(confirm_sent_at 있음)도 5초 뒤 당기기 대상이고, 답이 APPROVED면 T9로 승인하고 작업 행을 지워 1시간 뒤 Saga가 승인 명령을 다시 보내지 않는다(PRF-165가 넘긴 것) [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = await accepted(s);
    await reservedByHand(s, a);
    const { runner, confirms, log: sagaLog } = sagaRunnerOf(s, () => ({ status: 'REJECTED', reason: 'invalid_argument' }));
    const sentAt = s.clock.now();
    expect(await runner.runOne(a.o.id)).toMatchObject({ kind: 'RETRY', reason: 'confirm_rejected' });
    expect(await jobOf(a.o.id)).toEqual({ step: 'CONFIRM', confirm_sent_at: new Date(sentAt), pull_next_at: null });
    expect((await sagaColsOf(a.o.id))?.next_attempt_at).toEqual(new Date(sentAt + PARK_MS));
    expect(sagaLog.lines).toEqual(['confirmRejected']);
    s.clock.advance(AFTER_SENT_MS);
    const approvedAt = s.clock.now() - 1_000;
    const reader = scriptedReader();
    reader.answers.set(a.o.id, stateOf(a, { approvedAtMs: approvedAt }));
    const { puller, seen } = pullerOf(s, reader);

    expect(await puller.tick()).toEqual({ claimed: 1, batches: 1, failedBatches: 0, applied: 1, deferred: 0 });

    expect(reader.calls).toEqual([{ orderIds: [a.o.id], deadlineMs: DEADLINE_MS }]);
    expect(await orderRow(a.o.id)).toEqual({ status: 'APPROVED', failure_reason: null, payment_event_seq: '1' });
    expect(await historyCauses(a.o.id)).toEqual([...BEFORE_RESULT, 'T9']);
    expect(await jobOf(a.o.id)).toBeUndefined();
    expect(await issueJobOf(a.o.id)).toEqual({ event_id: a.o.eventId, attempts: 0, issue_due_at: new Date(approvedAt + ISSUE_WINDOW_MS) });
    expect(await attemptRefs(a.attemptId)).toEqual(NO_REFS);
    expect(seen.pulled).toEqual(['APPROVED']);
    // 미룬 1시간이 지나도 집을 작업이 없다(승인 명령 1번 그대로)
    s.clock.advance(PARK_MS);
    expect(await runner.runOne(a.o.id)).toEqual({ kind: 'SKIPPED', reason: 'NO_JOB' });
    expect(confirms.calls).toHaveLength(1);
  });
});
