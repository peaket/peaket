// 결제 모델 기반 시험의 대상(wbs 2.7.6, docs/verification.md §2.4, V-T40, specs/payment.qnt, BUILD_ORDER PRF-210).
// PostgreSQL 18 컨테이너 하나에 purchase DB·payment DB 둘을 두고, 두 서비스의 운영 코드를 한 프로세스에서 바로 부른다(gRPC·Kafka는 빼고 쓰임새를 바로 잇는다).
// 결제사는 둘이고 결제사마다 시뮬레이터 하나다(명세 1 = 토스형 시뮬레이터 어댑터 SIMULATOR, 2 = 포트원형 PortoneGateway PORTONE. 하나에 둘을 두면
// 엔진의 주문별 승인 기록이 결제사 사이 이중 승인을 막아 ①을 가린다). 메서드 이름은 명세의 동작 이름이다.
// 명세 동작과 운영 코드(정한 것, BUILD_ORDER PRF-210):
// - newAttempt → payment-svc 결제사 고르기 selectPg(전환·지정 읽기 DrizzlePgSelection.read, 캐시 없이) → purchase DrizzleOrderStarts.start(이전 READY 시도 SUPERSEDED, 새 시도 READY).
// - auth → 시뮬레이터 결제창 인증(/sim/authenticate·/sim/portone/authenticate). accept → 쓰임새 AcceptPayment(구매 세션·회차 슬롯은 대역, 계정·세션·시도·결제사·
//   paymentId·금액 대조를 거쳐 DrizzleOrderAccepts의 T3·T4와 Saga 작업 RESERVE, 코드 리뷰 M4).
// - expireAttempt → DrizzleOrderExpiry.expireReadyAttempts(40분 지남은 흉내: 그 시도만 고른 범위). expireOrder → DrizzleOrderExpiry.expireIfDue(구매 세션·홀드가 끝났다고 넣는다).
// - reserve → OrderSagaRunner.reserveStep(좌석 묶기 OrderSeatPins는 대역: 갈래 RESERVED면 OK, FAILED면 TAKEN. 좌석 경합은 seat 명세 몫) → DrizzleSaga.reserve 또는 T8.
//   승인 기한이 지났으면 묶지 않고 T8 EXPIRED다(명세도 실패 갈래만 있다, 코드 리뷰 H1).
// - command → OrderSagaRunner.confirmStep → 승인 명령 포트(프로세스 안 어댑터) → payment-svc AcceptPaymentCommand.execute. 승인 기한이 지났고 한 번도 보내지 못했으면
//   보내지 않고 T11 EXPIRED와 판매 예약 풀기다(명세 command도 같다). 실패·만료로 끝난 주문에 PENDING 판매 행이 남으면 위반으로 센다.
// - send·respond·timeout·expireCommand → PaymentConfirmRunner.tick(그 주문의 명령만 때가 되게 한다) + 결제사 호출 대역(pg-proxy.ts).
//   채널 동시 호출 상한은 하네스가 대역에서 센 기다리는 호출 수로 판정하고 보호기의 판정(available)과 다르면 위반이다. 상한이 찬 동안의 send는 명세 걸음 대신
//   blockedSend로 실행기를 돌려 '보내지 않음·결제 원장 그대로'를 본다(재시도 큐 대기). 승인 요청의 멱등키는 주문마다 confirm-{주문 ID} 하나여야 한다(코드 리뷰 H3).
//   restart → 실행기의 DB를 끊고(프로세스가 죽은 것) 기다리던 호출을 끊은 뒤 새 실행기가 임대가 끝난 행을 잡는다(앞 소유자 + CONFIRM_SENT → UNKNOWN).
//   끊은 DB가 막은 쓰기 수를 따로 센다(경합에서 respond가 졌는지는 이 기록으로 판정한다, 코드 리뷰 M8). purchase-svc 재시작은 메우지 않는다(코드 리뷰 M7).
// - pgProcess → 대역이 붙든 요청을 시뮬레이터로 넘긴다(갈래 DECLINED면 그 주문에 거절 장애를 건다). pgExpire → /sim/sessions/:key/expire. pgCancel → 시뮬레이터 취소 API.
// - query → PaymentUnknownResolver.tick(그 결제만 때가 되게). 결제사 쪽 전액 취소는 단독 조회가 UNKNOWN을 지키고 대사가 닫으므로(payment §2, HOT-153) 대사의 닫기
//   (DrizzleConfirmJobs.resolve CANCELED)를 이어 부른다. 대사 실행과 닫기 판단(전액 취소·주문 대조)은 흉내다(시뮬레이터가 전액 취소라고 답할 때만 닫는다, 코드 리뷰 M6).
// - deadlinePasses → 흉내: 두 DB의 인증 시각을 승인 기한 전으로 옮긴다. applyResult → 걸음마다 무작위로 두 길 가운데 하나(명세가 한 걸음으로 줄인 것):
//   사건 길(payment Outbox의 결제 사건을 PaymentResultHandler에 넘긴다, Kafka 없이) 또는 당기기 길(PaymentResultPuller.tick → 프로세스 안 클라이언트가
//   payment-svc BatchGetPaymentStates를 부르고 proto 칸 꼴(orderPaymentStateOf)을 purchase 어댑터와 같은 orderPaymentStatesOf로 읽는다, gRPC 없이).
//   당기기 뒤 반은 같은 사건이 사건 길로도 온다(순번 조건이 건너뛴다). 결제사 쪽 취소(CANCELED)는 당기기가 반영하지 않는 상태라 늘 사건 길이다.
// - issue·issueAck → TicketIssueRunner.runOne(다시 보내기 간격은 흉내로 지나게 한다) + 대역 ticket-svc(TicketStub). overdue → 흉내로 발권 기한을 지나게 한 뒤 DrizzleTicketIssue.markOverdue.
// - 흉내(운영 코드가 없다, PRF-173·HOT-160·GAT-280이 잇는다): ticketSvc·ticketBreaks(대역 ticket-svc), csConfirm·eventCancel(하네스 표시),
//   compStart(큐 행 잠금 → 주문 전이 T20 → 큐 행 지우기를 한 트랜잭션에. 보상 중은 운영 상태가 없어 COMPENSATED + 하네스 표시로 둔다), compFence(대역 ticket-svc의 발권 막기),
//   compCancel·eventRefund(T24, 결제사 어댑터 cancel을 답 유실 뒤 같은 멱등키로 다시 부른다. 첫 답 UNKNOWN·다시 부른 답 CANCELLED를 단언한다. 결제 원장 CANCELED는
//   운영 쓰임새가 없어 하네스가 SQL로 적는다, 코드 리뷰 H4). 불변식 ④는 결제사 대역이 받은 취소 요청으로 센다(코드 리뷰 L1).
// 관측(명세 상태 꼴): 주문 상태(AUTHENTICATED → CREATED, UNKNOWN → RESERVED, COMPENSATED + 보상 중 표시 → COMPENSATING), 접수한 시도의 결제사, 발권 큐 행·기한 넘김,
// 시도(만든 차례가 k), 시뮬레이터의 결제 상태(READY → AUTH, DONE → APPROVED, ABORTED → DECLINED, EXPIRED, CANCELED), 대역이 붙든 요청(req),
// 결제 원장(ACCEPTED + CONFIRM_SENT → SENT), 대역 ticket-svc. 걸음마다 앞 관측에서 명세 다음 상태(spec.ts)를 계산해 칸마다 견주고 불변식 ①~⑥을 센다
// (①은 두 시뮬레이터 원장 GET /sim/ledger로도 센다). 결제사 대역이 주문을 풀지 못한 호출과 같은 주문의 겹친 승인 요청도 위반이다(코드 리뷰 M3·L3).
// 무작위 갈래(결과 반영 길)는 SystemOptions.random(시드한 생성기)으로 고른다(같은 시드면 같은 갈래, 코드 리뷰 M9).
// 경합(SystemOptions.scheduler): 운영 코드에 넘기는 두 DB를 스케줄러 문 뒤에 세우고, pair(a, b)가 두 걸음을 함께 돌려 결과가 어느 한 차례의 명세 다음 상태와 같고
// 그 차례에서 명세가 허락하지 않는 뒤 걸음만 졌는지 본다.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { type ConsumedMessage, type Database, type DbTransaction, ensureOutboxPartitions, type FakeClock, requestFingerprint, uuidv7 } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { Scheduler } from 'fast-check';
import { buildSimulatorApp, type SimulatorApp } from '../../../pg-simulator/src/index.js';
import { DrizzleConfirmJobs } from '../../../payment-svc/src/modules/payment/adapters/db/drizzle-confirm-jobs.js';
import { DrizzlePaymentStore } from '../../../payment-svc/src/modules/payment/adapters/db/drizzle-payment-store.js';
import { DrizzlePgSelection } from '../../../payment-svc/src/modules/payment/adapters/db/drizzle-pg-selection.js';
import { StaticPaymentGateways } from '../../../payment-svc/src/modules/payment/adapters/pg/payment-gateways.js';
import { PortoneGateway } from '../../../payment-svc/src/modules/payment/adapters/pg/portone-gateway.js';
import { SimulatorPaymentGateway } from '../../../payment-svc/src/modules/payment/adapters/pg/simulator-gateway.js';
import { AcceptPaymentCommand } from '../../../payment-svc/src/modules/payment/application/accept-payment-command.js';
import { BatchGetPaymentStates } from '../../../payment-svc/src/modules/payment/application/batch-get-payment-states.js';
import { PaymentConfirmRunner } from '../../../payment-svc/src/modules/payment/application/payment-confirm-runner.js';
import { PaymentUnknownResolver } from '../../../payment-svc/src/modules/payment/application/payment-unknown-resolver.js';
import type { PaymentGatewayPort } from '../../../payment-svc/src/modules/payment/domain/payment-gateway.js';
import { PgCallGuards } from '../../../payment-svc/src/modules/payment/domain/pg-call-guard.js';
import { channelTableOf, selectPg } from '../../../payment-svc/src/modules/payment/domain/pg-selection.js';
import type { UnknownQueryJob } from '../../../payment-svc/src/modules/payment/domain/unknown-resolver.js';
import { orderPaymentStateOf } from '../../../payment-svc/src/modules/payment/inbound/payment.grpc.js';
import {
  ACCEPT_PAYMENT_OPERATION,
  AcceptPayment,
  ApplyPaymentResult,
  type ConfirmCommand,
  type ConfirmOutcome,
  DrizzleOrderAccepts,
  DrizzleOrderExpiry,
  DrizzleOrderStarts,
  DrizzleOrderStore,
  DrizzlePaymentPull,
  DrizzlePaymentResults,
  DrizzleSaga,
  DrizzleTicketIssue,
  ORDER_EXPIRY_ACTOR,
  ORDER_SAGA_ACTOR,
  orderPaymentStatesOf,
  PAYMENT_PULL_AFTER_SENT_MS,
  OrderSagaRunner,
  type PaymentConfirms,
  PaymentResultHandler,
  PaymentResultPuller,
  START_PAYMENT_OPERATION,
  TicketIssueCallError,
  type TicketIssueCommand,
  type TicketIssuer,
  TicketIssueRunner,
} from '../../src/modules/booking/index.js';
import { DrizzleSeatSales } from '../../src/modules/inventory/index.js';
import { accountActor, newOrderInput } from '../order-fixtures.js';
import type { SpecAction } from './actions.js';
import { PgProxy } from './pg-proxy.js';
import { ak, compareState, enabled, initState, invariantViolations, type MState, op, PGS, po, type Scope, specNext, type SpecMove } from './spec.js';

/** 시드한 난수(mulberry32). 같은 시드면 같은 갈래를 고른다(코드 리뷰 M9) */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 시뮬레이터 시험 키(sim_sk_ 뒤 16자 이상) */
const KEY = (n: number) => `sim_sk_payment_model_${n}_0123456789`;
const WEBHOOK_SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
const PG_NAME: Record<number, 'SIMULATOR' | 'PORTONE'> = { 1: 'SIMULATOR', 2: 'PORTONE' };
const PG_NUM: Record<string, number> = { SIMULATOR: 1, PORTONE: 2 };
/** 결제사마다 거절 갈래에 거는 오류 코드(토스형은 사용자 중단, 포트원형은 정보 불일치 type이 된다. 어댑터가 둘 다 거절로 읽는다) */
const DECLINE_CODE: Record<number, string> = { 1: 'PAY_PROCESS_ABORTED', 2: 'INVALID_REQUEST' };
const AMOUNT = 10_000;
const FAR_MS = 365 * 86_400_000;
const CONFIRM_DEADLINE_MS = 10 * 60_000;
const WAIT_MS = 10_000;

export const debug = (line: string) => {
  if (process.env.MBT_DEBUG) appendFileSync(process.env.MBT_DEBUG, `${line}\n`);
};
const noop = () => new Proxy({}, { get: () => () => undefined }) as never;
export const labelOf = (m: SpecMove) => `${m.a}(${[m.o, m.p, m.k, m.c].filter((x) => x !== undefined).join(', ')})`;
/**
 * 경합의 뒤 걸음: 앞 걸음 뒤 명세가 허락하면 그 다음 상태, 아니면 진 걸음이라 바뀌지 않는다.
 * 재시작만은 SENT가 없어도 일어난다(명세의 'SENT가 있을 때만'은 범위를 줄이는 조건이고, 잃을 호출이 없을 뿐 재시작 횟수는 는다)
 */
function afterRace(sc: Scope, s: MState, m: SpecMove): MState {
  if (enabled(sc, s, m)) return specNext(sc, s, m);
  if (m.a === 'restart') return { ...structuredClone(s), env: { ...s.env, restarts: s.env.restarts + 1 } };
  return s;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, f: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + WAIT_MS;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`기다린 ${what}이(가) 오지 않았다`);
    await sleep(2);
  }
}

/** 프로세스가 죽은 것처럼 끊을 수 있는 DB(restart: 옛 실행기의 뒤늦은 쓰기가 닿지 않게). 끊은 뒤 막은 문장마다 onBlocked를 부른다 */
function killable(d: Database, onBlocked: () => void): Database & { kill(): void } {
  let dead = false;
  const check = () => {
    if (!dead) return;
    onBlocked();
    throw new Error('mbt: 이 실행기는 멈췄다(재시작)');
  };
  return {
    db: new Proxy(d.db, { get: (t, k) => (k === 'execute' ? (...a: unknown[]) => (check(), (t.execute as (...x: unknown[]) => unknown)(...a)) : Reflect.get(t, k)) }) as Database['db'],
    pool: d.pool,
    close: () => d.close(),
    transaction: <T>(fn: (tx: DbTransaction) => Promise<T>, o?: Parameters<Database['transaction']>[1]) => {
      check();
      return d.transaction(async (tx) => {
        const out = await fn(tx);
        check();
        return out;
      }, o);
    },
    kill: () => {
      dead = true;
    },
  };
}

// ---- 경합(fc.scheduler): 운영 코드의 DB 문을 스케줄러의 문 뒤에 세운다(seat-model/system.ts gatedDb와 같은 꼴) ----
const gate = (sch: Scheduler, label: string) => sch.schedule(Promise.resolve(label), label);
/** 문을 지나 서버로 간 호출 수(하네스가 다음 문을 풀기 전에 이것이 0이 되기를 기다린다) */
interface Flight {
  n: number;
}
async function flying<T>(f: Flight, p: () => Promise<T>): Promise<T> {
  f.n += 1;
  try {
    return await p();
  } finally {
    f.n -= 1;
  }
}
/** DB 문: db.execute, transaction의 시작(BEGIN 전)·문장마다·커밋 전 */
function gatedDb(d: Database, sch: Scheduler, f: Flight): Database {
  const wrapTx = (tx: DbTransaction): DbTransaction =>
    Object.assign(Object.create(tx) as DbTransaction, {
      execute: async (q: Parameters<DbTransaction['execute']>[0]) => {
        await gate(sch, 'db tx.execute');
        return flying(f, () => tx.execute(q));
      },
    });
  const db = Object.assign(Object.create(d.db) as Database['db'], {
    execute: async (q: Parameters<Database['db']['execute']>[0]) => {
      await gate(sch, 'db execute');
      return flying(f, () => d.db.execute(q));
    },
  });
  return {
    db,
    pool: d.pool,
    close: () => d.close(),
    transaction: async <T>(fn: (tx: DbTransaction) => Promise<T>, o?: Parameters<Database['transaction']>[1]) => {
      await gate(sch, 'db begin');
      f.n += 1;
      let begun = false;
      let committing = false;
      try {
        return await d.transaction(async (tx) => {
          begun = true;
          f.n -= 1;
          const out = await fn(wrapTx(tx));
          await gate(sch, 'db commit');
          committing = true;
          f.n += 1;
          return out;
        }, o);
      } finally {
        if (!begun || committing) f.n -= 1;
      }
    },
  };
}

/** 대역 ticket-svc(주문 ID로 멱등). 명세 Tk와 같은 칸을 두고, 발권 호출을 붙들어 ticketSvc·issueAck 걸음으로 쪼갠다 */
class TicketStub implements TicketIssuer {
  readonly tks = new Map<string, { tk: string; closed: boolean; req: boolean; wait: string; broken: boolean; ticketId: string; seatId: string }>();
  readonly #calls = new Map<string, { resolve: (v: Array<{ seatId: string; ticketId: string; status: 'ISSUED' }>) => void; reject: (e: unknown) => void }>();
  add(orderId: string, seatId: string): void {
    this.tks.set(orderId, { tk: 'NONE', closed: false, req: false, wait: 'NONE', broken: false, ticketId: randomUUID(), seatId });
  }
  issue(c: TicketIssueCommand): Promise<Array<{ seatId: string; ticketId: string; status: 'ISSUED' }>> {
    const t = this.tks.get(c.orderId)!;
    Object.assign(t, { req: true, wait: 'WAIT' });
    return new Promise((resolve, reject) => this.#calls.set(c.orderId, { resolve, reject }));
  }
  waiting(orderId: string): boolean {
    return this.#calls.has(orderId);
  }
  /** 닫을 때: 붙든 발권 호출을 모두 끊는다 */
  cutAll(): void {
    for (const call of this.#calls.values()) call.reject(new TicketIssueCallError('UNAVAILABLE'));
    this.#calls.clear();
  }
  /** ticketSvc: 막은 주문·발권할 수 없는 주문은 거절, 아니면 갈래대로 발권 또는 일시 실패. 그만 기다린 답은 버려진다 */
  process(orderId: string, ok: boolean): void {
    const t = this.tks.get(orderId)!;
    const ans = (x: string) => (t.wait === 'WAIT' ? x : t.wait);
    t.req = false;
    if (t.closed || t.broken || !ok) t.wait = ans('ERR');
    else {
      if (t.tk === 'NONE') t.tk = 'ISSUED';
      t.wait = ans('OK');
    }
  }
  /** issueAck: 답을 돌려준다(아직 답이 없으면 데드라인 초과로 끊는다. 요청은 남는다). 실패는 모두 다시 보낼 수 있는 UNAVAILABLE이다 */
  ack(orderId: string): void {
    const t = this.tks.get(orderId)!;
    const call = this.#calls.get(orderId)!;
    this.#calls.delete(orderId);
    const w = t.wait;
    t.wait = 'NONE';
    if (w === 'OK') call.resolve([{ seatId: t.seatId, ticketId: t.ticketId, status: 'ISSUED' }]);
    else call.reject(new TicketIssueCallError(w === 'WAIT' ? 'DEADLINE_EXCEEDED' : 'UNAVAILABLE'));
  }
}

interface OrderIds {
  orderId: string;
  accountId: string;
  holdId: string;
  psid: string;
  seatId: string;
  /** 결제사마다 결제창 인증 값 */
  auth: Map<number, { paymentKey?: string; paymentId?: string; paymentToken?: string; txId?: string }>;
  /** 시도 번호 → 시도 ID */
  attempts: Map<number, string>;
  /** 건네지 않은 결제 Outbox 순번 다음부터 넘긴다 */
  deliveredSeq: number;
}

export interface SystemOptions {
  /** 채널 동시 승인 호출 상한(작은 값이면 재시도 큐 대기가 생긴다). 기본 넉넉함 */
  bulkhead?: number;
  /**
   * 결과 반영 길: event(payment Outbox 사건 → PaymentResultHandler) 또는 pull(결과 당기기 PaymentResultPuller). 없으면 걸음마다 무작위.
   * 결제사 쪽 취소(원장 CANCELED)는 당기기가 반영하지 않는 상태라(무시하고 60초 미룸, PRF-171) 늘 사건 길이다
   */
  resultPath?: 'event' | 'pull';
  /** 경합 시험: 운영 코드(와 보상 시작 흉내)의 DB 문을 이 스케줄러의 문 뒤에 세우고, 걸음마다 하네스가 문을 하나씩 푼다 */
  scheduler?: Scheduler;
  /** 하네스의 무작위 갈래(결과 반영 길). 없으면 고정 시드(0x5eed)의 생성기다(코드 리뷰 M9) */
  random?: () => number;
}

export class PaymentSystem {
  readonly violations: string[] = [];
  /** 알려진 차이(지금은 없다. K1은 명세를 정본대로 고쳐 지웠다, 코드 리뷰 H1). 재생기가 읽는 칸이라 둔다 */
  readonly known: Array<{ step: number; kind: string; msg: string; explains: string[] }> = [];
  /** 끊은 실행기 DB가 막은 문장 수(재시작이 늦은 쓰기를 막았다는 기록) */
  blockedWrites = 0;
  /** 끊은 실행기의 저장소 호출이 막힌 결제 ID(경합에서 그 결제의 응답이 졌다는 근거) */
  readonly #blockedPayments = new Set<string>();
  /** 상한이 찬 동안 send 대신 돌린 실행기 틱 수(blockedSend) */
  blockedSends = 0;
  readonly log: string[] = [];
  steps = 0;
  obs: MState;
  /** 걸음별 수(무작위 실행이 센다) */
  readonly counts: Partial<Record<SpecAction, number>> = {};
  /** 하네스 표시: 승인 기한 지남, 보상 중, CS 확인, 쓴 횟수, 회차 취소 */
  readonly #late = new Set<number>();
  readonly #compensating = new Set<number>();
  readonly #cs = new Set<number>();
  /** 발권 기한 넘김을 한 번 본 주문(CS 건 TICKET_NOT_ISSUED로 남으므로 큐 행이 지워져도 둔다) */
  readonly #over = new Set<number>();
  readonly #env = { sw: false, switches: 0, timeouts: 0, restarts: 0, hooks: 0, canceled: false };
  readonly #ghost = { offPg: false, badRefund: false, expiredCommand: false };
  readonly eventId = randomUUID();
  readonly #ids = new Map<number, OrderIds>();
  readonly #byOrder = new Map<string, number>();
  readonly #sims = new Map<number, { app: SimulatorApp; url: string }>();
  readonly #proxies = new Map<number, PgProxy>([
    [1, new PgProxy()],
    [2, new PgProxy()],
  ]);
  readonly #pins = { next: 'OK' as 'OK' | 'TAKEN' };
  readonly #tickets = new TicketStub();
  readonly #runs = new Map<string, Promise<unknown>>();
  readonly #random: () => number;
  #runner!: PaymentConfirmRunner;
  #runnerDb!: Database & { kill(): void };
  #resolver!: PaymentUnknownResolver;
  #saga!: OrderSagaRunner;
  #ticketRunner!: TicketIssueRunner;
  #gateways!: StaticPaymentGateways;
  #guards!: PgCallGuards;
  readonly #orderStore: DrizzleOrderStore;
  readonly #starts: DrizzleOrderStarts;
  readonly #accepts: DrizzleOrderAccepts;
  readonly #expiry: DrizzleOrderExpiry;
  readonly #sagaStore: DrizzleSaga;
  readonly #ticketJobs: DrizzleTicketIssue;
  readonly #results: PaymentResultHandler;
  readonly #apply: ApplyPaymentResult;
  readonly #pullTargets: Pick<DrizzlePaymentPull, 'claimDue' | 'defer'>;
  /** 결과 당기기 클라이언트(프로세스 안): payment-svc BatchGetPaymentStates → proto 칸 꼴(orderPaymentStateOf) → purchase 어댑터와 같은 읽기(orderPaymentStatesOf) */
  readonly #reader: { batchGet(orderIds: readonly string[]): Promise<ReturnType<typeof orderPaymentStatesOf>> };
  #puller!: PaymentResultPuller;
  readonly #accept: AcceptPaymentCommand;
  readonly #acceptUse: AcceptPayment;
  readonly #selection: DrizzlePgSelection;
  /** 운영 코드에 넘기는 DB(경합 시험이면 스케줄러 문 뒤) */
  readonly #pdb: Database;
  readonly #paydb: Database;
  readonly #flight: Flight = { n: 0 };
  /** 결과 반영 길별 수(무작위 실행이 센다): 사건 길, 당기기, 당기기 뒤 같은 사건이 사건 길로도 옴 */
  readonly resultPaths = { event: 0, pull: 0, pullThenEvent: 0 };
  /** 경합 걸음 수와 그 가운데 한 걸음이 진(거절된) 수 */
  readonly pairs = { steps: 0, lost: 0 };
  /** 승인 기한이 지난 뒤의 판매 예약(T8 EXPIRED)·승인 명령(T11) 걸음 수(무작위가 기한 갈래를 지났는지 센다) */
  readonly lateBranches = { reserve: 0, command: 0 };
  /** 경합 쌍 종류(commands.ts PAIRS)마다 돈 수(코드 리뷰 H5) */
  readonly pairKinds: Record<string, number> = {};
  #podN = 0;

  constructor(
    private readonly purchase: Database,
    private readonly payment: Database,
    private readonly clock: FakeClock,
    readonly scope: Scope,
    private readonly o: SystemOptions = {},
  ) {
    this.#random = o.random ?? seededRandom(0x5eed);
    this.obs = initState(scope);
    const sch = o.scheduler;
    const pdb = sch ? gatedDb(purchase, sch, this.#flight) : purchase;
    const paydb = sch ? gatedDb(payment, sch, this.#flight) : payment;
    this.#pdb = pdb;
    this.#paydb = paydb;
    this.#orderStore = new DrizzleOrderStore({ clock });
    this.#starts = new DrizzleOrderStarts({ database: pdb, store: this.#orderStore, clock });
    this.#accepts = new DrizzleOrderAccepts({ database: pdb, store: this.#orderStore, clock });
    // 접수 쓰임새(코드 리뷰 M4): 구매 세션은 주문을 만든 세션만 그 계정으로 있고, 회차 슬롯은 늘 열림(세대 1)이다(좌석 Redis는 seat 명세 몫)
    this.#acceptUse = new AcceptPayment({
      sessions: { get: async (sid: string) => this.#sessionOf(sid) } as never,
      reads: this.#accepts,
      writes: this.#accepts,
      slots: { read: async () => ({ status: 'OK', gen: 1 }) },
      log: noop(),
      clock,
    });
    this.#expiry = new DrizzleOrderExpiry({ database: pdb, store: this.#orderStore, clock } as never);
    const sales = new DrizzleSeatSales(pdb);
    this.#sagaStore = new DrizzleSaga({ database: pdb, store: this.#orderStore, sales, clock });
    this.#ticketJobs = new DrizzleTicketIssue({ database: pdb, store: this.#orderStore, clock } as never);
    const payResults = new DrizzlePaymentResults({ database: pdb, store: this.#orderStore, sales, clock });
    this.#apply = new ApplyPaymentResult({
      reads: payResults,
      writes: payResults,
      sessions: { complete: async () => true, release: async () => true, releasePaying: async () => true } as never,
      saga: { kick: () => undefined },
      log: noop(),
      clock,
    } as never);
    this.#results = new PaymentResultHandler(this.#apply);
    // 결과 당기기 대상 고르기는 회차를 가리지 않는다: 이 실행의 주문만 돌려주고, 잡힌 다른 실행의 행은 멀리 미룬다(앞 실행이 남긴 행이 끼지 않게)
    const pull = new DrizzlePaymentPull({ database: pdb, clock });
    this.#pullTargets = {
      claimDue: async (limit: number) => {
        const got = await pull.claimDue(limit);
        const foreign = got.filter((t) => !this.#byOrder.has(t.orderId)).map((t) => t.orderId);
        if (foreign.length > 0) await pull.defer(foreign, clock.now() + FAR_MS);
        return got.filter((t) => this.#byOrder.has(t.orderId));
      },
      defer: (ids: string[], untilMs: number) => pull.defer(ids, untilMs),
    } as never;
    const paymentStore = new DrizzlePaymentStore({ database: paydb, batchDatabase: paydb });
    const batch = new BatchGetPaymentStates({ reader: paymentStore, signals: noop() });
    this.#reader = { batchGet: async (ids) => orderPaymentStatesOf({ payments: (await batch.execute(ids)).map(orderPaymentStateOf) }) };
    this.#accept = new AcceptPaymentCommand({ store: paymentStore, clock, log: noop(), signals: noop() });
    this.#selection = new DrizzlePgSelection({ database: paydb });
  }

  // ---- 준비 ----
  async init(): Promise<void> {
    debug(`${this.eventId} 준비`);
    await ensureOutboxPartitions(this.purchase, this.clock);
    await ensureOutboxPartitions(this.payment, this.clock);
    for (const n of PGS) {
      const app = buildSimulatorApp({ secretKey: KEY(n), clock: { now: () => this.clock.now() }, confirmLatency: { kind: 'none' }, portoneWebhookSecret: WEBHOOK_SECRET });
      this.#sims.set(n, { app, url: await app.listen({ host: '127.0.0.1', port: 0 }) });
    }
    const p1 = this.#proxies.get(1)!;
    const p2 = this.#proxies.get(2)!;
    this.#gateways = new StaticPaymentGateways([
      new SimulatorPaymentGateway({ baseUrl: this.#sims.get(1)!.url, secretKey: KEY(1), clientKey: 'sim_ck_payment_model', callsPerSecond: 10_000, readTimeoutMs: 600_000, fetch: p1.fetch, queryFetch: p1.fetch, clock: this.clock }),
      new PortoneGateway({ baseUrl: this.#sims.get(2)!.url, secret: KEY(2), storeId: 'store-sim', channelKey: 'channel-sim', webhookSecrets: [WEBHOOK_SECRET], isTest: true, callsPerSecond: 10_000, readTimeoutMs: 600_000, fetch: p2.fetch, queryFetch: p2.fetch, clock: this.clock }),
    ]);
    const b = this.o.bulkhead;
    this.#guards = new PgCallGuards({ gateways: this.#gateways, podCount: 1, clock: this.clock, signals: noop(), log: noop(), ...(b === undefined ? {} : { bulkheads: { SIMULATOR: b, PORTONE: b } }) });
    this.#newPaymentRunners();
    this.#newPurchaseRunners();
    for (const o of this.scope.orders) await this.#placeOrder(o);
    await this.#observe();
  }

  async close(): Promise<void> {
    debug(`${this.eventId} 닫기 시작`);
    try {
      this.#proxies.get(1)!.cutAll();
      this.#proxies.get(2)!.cutAll();
      this.#tickets.cutAll();
      // 끊긴 호출 뒤의 쓰기도 경합 시험이면 스케줄러 문 뒤에 서므로 몬다
      await this.#drive(
        (async () => {
          await Promise.allSettled([...this.#runs.values()]);
          await Promise.allSettled([this.#runner.stop(), this.#resolver.stop()]);
        })(),
      );
      for (const s of this.#sims.values()) await s.app.close();
    } finally {
      await this.#isolate();
    }
    debug(`${this.eventId} 닫음`);
  }

  /** 두 DB를 다음 실행이 이어 쓴다: 이 실행의 행을 실행기들의 잡기 대상에서 뺀다(닫기가 도중에 실패해도 한다) */
  async #isolate(): Promise<void> {
    // 두 DB를 다음 실행이 이어 쓴다: 이 실행의 행이 다음 실행의 실행기(결과 당기기·승인 실행기·결과 모름 조회·발권 기한 표시)에 잡히지 않게 한다
    // (잡기는 회차를 가리지 않고, 실행마다 가짜 시계가 그때 시각에서 시작해 앞 실행의 행이 때가 된다)
    const mine = [[...this.#ids.values()].map((x) => x.orderId)];
    await this.purchase.pool.query(`update order_saga_job set pull_next_at = 'infinity' where order_id = any($1::uuid[])`, mine);
    await this.purchase.pool.query(`update ticket_issue_job set issue_due_at = 'infinity', next_attempt_at = null where order_id = any($1::uuid[])`, mine);
    await this.payment.pool.query(`update payment set next_query_at = 'infinity' where order_id = any($1::uuid[]) and next_query_at is not null`, mine);
    await this.payment.pool.query(`update payment_confirm_job set next_attempt_at = 'infinity' where payment_id in (select id from payment where order_id = any($1::uuid[]))`, mine);
  }

  #newPaymentRunners(): void {
    this.#podN += 1;
    this.#runnerDb = killable(this.#paydb, () => {
      this.blockedWrites += 1;
    });
    // 끊긴 뒤 막힌 저장소 호출을 결제 ID로 적는다(첫 인자의 paymentId)
    const real = new DrizzleConfirmJobs({ database: this.#runnerDb, clock: this.clock });
    const jobs = new Proxy(real, {
      get: (t, k) => {
        const v = Reflect.get(t, k) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          const out = (v as (...a: unknown[]) => unknown).apply(t, args);
          if (!(out instanceof Promise)) return out;
          return out.catch((e: unknown) => {
            const pid = (args[0] as { paymentId?: unknown } | undefined)?.paymentId;
            if (e instanceof Error && e.message.startsWith('mbt: 이 실행기는 멈췄다') && typeof pid === 'string') this.#blockedPayments.add(pid);
            throw e;
          });
        };
      },
    });
    const silent = { setInterval: () => 0, clearInterval: () => undefined };
    this.#runner = new PaymentConfirmRunner({ jobs, gateways: this.#gateways, guards: this.#guards, log: noop(), signals: noop(), clock: this.clock, podId: `mbt-pay-${this.#podN}`, timer: silent } as never);
    this.#resolver = new PaymentUnknownResolver({ queries: jobs, gateways: this.#gateways, guards: this.#guards, log: noop(), signals: noop(), clock: this.clock, timer: silent } as never);
  }

  #newPurchaseRunners(): void {
    const confirms: PaymentConfirms = { confirm: (c, o) => this.#confirmInProcess(c, o) };
    this.#saga = new OrderSagaRunner({
      jobs: this.#sagaStore,
      orders: this.#sagaStore,
      reserve: this.#sagaStore,
      failures: this.#sagaStore,
      confirmSent: this.#sagaStore,
      pins: { pin: async () => (this.#pins.next === 'OK' ? { status: 'OK', gen: 1 } : { status: 'TAKEN' }), releaseFailed: async () => ({ status: 'OK' }) },
      confirms,
      configs: { get: async () => ({ perAccountLimit: 4, saleEndsAtMs: this.clock.now() + 2 * 86_400_000 }) },
      log: noop(),
      clock: this.clock,
      timer: { setInterval: () => 1, clearInterval: () => undefined },
    } as never);
    this.#ticketRunner = new TicketIssueRunner({ jobs: this.#ticketJobs, issuer: this.#tickets, log: noop(), signals: noop(), clock: this.clock, timer: { setInterval: () => 1, clearInterval: () => undefined } });
    this.#puller = new PaymentResultPuller({ targets: this.#pullTargets, reader: this.#reader, apply: this.#apply, log: noop(), signals: noop(), clock: this.clock, timer: { setInterval: () => 1, clearInterval: () => undefined } });
  }

  /** 승인 명령 포트를 프로세스 안에서 payment-svc 쓰임새로 잇는다(gRPC 어댑터 GrpcPaymentConfirms와 같은 차례: 보내기 전 표시 → 접수) */
  async #confirmInProcess(c: ConfirmCommand, o?: { beforeSend?: () => Promise<void> }): Promise<ConfirmOutcome> {
    await o?.beforeSend?.();
    const refs = c.refs;
    const paymentRef = refs.pg === 'PORTONE' ? { kind: 'portone' as const, paymentId: refs.paymentId, txId: refs.txId, paymentToken: refs.paymentToken } : { kind: 'toss' as const, paymentKey: refs.paymentKey };
    try {
      const a = await this.#accept.execute({ orderId: c.orderId, attemptId: c.attemptId, attemptNo: c.attemptNo, eventId: c.eventId, pg: c.pg, paymentRef, amount: c.amount, ...(c.authenticatedAtMs === undefined ? {} : { authenticatedAtMs: c.authenticatedAtMs }) });
      return { status: 'ACCEPTED', result: (a as { result?: string }).result === undefined ? 'UNSPECIFIED' : ((a as { result: string }).result as never) };
    } catch (e) {
      debug(`${this.eventId} 승인 명령 거절: ${(e as Error).name}`);
      return { status: 'REJECTED', reason: 'unexpected' } as never;
    }
  }

  #refFor(o: number, p: number) {
    const auth = this.#ids.get(o)!.auth.get(p) ?? {};
    return p === 2 ? { kind: 'portone' as const, paymentId: `pay-${this.#ids.get(o)!.orderId}`, txId: auth.txId ?? 'tx-none', paymentToken: auth.paymentToken ?? 'token-none' } : { kind: 'toss' as const, paymentKey: auth.paymentKey ?? 'key-none' };
  }

  async #selectedPg(): Promise<'SIMULATOR' | 'PORTONE'> {
    const state = await this.#selection.read(this.eventId);
    const s = selectPg({ ...state, defaults: { primary: 'SIMULATOR', fallback: 'PORTONE' }, channels: channelTableOf(this.#gateways), payMethod: 'CARD' });
    return s.pg as 'SIMULATOR' | 'PORTONE';
  }

  /** 주문 o를 운영 경로로 만든다(CREATED, 좌석 하나, 금액 AMOUNT). 명세는 주문이 처음부터 있다 */
  async #placeOrder(o: number): Promise<void> {
    const accountId = randomUUID();
    const psid = uuidv7(this.clock);
    const holdId = uuidv7(this.clock);
    const seatId = `00000000-0000-4000-8000-${o.toString(16).padStart(12, '0')}`;
    const order = newOrderInput(this.clock, { eventId: this.eventId, accountId, holdId, purchaseSessionId: psid, items: [{ seatId, tierId: 'R', sectionId: 'SEC-A', unitPrice: AMOUNT }], created: { purchaseSessionId: psid, journeyId: uuidv7(this.clock), refMissing: true } } as never);
    await this.purchase.transaction((tx) => this.#orderStore.createOrder(tx, order));
    const ids: OrderIds = { orderId: order.id, accountId, holdId, psid, seatId, auth: new Map(), attempts: new Map(), deliveredSeq: 0 };
    this.#ids.set(o, ids);
    this.#byOrder.set(order.id, o);
    this.#tickets.add(order.id, seatId);
    this.clock.advance(1);
  }

  // ---- 관측 ----
  async #observe(): Promise<void> {
    const s = initState(this.scope);
    const orderIds = [...this.#ids.values()].map((x) => x.orderId);
    const [orders, attempts, jobs, pays] = await Promise.all([
      this.purchase.pool.query<{ id: string; status: string }>('select id::text, status from purchase_order where id = any($1::uuid[])', [orderIds]),
      this.purchase.pool.query<{ id: string; order_id: string; pg: string; status: string }>('select id::text, order_id::text, pg, status from payment_attempt where order_id = any($1::uuid[]) order by id', [orderIds]),
      this.purchase.pool.query<{ order_id: string; overdue_at: Date | null }>('select order_id::text, overdue_at from ticket_issue_job where order_id = any($1::uuid[])', [orderIds]),
      this.payment.pool.query<{ order_id: string; pg: string; status: string; sent: boolean }>(
        `select p.order_id::text, p.pg, p.status, exists (select 1 from payment_event e where e.payment_id = p.id and e.type = 'CONFIRM_SENT') as sent from payment p where p.order_id = any($1::uuid[])`,
        [orderIds],
      ),
    ]);
    for (const [o, ids] of this.#ids) {
      const row = orders.rows.find((r) => r.id === ids.orderId)!;
      const st = row.status === 'AUTHENTICATED' ? 'CREATED' : row.status === 'UNKNOWN' ? 'RESERVED' : row.status === 'COMPENSATED' && this.#compensating.has(o) ? 'COMPENSATING' : row.status;
      const mine = attempts.rows.filter((r) => r.order_id === ids.orderId);
      const accepted = mine.find((r) => r.status === 'ACCEPTED');
      const job = jobs.rows.find((r) => r.order_id === ids.orderId);
      if (job?.overdue_at != null) this.#over.add(o);
      s.ord[o] = { st, apg: accepted ? PG_NUM[accepted.pg]! : 0, job: job !== undefined, over: this.#over.has(o), cs: this.#cs.has(o) };
      mine.forEach((r, i) => {
        s.att[ak(o, i + 1)] = { pg: PG_NUM[r.pg]!, st: r.status };
      });
      s.late[o] = this.#late.has(o);
      const t = this.#tickets.tks.get(ids.orderId)!;
      s.tks[o] = { tk: t.tk, closed: t.closed, req: t.req, wait: t.wait, broken: t.broken };
      for (const p of PGS) {
        s.req[po(p, o)] = this.#proxies.get(p)!.hasRequest(ids.orderId);
        s.pgs[po(p, o)] = await this.#pgState(o, p);
      }
      for (const r of pays.rows.filter((x) => x.order_id === ids.orderId)) {
        const p = PG_NUM[r.pg]!;
        s.pay[op(o, p)] = r.status === 'ACCEPTED' && r.sent ? 'SENT' : r.status;
        // ② 결제 원장이 접수 때 고정한 결제사가 아닌 곳에 생김
        if (s.ord[o]!.apg !== 0 && p !== s.ord[o]!.apg) this.#ghost.offPg = true;
      }
      // ② 결제사로 간 호출(승인·조회·취소)이 고정한 결제사가 아님
      for (const p of PGS) if (s.ord[o]!.apg !== 0 && p !== s.ord[o]!.apg && this.#proxies.get(p)!.calls.includes(ids.orderId)) this.#ghost.offPg = true;
      // ④ 결제사로 간 취소 요청이 회차 취소 확정·CS 확인 없이 나감(대역이 받은 요청으로 센다, 코드 리뷰 L1)
      for (const p of PGS) if (this.#proxies.get(p)!.cancels.includes(ids.orderId) && !(this.#env.canceled || this.#cs.has(o))) this.#ghost.badRefund = true;
    }
    // 대역이 주문을 풀지 못한 결제사 호출·같은 주문의 겹친 승인 요청·주문마다 둘 이상의 멱등키(코드 리뷰 M3·L3·H3)
    for (const [p, x] of this.#proxies) {
      for (const path of x.unknown.splice(0)) this.#violate(`결제사 ${p} 대역이 주문을 풀지 못한 호출: ${path}`);
      for (const order of x.overlaps.splice(0)) this.#violate(`결제사 ${p}에 같은 주문(${this.#byOrder.get(order)})의 승인 요청이 겹쳤다`);
      for (const [order, keys] of x.idemKeys) if (keys.size !== 1 || !keys.has(`confirm-${order}`)) this.#violate(`주문 ${this.#byOrder.get(order)}의 승인 멱등키가 confirm-{주문 ID} 하나가 아니다: ${[...keys].join(',')}`);
    }
    // 실패·만료로 끝난 주문에 판매 예약(PENDING)이 남지 않는다(T8·T11의 판매 예약 풀기, 코드 리뷰 H1)
    const pending = await this.purchase.pool.query<{ order_id: string }>(`select order_id::text from seat_sale where status = 'PENDING' and order_id = any($1::uuid[])`, [orderIds]);
    for (const r of pending.rows) {
      const o = this.#byOrder.get(r.order_id)!;
      if (['FAILED', 'EXPIRED'].includes(s.ord[o]!.st)) this.#violate(`과금 없이 끝난 주문 ${o}(${s.ord[o]!.st})에 PENDING 판매 행이 남았다`);
    }
    s.env = { ...this.#env };
    s.ghost = { ...this.#ghost };
    this.obs = s;
  }

  /** 시뮬레이터에 남은 그 주문의 결제 상태(명세 pgs) */
  async #pgState(o: number, p: number): Promise<string> {
    const auth = this.#ids.get(o)!.auth.get(p);
    if (!auth) return 'NONE';
    const key = p === 1 ? auth.paymentKey! : `pay-${this.#ids.get(o)!.orderId}`;
    const r = await this.#control(p, 'GET', `/v1/payments/${encodeURIComponent(key)}`);
    const status = ((await r.json()) as { status?: string }).status;
    // 부분 취소는 전액 취소(CANCELED)로 읽지 않는다(명세에 없는 상태라 다르다고 드러난다, 코드 리뷰 M6)
    const map: Record<string, string> = { READY: 'AUTH', IN_PROGRESS: 'AUTH', DONE: 'APPROVED', ABORTED: 'DECLINED', EXPIRED: 'EXPIRED', CANCELED: 'CANCELED' };
    return map[status ?? ''] ?? `?${status}`;
  }

  #control(p: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${this.#sims.get(p)!.url}${path}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${KEY(p)}:`).toString('base64')}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** ① 두 시뮬레이터 원장에서 주문마다 승인한 결제사 수 */
  async #doubleCharged(): Promise<string[]> {
    const per = new Map<string, Set<number>>();
    for (const p of PGS) {
      const text = await (await this.#control(p, 'GET', '/sim/ledger')).text();
      for (const l of text.split('\n').filter(Boolean)) {
        const r = JSON.parse(l) as { order_ref: string };
        per.set(r.order_ref, (per.get(r.order_ref) ?? new Set()).add(p));
      }
    }
    return [...per].filter(([, s]) => s.size > 1).map(([ref]) => `① 주문 ${ref}을 두 결제사가 승인했다(시뮬레이터 원장)`);
  }

  // ---- 걸음 ----
  /**
   * 걸음 하나: 운영 코드를 부르고 관측한 뒤, 앞 관측에서 명세 다음 상태(spec.ts)를 계산해 칸마다 견주고 불변식을 센다(알려진 차이가 설명하는 칸은 뺀다).
   * check가 거짓이면(무작위 실행의 경합 걸음 등) 다음 상태 대조는 하지 않는다
   */
  async move(m: SpecMove, check = true): Promise<void> {
    const label = labelOf(m);
    this.log.push(label);
    this.steps += 1;
    this.counts[m.a] = (this.counts[m.a] ?? 0) + 1;
    debug(`${this.eventId} ${label}`);
    const pre = this.obs;
    if (!enabled(this.scope, pre, m)) throw new Error(`${label}: 명세가 지금 허락하지 않는 걸음이다`);
    if ((m.a === 'reserve' || m.a === 'command') && pre.late[m.o!]) this.lateBranches[m.a] += 1;
    await this.#drive(this.#run(m, pre));
    this.clock.advance(1);
    await this.#observe();
    if (check) {
      const want = specNext(this.scope, pre, m);
      const explained = new Set(this.known.filter((k) => k.step === this.steps).flatMap((k) => k.explains));
      for (const d of compareState(this.scope, want, this.obs)) if (!explained.has(d.key)) this.#violate(`명세 다음 상태와 다름: ${d.msg}`);
    }
    for (const v of invariantViolations(this.scope, this.obs)) this.#violate(v);
    for (const v of await this.#doubleCharged()) this.#violate(v);
  }

  /**
   * 경합 걸음(scheduler가 있을 때): 명세가 지금 둘 다 허락하는 두 걸음을 함께 돌리고, 시작 차례와 운영 코드의 DB 문 차례를 스케줄러가 섞는다.
   * 결과는 두 걸음을 어느 한 차례로 차례차례 둔 것(앞 걸음 뒤 명세가 뒤 걸음을 허락하지 않으면 앞 걸음만)과 칸마다 같고, 그 차례에서 할 수 없는 뒤 걸음만
   * 졌어야 한다(직렬 가능. 상태만 보면 보상 시작이 이기고도 주문이 CONFIRMED가 된 것을 '발권 답이 먼저'로 읽어 놓친다).
   * 진 걸음의 운영 코드는 거절로 끝나므로 그 걸음 하네스의 '뜻밖의 결과' 오류는 세기만 하고 넘긴다(둘 다 오류면 하네스 오류로 던진다)
   */
  async pair(a: SpecMove, b: SpecMove, o: { serial?: boolean } = {}): Promise<void> {
    const sch = this.o.scheduler;
    if (!sch) throw new Error('pair: 경합 걸음은 scheduler가 있어야 한다');
    const label = `경합(${labelOf(a)} ∥ ${labelOf(b)})`;
    this.log.push(label);
    this.steps += 1;
    this.pairs.steps += 1;
    this.pairKinds[`${a.a} ∥ ${b.a}`] = (this.pairKinds[`${a.a} ∥ ${b.a}`] ?? 0) + 1;
    debug(`${this.eventId} ${label}`);
    const pre = this.obs;
    if (!enabled(this.scope, pre, a) || !enabled(this.scope, pre, b)) throw new Error(`${label}: 명세가 지금 허락하지 않는 걸음이다`);
    const start = (m: SpecMove) => gate(sch, `시작 ${labelOf(m)}`).then(() => this.#run(m, pre));
    // serial이면 a를 끝낸 뒤 b를 시작한다(무작위 차례에서 드문 'a가 먼저 끝남' 갈래를 바로 만든다)
    const settled = (p: Promise<void>) => p.then((value): PromiseSettledResult<void> => ({ status: 'fulfilled', value }), (reason: unknown): PromiseSettledResult<void> => ({ status: 'rejected', reason }));
    const out = o.serial ? [await this.#drive(settled(start(a))), await this.#drive(settled(start(b)))] : await this.#drive(Promise.allSettled([start(a), start(b)]));
    const lost = out.flatMap((r, i) => (r.status === 'rejected' ? [`${labelOf([a, b][i]!)}: ${(r.reason as Error).message}`] : []));
    if (lost.length === 2) throw new Error(`${label}: 두 걸음이 모두 실패했다: ${lost.join(' / ')}`);
    if (lost.length > 0) {
      this.pairs.lost += 1;
      debug(`${this.eventId} 진 걸음 ${lost[0]}`);
    }
    this.clock.advance(1);
    await this.#observe();
    // 차례 하나가 맞으려면 상태가 같고, 그 차례에서 명세가 허락하지 않는 뒤 걸음만 졌어야 한다(진 걸음이 없는데 한 걸음이 할 수 없었던 차례는 아니다)
    const rejected = out.map((r) => r.status === 'rejected');
    const check = (first: number) => {
      const [x, y] = first === 0 ? [a, b] : [b, a];
      const s1 = specNext(this.scope, pre, x);
      const yLoses = !enabled(this.scope, s1, y) && y.a !== 'restart';
      const diffs = compareState(this.scope, afterRace(this.scope, s1, y), this.obs).map((d) => d.msg);
      const lostOk = !rejected[first] && rejected[1 - first] === yLoses;
      return { ok: diffs.length === 0 && lostOk, why: `${x.a} 다음 ${y.a}이면 ${diffs.length ? diffs.join('; ') : '상태는 같음'}${lostOk ? '' : `, 진 걸음이 ${yLoses ? `${y.a}여야 함` : '없어야 함'}`}` };
    };
    const orders = [check(0), check(1)];
    if (!orders.some((x) => x.ok)) this.#violate(`경합 결과가 어느 차례와도 맞지 않는다: ${orders.map((x) => x.why).join(' / ')}${lost.length ? ` (진 걸음 ${lost[0]})` : ''}`);
    for (const v of invariantViolations(this.scope, this.obs)) this.#violate(v);
    for (const v of await this.#doubleCharged()) this.#violate(v);
  }

  /** 걸음의 운영 코드를 끝날 때까지 몬다: 스케줄러가 있으면 문을 하나씩 풀고, 문을 지난 DB 호출이 돌아오기를 잠깐 기다린다(seat-model과 같은 꼴) */
  async #drive<T>(p: Promise<T>): Promise<T> {
    const sch = this.o.scheduler;
    if (!sch) return p;
    let done = false;
    const watched = p.finally(() => {
      done = true;
    });
    watched.catch(() => undefined);
    while (!done) {
      if (sch.count() > 0) {
        await sch.waitNext(1);
        await this.#quiet();
      } else await sleep(1);
    }
    return watched;
  }
  async #quiet(): Promise<void> {
    const end = Date.now() + 20;
    await new Promise((r) => setImmediate(r));
    while (this.#flight.n > 0 && Date.now() < end) await sleep(0);
    await new Promise((r) => setImmediate(r));
  }

  modelState(): MState {
    return structuredClone(this.obs);
  }

  /** 명세 상태를 바꾸지 않아야 하는 바깥 일(웹훅 받기 등)을 돌리고, 관측이 그대로이고 불변식이 지켜지는지 본다 */
  async noChange(label: string, f: () => Promise<unknown>): Promise<void> {
    this.log.push(label);
    const pre = this.obs;
    await f();
    await this.#observe();
    for (const d of compareState(this.scope, pre, this.obs)) this.#violate(`${label}가 명세 상태를 바꿨다: ${d.msg}`);
    for (const v of invariantViolations(this.scope, this.obs)) this.#violate(v);
  }

  /** 집중 시험(멱등): 같은 주문의 승인 명령을 그 결제사로(금액·시도 ID를 바꿔) 다시 보낸 결과(REPLAYED 또는 거절 오류 이름) */
  async resendCommand(o: number, pg: 'SIMULATOR' | 'PORTONE', change: { amount?: number; attemptId?: string } = {}): Promise<string> {
    const ids = this.#ids.get(o)!;
    const attemptId = change.attemptId ?? ids.attempts.get(1)!;
    const at = (await this.payment.pool.query<{ authenticated_at: Date; attempt_no: number }>('select authenticated_at, attempt_no from payment where order_id = $1', [ids.orderId])).rows[0]!;
    try {
      await this.#accept.execute({ orderId: ids.orderId, attemptId, attemptNo: at.attempt_no, eventId: this.eventId, pg, paymentRef: this.#refFor(o, PG_NUM[pg]!), amount: change.amount ?? AMOUNT, authenticatedAtMs: at.authenticated_at.getTime() });
      return 'REPLAYED';
    } catch (e) {
      return (e as Error).name;
    }
  }

  /** 결제 DB(집중 시험이 웹훅 수신 기록을 쓴다) */
  paymentDb(): Database {
    return this.payment;
  }
  /** purchase DB(집중 시험이 주문의 실패 사유·판매 행을 본다) */
  purchaseDb(): Database {
    return this.purchase;
  }

  #violate(msg: string): void {
    this.violations.push(`${msg} [걸음 ${this.steps}: ${this.log.slice(-16).join(' → ')}]`);
  }

  async #run(m: SpecMove, pre: MState): Promise<void> {
    const o = m.o ?? 0;
    const p = m.p ?? 0;
    const ids = this.#ids.get(o);
    switch (m.a) {
      case 'newAttempt': {
        const pg = await this.#selectedPg();
        const attemptId = uuidv7(this.clock);
        const once = { accountRef: ids!.accountId, operation: START_PAYMENT_OPERATION, key: randomUUID(), requestHash: requestFingerprint('POST', `/v1/orders/${ids!.orderId}/payments`, Buffer.from(attemptId)) };
        const out = await this.#starts.start(once, { orderId: ids!.orderId, attemptId, pg, pgOrderRef: pg === 'PORTONE' ? `pay-${ids!.orderId}` : ids!.orderId, actor: accountActor(ids!.accountId) });
        if (out.status !== 'STARTED') throw new Error(`newAttempt: 뜻밖의 결과 ${JSON.stringify(out)}`);
        ids!.attempts.set(out.attemptNo, attemptId);
        return;
      }
      case 'auth': {
        const pg = pre.att[ak(o, m.k!)]!.pg;
        if (pg === 1) {
          const r = await this.#control(1, 'POST', '/sim/authenticate', { orderId: ids!.orderId, amount: AMOUNT, orderName: '모델 공연' });
          const v = (await r.json()) as { paymentKey: string };
          ids!.auth.set(1, { paymentKey: v.paymentKey });
          this.#proxies.get(1)!.keys.set(v.paymentKey, ids!.orderId);
        } else {
          const r = await this.#control(2, 'POST', '/sim/portone/authenticate', { orderId: ids!.orderId, amount: AMOUNT, orderName: '모델 공연', channelKey: 'channel-sim' });
          const v = (await r.json()) as { paymentId: string; paymentToken: string; txId: string };
          ids!.auth.set(2, v);
        }
        return;
      }
      case 'accept': {
        const out = await this.acceptWith(o, m.k!, {}, pre);
        if (out.status !== 202 || out.replayed) throw new Error(`accept: 뜻밖의 결과 ${JSON.stringify(out)}`);
        return;
      }
      case 'expireAttempt': {
        const attemptId = ids!.attempts.get(m.k!)!;
        const at = Number(BigInt(`0x${attemptId.replaceAll('-', '').slice(0, 12)}`));
        const out = await this.#expiry.expireReadyAttempts({ createdFromMs: at, createdBeforeMs: at + 1, limit: 10 });
        if (out.length !== 1) throw new Error(`expireAttempt: 만료한 시도 ${out.length}개`);
        return;
      }
      case 'expireOrder': {
        const out = await this.#expiry.expireIfDue({ orderId: ids!.orderId, sessionEnded: true, holdRemains: false, actor: ORDER_EXPIRY_ACTOR });
        if (out.status !== 'EXPIRED') throw new Error(`expireOrder: 뜻밖의 결과 ${JSON.stringify(out)}`);
        return;
      }
      case 'reserve': {
        this.#pins.next = m.c === 'FAILED' ? 'TAKEN' : 'OK';
        const job = await this.#sagaStore.claim(ids!.orderId, 60_000);
        if (!job) throw new Error('reserve: Saga 작업 행을 잡지 못했다');
        const order = (await this.#sagaStore.read(ids!.orderId))!;
        await this.#saga.reserveStep(job, order);
        await this.#sagaStore.release(ids!.orderId, job.leaseUntilMs!).catch(() => false);
        return;
      }
      case 'command': {
        const job = await this.#sagaStore.claim(ids!.orderId, 60_000);
        if (!job) throw new Error('command: Saga 작업 행(CONFIRM)을 잡지 못했다');
        const order = (await this.#sagaStore.read(ids!.orderId))!;
        await this.#saga.confirmStep(job, order);
        const pay = await this.payment.pool.query<{ id: string }>('select id::text from payment where order_id = $1', [ids!.orderId]);
        // 승인 기한이 지나 Saga가 보내지 않고 T11로 끝냈다(명세 command의 기한 갈래). 결제 원장 행이 없다
        if (pay.rows.length === 0) {
          this.#ghost.expiredCommand = true;
          return;
        }
        // 실행기가 아직 잡지 않은 것으로 둔다(send 걸음이 때가 되게 한다)
        await this.payment.pool.query('update payment_confirm_job set next_attempt_at = $2 where payment_id = $1', [pay.rows[0]!.id, new Date(this.clock.now() + FAR_MS)]);
        return;
      }
      case 'send':
      case 'expireCommand': {
        const id = await this.#paymentIdOf(o);
        await this.payment.pool.query('update payment_confirm_job set next_attempt_at = $2 where payment_id = $1', [id, new Date(this.clock.now())]);
        await this.#runner.tick();
        if (m.a === 'send') await until(`send(${o}, ${p})의 승인 요청`, () => this.#proxies.get(p)!.isWaiting(ids!.orderId));
        else await until(`expireCommand(${o}, ${p})의 끝`, async () => (await this.#payStatus(o)) !== 'ACCEPTED');
        return;
      }
      case 'pgProcess': {
        if (m.c === 'DECLINED') await this.#control(p, 'POST', '/sim/faults', { op: 'confirm', times: 1, orderId: ids!.orderId, kind: 'decline', code: DECLINE_CODE[p] });
        await this.#proxies.get(p)!.process(ids!.orderId);
        return;
      }
      case 'pgExpire': {
        const key = p === 1 ? ids!.auth.get(1)!.paymentKey! : `pay-${ids!.orderId}`;
        const r = await this.#control(p, 'POST', `/sim/sessions/${encodeURIComponent(key)}/expire`);
        if (r.status !== 204) throw new Error(`pgExpire: 시뮬레이터 ${r.status}`);
        return;
      }
      case 'pgCancel': {
        const key = p === 1 ? ids!.auth.get(1)!.paymentKey! : `pay-${ids!.orderId}`;
        const r = await this.#control(p, 'POST', `/v1/payments/${encodeURIComponent(key)}/cancel`, { cancelReason: '결제사 쪽 취소' }, { 'idempotency-key': randomUUID() });
        if (r.status !== 200) throw new Error(`pgCancel: 시뮬레이터 ${r.status}`);
        return;
      }
      case 'respond':
      case 'timeout': {
        if (m.a === 'respond') this.#proxies.get(p)!.respond(ids!.orderId);
        else {
          this.#proxies.get(p)!.timeout(ids!.orderId);
          this.#env.timeouts += 1;
        }
        // 실행기가 답(또는 끊김)을 원장에 쓸 때까지(SENT = ACCEPTED + CONFIRM_SENT에서 벗어남)
        await until(`${m.a}(${o}, ${p})의 원장 쓰기`, async () => (await this.#payStatus(o)) !== 'ACCEPTED');
        // 답을 내줬어도 실행기가 쓰기 전에 죽었으면(경합: restart가 먼저) 답은 잃었고 다시 뜬 실행기가 결과 모름으로 둔다. 명세로는 이 걸음이 진 것이다.
        // 졌는지는 결과가 UNKNOWN인지가 아니라 끊은 DB가 그 쓰기를 막았다는 기록으로 판정한다(코드 리뷰 M8). 막은 쓰기 없이 UNKNOWN이면 운영 코드의 잘못이라 위반이다
        if (m.a === 'respond' && (await this.#payStatus(o)) === 'UNKNOWN') {
          if (this.#blockedPayments.has(await this.#paymentIdOf(o))) throw new Error(`respond(${o}, ${p}): 답을 쓰기 전에 실행기가 멈췄다(재시작에 졌다, 그 결제의 쓰기가 막혔다)`);
          this.#violate(`respond(${o}, ${p}): 답을 돌려줬는데 그 결제의 쓰기가 막히지 않고 결과 모름이 됐다`);
        }
        return;
      }
      case 'restart': {
        // payment-svc가 죽는다: DB를 끊고 기다리던 호출을 끊는다. 옛 실행기의 뒤늦은 쓰기는 닿지 않는다
        this.#runnerDb.kill();
        for (const x of this.#proxies.values()) x.cutAll();
        await this.#runner.whenIdle();
        this.#env.restarts += 1;
        this.#newPaymentRunners();
        // 다시 뜬 파드: 임대가 끝난 CONFIRM_SENT 행을 잡는다(흉내: 임대 시간이 지남)
        const sent = await this.payment.pool.query<{ id: string }>(
          `select p.id::text from payment p where p.status = 'ACCEPTED' and exists (select 1 from payment_event e where e.payment_id = p.id and e.type = 'CONFIRM_SENT') and p.order_id = any($1::uuid[])`,
          [[...this.#ids.values()].map((x) => x.orderId)],
        );
        for (const r of sent.rows) await this.payment.pool.query('update payment_confirm_job set lease_until = $2, next_attempt_at = $2 where payment_id = $1', [r.id, new Date(this.clock.now() - 1)]);
        await this.#runner.tick();
        await this.#runner.whenIdle();
        return;
      }
      case 'query': {
        const id = await this.#paymentIdOf(o);
        await this.payment.pool.query('update payment set next_query_at = $2 where id = $1', [id, new Date(this.clock.now())]);
        await this.#resolver.tick();
        await this.#resolver.whenIdle();
        // 결제사가 전액 취소한 결제는 단독 조회가 UNKNOWN을 지키고 대사가 닫는다(HOT-153): 대사의 닫기를 이어 부른다
        if ((await this.#payStatus(o)) === 'UNKNOWN' && pre.pgs[po(p, o)] === 'CANCELED') await this.#closeCanceled(o);
        return;
      }
      case 'webhook':
        throw new Error('webhook: 정본 범위에는 이 걸음이 없다(웹훅은 집중 시험이 본다)');
      case 'deadlinePasses': {
        const past = new Date(this.clock.now() - CONFIRM_DEADLINE_MS - 1_000);
        await this.purchase.pool.query(`update payment_attempt set authenticated_at = $2 where order_id = $1 and status = 'ACCEPTED'`, [ids!.orderId, past]);
        await this.payment.pool.query('update payment set authenticated_at = $2 where order_id = $1', [ids!.orderId, past]);
        this.#late.add(o);
        return;
      }
      case 'applyResult': {
        const path = this.o.resultPath ?? (this.#random() < 0.5 ? 'event' : 'pull');
        if (path === 'event' || pre.pay[op(o, p)] === 'CANCELED') {
          this.resultPaths.event += 1;
          return this.#applyResult(o);
        }
        return this.#applyByPull(o);
      }
      case 'issue': {
        await this.purchase.pool.query('update ticket_issue_job set next_attempt_at = $2 where order_id = $1', [ids!.orderId, new Date(this.clock.now())]);
        const run = this.#ticketRunner.runOne(ids!.orderId);
        this.#runs.set(ids!.orderId, run);
        await until(`issue(${o})의 발권 호출`, () => this.#tickets.waiting(ids!.orderId));
        return;
      }
      case 'ticketSvc':
        this.#tickets.process(ids!.orderId, m.c !== 'ERR');
        return;
      case 'issueAck': {
        this.#tickets.ack(ids!.orderId);
        await this.#runs.get(ids!.orderId);
        this.#runs.delete(ids!.orderId);
        return;
      }
      case 'ticketBreaks':
        this.#tickets.tks.get(ids!.orderId)!.broken = true;
        return;
      case 'overdue': {
        await this.purchase.pool.query('update ticket_issue_job set issue_due_at = $2 where order_id = $1', [ids!.orderId, new Date(this.clock.now() - 1)]);
        await this.#ticketJobs.markOverdue(10);
        return;
      }
      case 'csConfirm':
        this.#cs.add(o);
        return;
      case 'compStart':
        // 흉내(PRF-173): 보상 시작 = 발권 큐 행 잠금 → 주문 전이 T20 → 큐 행 지우기를 한 트랜잭션에(잠금 차례는 발권 성공 반영과 같은 '큐 행 → 주문 행').
        // 결제사 취소 전이라 하네스가 보상 중으로 표시한다. 경합 시험에서는 이 트랜잭션도 스케줄러 문 뒤에 선다
        await this.#pdb.transaction(async (tx) => {
          await tx.execute(sql`select order_id from ticket_issue_job where order_id = ${ids!.orderId}::uuid for update`);
          const t = await this.#orderStore.transition(tx, { orderId: ids!.orderId, transition: 'T20', actor: ORDER_SAGA_ACTOR });
          if (t.status !== 'APPLIED') throw new Error(`compStart: T20 ${JSON.stringify(t)}`);
          await tx.execute(sql`delete from ticket_issue_job where order_id = ${ids!.orderId}::uuid`);
        });
        this.#compensating.add(o);
        return;
      case 'compFence': {
        // 흉내(HOT-160): ticket-svc의 주문 단위 발권 막기
        const t = this.#tickets.tks.get(ids!.orderId)!;
        t.closed = true;
        if (t.tk === 'ISSUED') t.tk = 'REVOKED';
        return;
      }
      case 'compCancel':
        await this.#cancelAtPg(o, pre);
        this.#compensating.delete(o);
        return;
      case 'eventCancel':
        this.#env.canceled = true;
        return;
      case 'eventRefund':
        await this.purchase.transaction(async (tx) => {
          const t = await this.#orderStore.transition(tx, { orderId: ids!.orderId, transition: 'T24', actor: ORDER_SAGA_ACTOR });
          if (t.status !== 'APPLIED') throw new Error(`eventRefund: T24 ${JSON.stringify(t)}`);
        });
        this.#tickets.tks.get(ids!.orderId)!.tk = 'REVOKED';
        await this.#cancelAtPg(o, pre);
        return;
      case 'toggleSwitch':
        // 회차 범위의 명령 6(시험마다 회차가 달라 플랫폼 행을 나눠 쓰지 않는다)
        await this.#selection.applySwitch({ scope: this.eventId, active: !this.#env.sw, version: this.#env.switches + 1, changedAtMs: this.clock.now() });
        this.#env.sw = !this.#env.sw;
        this.#env.switches += 1;
        return;
    }
  }

  async #paymentIdOf(o: number): Promise<string> {
    return (await this.payment.pool.query<{ id: string }>('select id::text from payment where order_id = $1', [this.#ids.get(o)!.orderId])).rows[0]!.id;
  }
  async #payStatus(o: number): Promise<string | undefined> {
    return (await this.payment.pool.query<{ status: string }>('select status from payment where order_id = $1', [this.#ids.get(o)!.orderId])).rows[0]?.status;
  }
  async #sentPending(o: number): Promise<boolean> {
    const r = await this.payment.pool.query<{ n: number }>(
      `select count(*)::int as n from payment p where p.order_id = $1 and p.status = 'ACCEPTED' and exists (select 1 from payment_event e where e.payment_id = p.id and e.type = 'CONFIRM_SENT')`,
      [this.#ids.get(o)!.orderId],
    );
    return r.rows[0]!.n > 0;
  }

  /** 대사의 닫기(payment-reconciliation.ts의 CLOSE_CANCELED와 같은 호출): 결제사가 전액 취소한 UNKNOWN을 CANCELED로 끝낸다 */
  async #closeCanceled(o: number): Promise<void> {
    const r = (
      await this.payment.pool.query<{ id: string; order_id: string; event_id: string; attempt_no: number; pg: string; pg_payment_ref: string; pg_tx_id: string | null; amount: number }>(
        'select id::text, order_id::text, event_id::text, attempt_no, pg, pg_payment_ref, pg_tx_id, amount from payment where order_id = $1',
        [this.#ids.get(o)!.orderId],
      )
    ).rows[0]!;
    const job: UnknownQueryJob = { paymentId: r.id, orderId: r.order_id, eventId: r.event_id, attemptNo: r.attempt_no, pg: r.pg as never, paymentRef: r.pg_payment_ref, amount: Number(r.amount), queryAttempts: 0, claimedNextQueryAtMs: 0, anomalyLogged: false, ...(r.pg_tx_id === null ? {} : { txId: r.pg_tx_id }) };
    await new DrizzleConfirmJobs({ database: this.payment, clock: this.clock }).resolve(job, { status: 'CANCELED', result: 'DECLINED' } as never);
  }

  /** 결과 반영: 아직 건네지 않은 그 주문의 결제 사건을 차례대로 PaymentResultHandler에 넘긴다(Kafka 없이) */
  async #applyResult(o: number): Promise<void> {
    const ids = this.#ids.get(o)!;
    const rows = (
      await this.payment.pool.query<{ seq: string; payload: Buffer }>(
        `select seq::text, payload from outbox where msg_key = $1 and seq > $2 and convert_from(payload, 'UTF8')::jsonb ->> 'orderId' = $3 order by seq`,
        [this.eventId, ids.deliveredSeq, ids.orderId],
      )
    ).rows;
    for (const r of rows) {
      const m: ConsumedMessage = { topic: 'trade.payments', partition: 0, offset: BigInt(r.seq), key: this.eventId, value: r.payload, headers: {}, timestamp: this.clock.now() };
      await this.#results.handle(this.#results.decode(m), m);
      ids.deliveredSeq = Number(r.seq);
    }
  }

  /**
   * 결과 당기기 길(PRF-171): 그 주문의 Saga 작업 행을 당기기 대상이 되게 하고(승인 명령을 보낸 지 5초 지남·다음 점검 때가 됨은 흉내) PaymentResultPuller.tick 한 번.
   * 그 주문 하나만 반영해야 한다. 반은 같은 결과 사건이 뒤늦게 사건 길로도 온다(이미 반영한 순번 이하라 건너뛰어야 한다, P-T15·P-T47)
   */
  async #applyByPull(o: number): Promise<void> {
    const ids = this.#ids.get(o)!;
    const sent = new Date(this.clock.now() - PAYMENT_PULL_AFTER_SENT_MS - 1);
    await this.purchase.pool.query('update order_saga_job set pull_next_at = null, confirm_sent_at = least(confirm_sent_at, $2) where order_id = $1', [ids.orderId, sent]);
    const r = await this.#puller.tick();
    if (r.claimed !== 1 || r.applied !== 1) throw new Error(`applyResult(${o}) 당기기: 잡음 ${r.claimed}·반영 ${r.applied}(그 주문 하나만 반영해야 한다)`);
    if (this.#random() < 0.5) {
      this.resultPaths.pullThenEvent += 1;
      await this.#applyResult(o);
    } else this.resultPaths.pull += 1;
  }

  /** 보상 끝·환불(흉내): 고정한 결제사 어댑터로 전액 취소를 보낸다. 첫 답을 잃게 하고 같은 멱등키로 다시 부른다. 승인됐던 결제 원장은 CANCELED로 적는다 */
  async #cancelAtPg(o: number, pre: MState): Promise<void> {
    const ids = this.#ids.get(o)!;
    const p = pre.ord[o]!.apg;
    if (!(pre.env.canceled || pre.ord[o]!.cs)) this.#ghost.badRefund = true;
    const gateway = this.#gateways.of(PG_NAME[p]!) as PaymentGatewayPort;
    const paymentRef = p === 1 ? ids.auth.get(1)!.paymentKey! : `pay-${ids.orderId}`;
    const idemKey = `cancel-${randomUUID()}`;
    if (pre.pgs[po(p, o)] !== 'APPROVED') {
      this.#violate(`보상·환불의 결제사 취소: 주문 ${o}의 결제사 상태가 승인이 아니다(${pre.pgs[po(p, o)]})`);
      return;
    }
    // 첫 호출은 결제사가 취소를 처리한 뒤 답을 잃는다(UNKNOWN). 같은 멱등키로 다시 부르면 처음 결과(CANCELLED)를 받아야 한다(코드 리뷰 H4)
    await this.#control(p, 'POST', '/sim/faults', { op: 'cancel', times: 1, kind: 'drop', applied: true });
    const first = await gateway.cancel({ paymentRef, amount: 'ALL', reason: '보상 환불', idemKey });
    const again = await gateway.cancel({ paymentRef, amount: 'ALL', reason: '보상 환불', idemKey });
    debug(`${this.eventId} 결제사 취소 ${first.outcome} → ${again.outcome}`);
    if (first.outcome !== 'UNKNOWN' || again.outcome !== 'CANCELLED') this.#violate(`보상·환불의 결제사 취소(주문 ${o}): 첫 답 ${first.outcome}(UNKNOWN이어야 함), 다시 부른 답 ${again.outcome}(CANCELLED여야 함)`);
    // 흉내: 결제 원장 CANCELED(보상·환불 쓰임새가 없다, PRF-173)
    await this.payment.pool.query(`update payment set status = 'CANCELED', status_changed_at = $2 where order_id = $1 and status = 'APPROVED'`, [ids.orderId, new Date(this.clock.now())]);
  }

  /** 집중 시험이 쓰는 값 */
  orderIdOf(o: number): string {
    return this.#ids.get(o)!.orderId;
  }
  authOf(o: number, p: number) {
    return this.#ids.get(o)!.auth.get(p);
  }
  simUrl(p: number): string {
    return this.#sims.get(p)!.url;
  }
  gateways(): StaticPaymentGateways {
    return this.#gateways;
  }
  /**
   * 채널 동시 호출 상한이 지금 승인을 하나 더 들일 수 있는가. 하네스가 대역에서 센 기다리는 호출 수로 판정하고(넉넉한 상한이면 늘 참),
   * 보호기의 판정(available)과 다르면 위반으로 센다(운영 코드가 자리를 돌려주지 않거나 막혀도 send가 조용히 사라지지 않게, 코드 리뷰 H3)
   */
  sendRoom(p: number): boolean {
    const mine = this.o.bulkhead === undefined || this.#proxies.get(p)!.waitingCount() < this.o.bulkhead;
    const theirs = (this.#guards.of(PG_NAME[p]!)?.available() ?? 0) > 0;
    if (mine !== theirs) this.#violate(`결제사 ${p}의 동시 호출 자리: 하네스 셈 ${mine ? '있음' : '없음'}(기다리는 호출 ${this.#proxies.get(p)!.waitingCount()}개), 보호기 ${theirs ? '있음' : '없음'}`);
    return mine;
  }

  /**
   * 상한이 찬 동안의 send: 명세 걸음 대신 그 명령을 때가 되게 하고 실행기를 돌려, 결제사에 보내지 않고(대역에 새 요청 없음) 결제 원장이 그대로(접수, CONFIRM_SENT 없음)이며
   * 작업 행이 남는지(재시도 큐) 본다(코드 리뷰 H3)
   */
  async blockedSend(o: number, p: number): Promise<void> {
    const ids = this.#ids.get(o)!;
    this.log.push(`상한 찬 send(${o}, ${p})`);
    this.blockedSends += 1;
    await this.noChange(`상한 찬 send(${o}, ${p})`, async () => {
      const id = await this.#paymentIdOf(o);
      await this.payment.pool.query('update payment_confirm_job set next_attempt_at = $2 where payment_id = $1', [id, new Date(this.clock.now())]);
      // 틱 하나(잡기와 시작). whenIdle은 상한을 쥔 다른 주문의 기다리는 호출까지 기다려 쓰지 않는다. 잘못 잡아 보냈으면 대역에 요청이 보인다
      const tick = await this.#drive(this.#runner.tick());
      if (tick.claimed > 0) this.#violate(`상한 찬 send(${o}, ${p}): 상한이 찼는데 실행기가 명령 ${tick.claimed}개를 잡았다`);
      await sleep(5);
      const job = await this.payment.pool.query<{ n: number }>('select count(*)::int as n from payment_confirm_job where payment_id = $1', [id]);
      if (job.rows[0]!.n !== 1) this.#violate(`상한 찬 send(${o}, ${p}): 승인 작업 행이 남지 않았다`);
      if (this.#proxies.get(p)!.isWaiting(ids.orderId)) this.#violate(`상한 찬 send(${o}, ${p}): 상한이 찼는데 결제사에 보냈다`);
    });
  }

  /**
   * 접수 쓰임새를 부른다(accept 걸음과 집중 시험). change로 본문·계정을 틀리게 해 거절을 본다(코드 리뷰 M4)
   */
  async acceptWith(o: number, k: number, change: { pg?: 'SIMULATOR' | 'PORTONE'; paymentId?: string; amount?: number; accountId?: string } = {}, pre: MState = this.obs) {
    const ids = this.#ids.get(o)!;
    const pg = pre.att[ak(o, k)]!.pg;
    const auth = ids.auth.get(pg)!;
    const attemptId = ids.attempts.get(k)!;
    const asPg = change.pg ?? PG_NAME[pg]!;
    const body =
      asPg === 'PORTONE'
        ? { pg: 'PORTONE' as const, attemptId, paymentId: change.paymentId ?? `pay-${ids.orderId}`, txId: auth.txId ?? 'tx-none', paymentToken: auth.paymentToken ?? 'token-none' }
        : { pg: 'SIMULATOR' as const, attemptId, paymentKey: auth.paymentKey ?? 'key-none', amount: change.amount ?? AMOUNT };
    const accountId = change.accountId ?? ids.accountId;
    const idem = { accountRef: accountId, operation: ACCEPT_PAYMENT_OPERATION, key: randomUUID(), requestHash: requestFingerprint('POST', `/v1/orders/${ids.orderId}/payment-acceptance`, Buffer.from(JSON.stringify(body))) };
    return this.#acceptUse.execute({ accountId, purchaseSessionId: ids.psid, orderId: ids.orderId, idem, body });
  }

  /** 대역 구매 세션: 주문을 만든 세션만 그 주문의 계정으로 있다 */
  #sessionOf(sid: string) {
    const ids = [...this.#ids.values()].find((x) => x.psid === sid);
    return ids === undefined ? undefined : { sessionId: sid, accountId: ids.accountId, eventId: this.eventId, journeyId: sid };
  }

  /**
   * 집중 시험(임대 소유자 조건, 코드 리뷰 M8): 옛 파드가 그 승인 명령을 잡은 채 멈춘 사이 임대가 끝나 새 실행기가 잡아 보낸 뒤, 옛 파드가 깨어나
   * 운영 저장소(DrizzleConfirmJobs)로 늦은 쓰기를 한다. 결과(표시·다시 미룸·놓기·지우기 각각)와 그 뒤 작업 행 소유자를 돌려준다
   */
  async staleOwnerWrites(o: number, p: number): Promise<{ markSent: string; reschedule: boolean; release: boolean; drop: boolean; owner: string | null; sent: boolean }> {
    const ids = this.#ids.get(o)!;
    const move: SpecMove = { a: 'send', o, p };
    const pre = this.obs;
    if (!enabled(this.scope, pre, move)) throw new Error('staleOwnerWrites: 명세가 지금 send를 허락하지 않는다');
    this.log.push(`send(${o}, ${p}, 임대 넘겨받음)`);
    this.steps += 1;
    const id = await this.#paymentIdOf(o);
    const old = new DrizzleConfirmJobs({ database: this.payment, clock: this.clock });
    await this.payment.pool.query('update payment_confirm_job set next_attempt_at = $2 where payment_id = $1', [id, new Date(this.clock.now())]);
    const [mine] = await old.claimDue(PG_NAME[p]!, 1, 'mbt-old-pod', 30_000);
    if (mine === undefined || mine.paymentId !== id) throw new Error('staleOwnerWrites: 옛 파드가 명령을 잡지 못했다');
    // 옛 파드가 멈춘 사이 임대가 끝나 새 실행기가 잡아 보낸다(흉내: 임대 시간이 지남)
    await this.payment.pool.query('update payment_confirm_job set lease_until = $2 where payment_id = $1', [id, new Date(this.clock.now() - 1)]);
    await this.#runner.tick();
    await until(`새 실행기의 승인 요청(${o}, ${p})`, () => this.#proxies.get(p)!.isWaiting(ids.orderId));
    const markSent = await old.markSent(mine);
    const reschedule = await old.reschedule(mine, this.clock.now() + 60_000, { countRetry: true, clearSent: true });
    const release = await old.release(mine);
    const drop = await old.dropJob(mine);
    const row = (await this.payment.pool.query<{ lease_owner: string | null }>('select lease_owner from payment_confirm_job where payment_id = $1', [id])).rows[0];
    const sent = await this.#sentPending(o);
    // 새 실행기의 보냄은 명세 send 한 걸음이다(옛 파드의 늦은 쓰기는 상태를 바꾸지 않아야 한다)
    this.clock.advance(1);
    await this.#observe();
    for (const d of compareState(this.scope, specNext(this.scope, pre, move), this.obs)) this.#violate(`명세 다음 상태와 다름(임대 넘겨받음): ${d.msg}`);
    for (const v of invariantViolations(this.scope, this.obs)) this.#violate(v);
    return { markSent, reschedule, release, drop, owner: row?.lease_owner ?? null, sent };
  }

  /** 지금 실행기의 임대 소유자 이름(집중 시험이 견준다) */
  runnerPod(): string {
    return `mbt-pay-${this.#podN}`;
  }
}
