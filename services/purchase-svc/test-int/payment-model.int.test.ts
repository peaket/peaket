// 결제 모델 기반 시험(wbs 2.7.6, docs/verification.md §2.4, V-T40, BUILD_ORDER PRF-210). PostgreSQL 18 하나에 purchase DB·payment DB를 두고, 두 서비스의 운영 코드
// (주문·결제 시도·접수·만료·Saga·승인 실행기·결과 모름 조회·결과 반영·발권 실행기)와 결제사 시뮬레이터 둘(토스형·포트원형)을 한 프로세스에서 돈다. 명령은 명세
// specs/payment.qnt의 동작과 이름이 같다(대응·흉내는 payment-model/system.ts 머리말). 명세 쪽 검사(이름·기록 해시·동작 도달·명세 옮김)는 payment-model-spec.int.test.ts다.
// ① 무작위 명령 순서(fc.asyncModelRun): 명세 정본 범위 셋에서 걸음마다 명세 불변식 ①~⑥(①은 두 시뮬레이터 원장으로도)과 앞 관측에서 계산한 명세 다음 상태(칸마다)가 지켜진다.
//    실행마다 채널 동시 승인 호출 상한을 넉넉하게 또는 1·2로 두고(상한이 찬 동안의 send는 실행기를 돌려 '보내지 않음'을 본다), 결과 반영은 사건 길·당기기 길을
//    시드한 난수로 고른다. 실행 전체에서 정본 범위가 고를 수 있는 동작마다 1번 이상 돌았는지 맨 끝 시험이 단언한다. 단 무작위에서 드물게만 나와 연속 실행에서
//    0번이 나올 수 있는 동작(RARE_IN_RANDOM)은 빼고, 그 동작은 결정적 시험이 받친다(맨 끝 시험이 그 시험들이 실제로 돌렸는지 단언한다):
//    - eventRefund: 집중(회차 취소 환불)과 재생 기록 · respond: 정상 길과 재생 · expireCommand: 집중(접수 뒤 기한 지남)과 재생
//    - compStart·compFence·compCancel·csConfirm·overdue: 집중(보상)과 재생 · pgCancel: 집중(결제사 쪽 전액 취소)과 재생
//    - timeout: 집중(시간 초과)과 재생 · ticketBreaks: 집중(발권 불가)과 재생
// ② 경합(fc.scheduler): 운영 코드의 DB 문 차례를 스케줄러가 섞고, 경합 쌍(commands.ts PAIRS)을 함께 돌린 결과가 어느 한 차례의 명세 다음 상태와 같고 그 차례에서 할 수
//    없는 뒤 걸음만 졌다(직렬 가능). 무작위가 드물게 닿는 쌍은 그 상태를 바로 만든 집중 경합 시험이 보고, 쌍 종류마다 1번 이상 돌았는지 맨 끝 시험이 단언한다.
//    경합의 재현 한계: 스케줄러가 고르는 문의 후보는 실제 시간(DB 호출이 돌아오기를 20ms까지 기다림)에 따라 달라, 같은 시드로도 차례가 같다고 보장하지 않는다.
// ③ 집중 시험: 정상 길, 승인 기한이 지난 판매 예약·승인 명령(T8·T11), 접수의 대조(틀린 결제사·paymentId·금액·남의 계정), 시간 초과·재시작 뒤 조회로 확정,
//    임대 소유자 조건(옛 파드의 늦은 쓰기), 결제사 쪽 전액 취소, 전환 뒤 고정, 보상, 웹훅(지표로 처리 길을 가린다), 같은 주문의 승인 명령 다시 보내기.
// ④ 동작 기록 재생(V-T40 ③): tools/spec-check traces가 낸 명세 기록 19개를 같은 이름의 동작으로 운영 코드에 다시 돌려, 걸음마다 관측이 기록의 다음 상태와 같다.
//    모든 걸음을 재생해야 하고(알려진 차이가 없다), 어긋나면 처음 어긋난 걸음 번호를 남긴다.
// 횟수와 시간(CI 기본, 코드 리뷰 M12): MBT_RUNS(기본 16, 범위마다. 경합은 그 반), MBT_TIME_LIMIT_MS(기본 45초, 속성 하나의 시간 한도. 넘으면 그때까지 돈 것으로 끝낸다.
//    끊긴 판은 다음 걸음에서 멈추고 닫힌 뒤 다음 판·시험으로 간다: checkProperty, docs/verification.md §2.4 둘째 줄, W12-vt40).
//    로컬에서 이 기본 값으로 파일 하나가 약 4분이다(2026-11-10). 실패를 다시 돌리려면 MBT_SEED·MBT_PATH. 걸음 기록: MBT_DEBUG=<파일>. 처음 실패에서 멈추기: MBT_NO_SHRINK=1.
// 운영 코드 변이 확인(2026-11-10, 하나씩 넣고 되돌림, MBT_NO_SHRINK=1, CI 기본 값. 결과는 docs/verification.md V-T40 행에도 적는다):
// - M1 결제사 고정 깸(승인 실행기·결과 모름 조회가 결제 원장의 결제사 대신 지금 전환 상태로 결제사를 고름, 운영 코드): 집중(전환 뒤 고정)과 무작위 셋이 잡음(명세 ②).
// - M2 발권 성공 반영의 주문 상태 조건을 모두 뺌: 집중(보상)·집중 경합(늦은 발권 답 ∥ 보상 시작)이 잡음(명세 ⑥). 무작위는 이번 실행 수(범위마다 16번)로는 못 잡음
//   (늦은 성공 답과 보상 시작이 겹치는 상태가 드물다). 조건 하나만 빼면 DB 지연 제약 order_status_has_event가 커밋을 막아 효과가 없다.
// - M3 승인 실행기가 결과 모름을 실패로 가정: 집중(시간 초과)과 무작위가 잡음(명세 ⑤).
// - M4 웹훅 본문을 믿음: 집중(웹훅)이 잡음(명세 ③). M5 승인 명령 멱등의 대조를 뺌: 집중(멱등)이 잡음(명세 ①·②).
// - M6 임대 소유자 조건(ownLease)을 뺌: 집중(임대)이 잡음. 무작위는 못 잡음(옛 파드가 멈춘 사이 넘겨받는 걸음이 명세에 없다).
// - M7 Saga 승인 명령의 기한 확인을 뺌: 집중(승인 기한)과 무작위가 잡음. 재생은 못 잡음(기록에 '판매 예약 뒤 기한 지남 → 승인 명령'이 없다).
import 'reflect-metadata';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabase, type Database, fakeClock } from '@peaket/platform';
import fc, { type Scheduler, type SchedulerAct, type SchedulerSequenceItem } from 'fast-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migratePayment } from '../../payment-svc/scripts/migrate.mjs';
import { DrizzleWebhookStore } from '../../payment-svc/src/modules/payment/adapters/db/drizzle-webhook-store.js';
import { ReceivePaymentWebhook } from '../../payment-svc/src/modules/payment/application/receive-payment-webhook.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { SPEC_ACTIONS } from './payment-model/actions.js';
import { Act, commandArbs, PAIRS, pairArb, type World } from './payment-model/commands.js';
import { readTrace, replay, scopeOf } from './payment-model/itf.js';
import type { Scope, SpecMove } from './payment-model/spec.js';
import { labelOf, PaymentSystem, seededRandom, type SystemOptions } from './payment-model/system.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SPEC_FILE = resolve(HERE, '..', '..', '..', 'specs', 'payment.qnt');
const TRACES = join(HERE, 'payment-model', 'traces');
const specText = readFileSync(SPEC_FILE, 'utf8');
const manifest = JSON.parse(readFileSync(join(TRACES, 'manifest.json'), 'utf8')) as { files: string[] };
const RUNS = Number(process.env.MBT_RUNS ?? 16);
const CONTENTION_RUNS = Math.max(1, Math.round(RUNS / 2));
const TIME_LIMIT_MS = Number(process.env.MBT_TIME_LIMIT_MS ?? 45_000);
/** 속성 시험 하나의 시험 시간 한도(속성 한도 + 닫기 여유) */
const PROPERTY_TIMEOUT_MS = TIME_LIMIT_MS + 60_000;
const replayParams = {
  ...(process.env.MBT_SEED ? { seed: Number(process.env.MBT_SEED) } : {}),
  ...(process.env.MBT_PATH ? { path: process.env.MBT_PATH } : {}),
  ...(process.env.MBT_NO_SHRINK ? { endOnFailure: true } : {}),
  interruptAfterTimeLimit: TIME_LIMIT_MS,
  markInterruptAsFailure: false,
};
/** 정본 범위에서 고를 수 없는 동작(웹훅 걸음은 WEBHOOK_QUERY가 막는다, 웹훅은 집중 시험이 본다) */
const NOT_IN_CANON = new Set(['webhook']);
/** 무작위에서 드물게만 나오는 동작(기록된 연속 실행에서 범위마다 16번에 1~5번): 무작위 도달 단언에서 빼고 결정적 시험(집중·재생)이 받친다(머리 주석) */
const RARE_IN_RANDOM = ['eventRefund', 'respond', 'expireCommand', 'compStart', 'compFence', 'compCancel', 'csConfirm', 'overdue', 'pgCancel', 'timeout', 'ticketBreaks'] as const;
/** 결정적 시험이 돌린 동작 수(집중·집중 경합, 재생) */
const focusedCounts: Record<string, number> = {};
const replayCounts: Record<string, number> = {};
/** 무작위·경합 속성이 만든 시스템과 재생 시스템(나머지는 결정적 집중 시험이다) */
const randomSystems = new WeakSet<PaymentSystem>();
const replaySystems = new WeakSet<PaymentSystem>();

let server: PostgresContainer | undefined;
let purchase: Database;
let payment: Database;
const systems: PaymentSystem[] = [];

beforeAll(async () => {
  server = await startPostgres();
  const root = createDatabase({ url: server.url, profile: 'general', max: 2, applicationName: 'payment-model-root' });
  await root.pool.query('create database purchase_m');
  await root.pool.query('create database payment_m');
  await root.close();
  const url = (db: string) => {
    const u = new URL(server!.url);
    u.pathname = `/${db}`;
    return u.toString();
  };
  await migratePurchase(url('purchase_m'));
  await migratePayment(url('payment_m'));
  purchase = createDatabase({ url: url('purchase_m'), profile: 'general', max: 12, applicationName: 'payment-model-purchase' });
  payment = createDatabase({ url: url('payment_m'), profile: 'general', max: 12, applicationName: 'payment-model-payment' });
}, 180_000);
afterAll(async () => {
  for (const s of systems) await s.close().catch(() => undefined);
  await Promise.allSettled([purchase?.close(), payment?.close()]);
  server?.stop();
});

/**
 * 시스템 하나를 만든다. 열린 다른 PaymentSystem이 있으면 하네스 오류다(시험·판은 하나씩 열고 닫는다. 앞 판이 닫히지 않아 행이 섞이는 것이
 * '결제사 1 대역이 …' 같은 결제 위반으로 위장되지 않고 이름으로 드러난다). made는 준비(init) 전에 부른다(속성 도우미가 끊긴 판에 중단 표시를 잇는다)
 */
const make = async (scope: Scope, o: SystemOptions = {}, made?: (s: PaymentSystem) => void) => {
  if (systems.length > 0) throw new Error(`하네스: 열린 PaymentSystem이 ${systems.length}개 남았는데 새로 만든다(앞 판·시험이 닫히지 않았다)`);
  const s = new PaymentSystem(purchase, payment, fakeClock({ now: Date.now() }), scope, o);
  systems.push(s);
  made?.(s);
  try {
    await s.init();
  } catch (e) {
    await s.close().catch(() => undefined);
    systems.splice(systems.indexOf(s), 1);
    throw e;
  }
  return s;
};
/** 시스템 하나로 body를 돌리고 늘 닫는다(실패한 시험도 행을 남기지 않는다, 코드 리뷰 M10). body가 끝났으면 불변식 위반을 실패로 낸다 */
async function using<T>(s: PaymentSystem, body: () => Promise<T>): Promise<T> {
  let ok = false;
  try {
    const out = await body();
    ok = true;
    return out;
  } finally {
    await s.close();
    systems.splice(systems.indexOf(s), 1);
    if (ok && !randomSystems.has(s)) {
      const into = replaySystems.has(s) ? replayCounts : focusedCounts;
      for (const [k, n] of Object.entries(s.counts)) into[k] = (into[k] ?? 0) + n;
    }
    if (ok && s.violations.length > 0) throw new Error(`불변식 위반:\n${s.violations.join('\n')}`);
  }
}
const run = async (s: PaymentSystem, moves: SpecMove[]) => {
  for (const m of moves) {
    await s.move(m);
    if (s.violations.length > 0) throw new Error(`불변식 위반:\n${s.violations.join('\n')}`);
  }
};

/** 속성 한 번 부르기의 판(속성 시험 한 번의 실행)들이 시스템을 만드는 곳. 부르기마다 하나다(중단 신호를 모듈 전역 하나로 두지 않는다) */
class PropertyRuns {
  #stopped = false;
  readonly #made = new Set<PaymentSystem>();
  /** 판이 시스템을 만든다. 속성이 이미 돌아왔으면(끊긴 판) 만들지 않고 던진다 */
  readonly make = async (scope: Scope, o: SystemOptions = {}): Promise<PaymentSystem> => {
    if (this.#stopped) throw new Error('중단: 시간 한도에 끊긴 판(속성이 이미 돌아왔다)');
    return make(scope, o, (s) => this.#made.add(s));
  };
  /** 속성이 돌아왔다(통과·실패·끊김 모두): 새 시스템을 막고, 아직 열린 시스템에 중단 표시를 한다(다음 걸음에서 멈춘다) */
  stop(): void {
    this.#stopped = true;
    for (const s of this.#made) if (systems.includes(s)) s.halt();
  }
}
/**
 * 속성 실행 도우미: 무작위 명령 순서·경합·집중 경합(focusedPair) 속성과 재현 시험(R1·R2)이 함께 쓴다. 판의 본문은 runs.make로 시스템을 만든다.
 * fast-check의 시간 한도(interruptAfterTimeLimit)는 끊긴 판의 결과만 버리고 그 본문을 멈추지 않는다. 그래서 속성이 돌아오면 끊긴 판에 중단 표시를 하고,
 * 본문이 모두 끝나(닫기가 그 판의 행을 다른 판의 잡기 대상에서 뺌) 열린 PaymentSystem이 0이 된 뒤에 돌아온다(docs/verification.md §2.4 둘째 줄)
 */
async function checkProperty<Ts extends [unknown, ...unknown[]]>(arbs: { [K in keyof Ts]: fc.Arbitrary<Ts[K]> }, body: (runs: PropertyRuns, ...args: Ts) => Promise<void>, params: fc.Parameters<Ts>): Promise<void> {
  const runs = new PropertyRuns();
  /** 진행 중인 판의 본문 */
  const bodies = new Set<Promise<void>>();
  const predicate = (...args: Ts): Promise<void> => {
    const p = body(runs, ...args);
    bodies.add(p);
    p.then(
      () => bodies.delete(p),
      () => bodies.delete(p),
    );
    return p;
  };
  let failure: { error: unknown } | undefined;
  try {
    await fc.assert(fc.asyncProperty<Ts>(...arbs, predicate), params);
  } catch (error) {
    failure = { error };
  }
  runs.stop();
  await Promise.allSettled([...bodies]);
  if (systems.length > 0) throw new Error(`하네스: 끊긴 판이 닫히지 않았다(열린 PaymentSystem ${systems.length}개)`, failure && { cause: failure.error });
  if (failure) throw failure.error;
}

/** 재현 시험(R1·R2)이 판 하나를 지켜보는 칸: 본문이 시작했는지, 만든 시스템, 본문이 끝났는지와 끝난 까닭, 끝남 약속 */
class RunWatch {
  started = false;
  made: PaymentSystem | undefined;
  ended = false;
  /** 본문이 끝난 까닭: 정상 끝이면 '정상 끝', 던졌으면 그 오류 문구 */
  outcome: string | undefined;
  #resolve: () => void = () => undefined;
  readonly end = new Promise<void>((r) => {
    this.#resolve = r;
  });
  /** 판의 본문을 돌리며 지켜본다(던진 오류는 그대로 다시 던진다) */
  async track(body: () => Promise<void>): Promise<void> {
    this.started = true;
    try {
      await body();
      this.#finish('정상 끝');
    } catch (e) {
      this.#finish(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
  #finish(outcome: string): void {
    this.outcome = outcome;
    this.ended = true;
    this.#resolve();
  }
}
/**
 * 재현 시험(R1·R2)의 문: 판의 본문을 붙들고, fast-check가 그 판을 끝낸 뒤에야 푼다(afterEach 플러그인). 본문이 문에서 기다리는 동안 판은 시간 한도로만
 * 끝날 수 있으므로 끊김이 늘 판 도중(문)에서 일어난다. 시간 한도 값은 문까지 가는 앞 걸음보다 길기만 하면 되고 기계 속도와 상관없다(리뷰 RVvt-1).
 * 문은 다음 매크로 작업(setImmediate)에서 연다: 그 사이 fast-check가 돌아오는 차례(마이크로 작업)가 끝나, 고친 하네스라면 도우미가 중단 표시를 한 뒤다
 */
class InterruptGate {
  /** 본문이 문에 닿았다 */
  reached = false;
  /** fast-check가 판을 끝낸 그때 본문이 문에서 기다리고 있었는가 */
  heldAtEnd: boolean | undefined;
  #open: () => void = () => undefined;
  readonly #opened = new Promise<void>((r) => {
    this.#open = r;
  });
  /** 속성 매개변수 plugins에 넣는다(fast-check afterEach 플러그인과 같은 자리: 판 하나의 실행이 fast-check 쪽에서 끝난 뒤) */
  plugin<Ts>(): fc.Plugin<Ts> {
    const ended = () => {
      this.heldAtEnd = this.reached;
      setImmediate(this.#open);
    };
    return () => ({
      decorateRun: (nestedRun) => (value) => {
        const out = nestedRun(value);
        if (!(out instanceof Promise)) {
          ended();
          return out;
        }
        return out.finally(ended);
      },
    });
  }
  /** 본문이 문에서 기다린다 */
  async wait(): Promise<void> {
    this.reached = true;
    await this.#opened;
  }
  /** 명령 순서에 끼우는 문(명세 걸음이 아니다) */
  readonly command: fc.AsyncCommand<World, World> = {
    check: () => true,
    run: () => this.wait(),
    toString: () => '문(속성이 판을 끊은 뒤 풀림)',
  };
}
/** 그 판의 주문 행 가운데 system.ts #isolate가 잡기 밖으로 미루는 행의 수(값과 상관없이)와, 그 가운데 아직 다른 판의 실행기 잡기 대상인 행 수('infinity'로 미루거나 비우는 칸) */
async function claimable(s: PaymentSystem): Promise<{ rows: number; live: { saga: number; ticket: number; query: number; confirm: number } }> {
  const ids = [s.scope.orders.map((o) => s.orderIdOf(o))];
  const p = (
    await purchase.pool.query<{ rows: number; saga: number; ticket: number }>(
      `select (select count(*)::int from order_saga_job where order_id = any($1::uuid[])) + (select count(*)::int from ticket_issue_job where order_id = any($1::uuid[])) as rows,
              (select count(*)::int from order_saga_job where order_id = any($1::uuid[]) and pull_next_at is distinct from 'infinity') as saga,
              (select count(*)::int from ticket_issue_job where order_id = any($1::uuid[]) and (issue_due_at <> 'infinity' or next_attempt_at is not null)) as ticket`,
      ids,
    )
  ).rows[0]!;
  const q = (
    await payment.pool.query<{ rows: number; query: number; confirm: number }>(
      `select (select count(*)::int from payment where order_id = any($1::uuid[]) and next_query_at is not null) + (select count(*)::int from payment_confirm_job j join payment x on x.id = j.payment_id where x.order_id = any($1::uuid[])) as rows,
              (select count(*)::int from payment where order_id = any($1::uuid[]) and next_query_at is not null and next_query_at <> 'infinity') as query,
              (select count(*)::int from payment_confirm_job j join payment x on x.id = j.payment_id where x.order_id = any($1::uuid[]) and j.next_attempt_at is distinct from 'infinity') as confirm`,
      ids,
    )
  ).rows[0]!;
  return { rows: p.rows + q.rows, live: { saga: p.saga, ticket: p.ticket, query: q.query, confirm: q.confirm } };
}
/**
 * 재현 시험의 시간 한도: 문(InterruptGate)이 판을 붙들므로 판 길이와 견줄 필요가 없고, 시스템 준비와 문까지의 앞 걸음보다 길기만 하면 된다.
 * 로컬(2026-11-22)에서 문까지의 준비와 앞 걸음은 R1·R2 모두 1초 안에 끝난다. 느린 기계에도 여유를 둔다(리뷰 RVvt-1)
 */
const R_LIMIT_MS = 5_000;
/** 하네스 PaymentSystem이 중단 표시를 보고 걸음 첫 줄에서 던지는 오류 문구(payment-model/system.ts) */
const HALTED = '중단: 시간 한도에 끊긴 판';
/**
 * 재현 시험(R1·R2)의 공통 단언: 속성이 시간 한도에 끊겨 돌아온 그때(기다리지 않고 바로 찍는다) 그 판의 본문이 끝났고, 열린 PaymentSystem이 0이며,
 * 그 판의 행이 다른 판의 잡기 대상에서 빠졌다. 끝나면 남은 본문을 끝까지 기다린다(고치기 전 하네스에서도 다음 시험을 오염시키지 않는다)
 */
async function expectStoppedAndClosed(property: Promise<unknown>, watch: RunWatch, gate: InterruptGate): Promise<void> {
  try {
    // 빈 시험 막기 ①: 판이 정말 끊겼다(판 하나짜리 속성이 한 번도 끝나지 못하면 fast-check가 이 문구로 실패를 낸다)
    await expect(property).rejects.toThrow(/Property interrupted after 0 tests/);
    const at = { ended: watch.ended, open: systems.length, outcome: watch.outcome };
    const made = watch.made;
    // 빈 시험 막기 ②: 끊김이 판 도중(본문이 문에서 기다리는 동안)에 일어났고, 본문이 시스템을 만들었다
    expect(gate.heldAtEnd).toBe(true);
    expect(made).toBeInstanceOf(PaymentSystem);
    const steps = made!.steps;
    const rows = await claimable(made!);
    // 빈 시험 막기 ③: 그 판이 잡기 대상이 될 행(Saga·발권 작업, 결제 원장·승인 명령)을 만들었다
    expect(rows.rows).toBeGreaterThan(0);
    // 본문은 중단 표시로 멈췄다(제 끝까지 돌고 닫힌 것이 아니다, 리뷰 RVvt-2)
    expect({ ...at, grew: made!.steps - steps, live: rows.live }).toEqual({ ended: true, open: 0, outcome: HALTED, grew: 0, live: { saga: 0, ticket: 0, query: 0, confirm: 0 } });
  } finally {
    if (watch.started) await watch.end;
  }
}
const PROPOSED = scopeOf(specText, 'payment_proposed');
const ATTEMPTS = scopeOf(specText, 'payment_proposed_attempts');
const ONE: Scope = { ...PROPOSED, orders: [1] };
const upToSent = (o: number, p = 1): SpecMove[] => [
  { a: 'newAttempt', o },
  { a: 'auth', o, k: 1 },
  { a: 'accept', o, k: 1 },
  { a: 'reserve', o, c: 'RESERVED' },
  { a: 'command', o },
  { a: 'send', o, p },
];

// ---- 집중 시험 ----
test('V-T40 정상 길: 결제 시도 → 인증 → 접수 → 판매 예약 → 승인 명령 → 승인 호출·처리·답 → 결과 반영 → 발권 → 답이 명세 다음 상태와 같다', async () => {
  const s = await make(ONE);
  await using(s, async () => {
    await run(s, [...upToSent(1), { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'respond', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }, { a: 'issue', o: 1 }, { a: 'ticketSvc', o: 1, c: 'OK' }, { a: 'issueAck', o: 1 }]);
    expect(s.obs.ord[1]).toEqual({ st: 'CONFIRMED', apg: 1, job: false, over: false, cs: false });
    expect(s.obs.pay['1,1']).toBe('APPROVED');
    expect(s.obs.tks[1]!.tk).toBe('ISSUED');
  });
}, 60_000);

test('V-T40 집중(승인 기한): 기한이 지난 접수 주문의 판매 예약은 묶지 않고, 판매 예약 뒤 기한이 지난 주문의 승인 명령은 보내지 않으며, 둘 다 과금 없이 실패(EXPIRED)로 끝나고 판매 예약이 풀린다(명세 reserve·command, 코드 리뷰 H1)', async () => {
  const s = await make(PROPOSED);
  await using(s, async () => {
    await run(s, [{ a: 'newAttempt', o: 1 }, { a: 'auth', o: 1, k: 1 }, { a: 'accept', o: 1, k: 1 }, { a: 'deadlinePasses', o: 1 }, { a: 'reserve', o: 1, c: 'FAILED' }]);
    await run(s, [{ a: 'newAttempt', o: 2 }, { a: 'auth', o: 2, k: 1 }, { a: 'accept', o: 2, k: 1 }, { a: 'reserve', o: 2, c: 'RESERVED' }, { a: 'deadlinePasses', o: 2 }, { a: 'command', o: 2 }]);
    expect([s.obs.ord[1]!.st, s.obs.ord[2]!.st]).toEqual(['FAILED', 'FAILED']);
    expect([s.obs.pay['1,1'], s.obs.pay['2,1']]).toEqual(['NONE', 'NONE']);
    const rows = await s.purchaseDb().pool.query<{ failure_reason: string }>('select failure_reason from purchase_order where id = any($1::uuid[]) order by id', [[s.orderIdOf(1), s.orderIdOf(2)]]);
    expect(rows.rows.map((r) => r.failure_reason)).toEqual(['EXPIRED', 'EXPIRED']);
    const sales = await s.purchaseDb().pool.query('select status from seat_sale where order_id = any($1::uuid[])', [[s.orderIdOf(1), s.orderIdOf(2)]]);
    expect(sales.rows).toEqual([]);
    expect((await s.paymentDb().pool.query('select 1 from payment where order_id = any($1::uuid[])', [[s.orderIdOf(1), s.orderIdOf(2)]])).rows).toEqual([]);
  });
}, 60_000);

test('V-T40 집중(접수): 틀린 결제사·포트원 paymentId·금액·남의 계정으로 접수하면 쓰임새가 거절하고 주문·시도가 그대로이며, 맞는 접수만 받는다(코드 리뷰 M4)', async () => {
  const s = await make(PROPOSED);
  await using(s, async () => {
    await run(s, [{ a: 'newAttempt', o: 1 }, { a: 'auth', o: 1, k: 1 }, { a: 'toggleSwitch' }, { a: 'newAttempt', o: 2 }, { a: 'auth', o: 2, k: 1 }]);
    const answers: unknown[] = [];
    await s.noChange('토스형 시도에 포트원 본문', async () => answers.push(await s.acceptWith(1, 1, { pg: 'PORTONE' })));
    await s.noChange('토스형 시도에 틀린 금액', async () => answers.push(await s.acceptWith(1, 1, { amount: 1 })));
    await s.noChange('남의 계정', async () => answers.push(await s.acceptWith(1, 1, { accountId: '00000000-0000-4000-8000-0000000000aa' })));
    await s.noChange('포트원형 시도에 틀린 paymentId', async () => answers.push(await s.acceptWith(2, 1, { paymentId: 'pay-someone-else' })));
    expect(answers).toEqual([
      { status: 'REJECTED', reason: 'ATTEMPT_MISMATCH' },
      { status: 'REJECTED', reason: 'AMOUNT_MISMATCH' },
      { status: 'REJECTED', reason: 'SESSION_ENDED' },
      { status: 'REJECTED', reason: 'ATTEMPT_MISMATCH' },
    ]);
    await run(s, [{ a: 'accept', o: 1, k: 1 }, { a: 'accept', o: 2, k: 1 }]);
    expect([s.obs.ord[1]!.apg, s.obs.ord[2]!.apg]).toEqual([1, 2]);
  });
}, 60_000);

// ---- 동작 기록 재생 ----
let replayed = 0;
test.each(manifest.files)('V-T40 ③ 재생 %s: 걸음마다 운영 코드가 명세와 같은 상태에 닿고 모든 걸음을 재생한다', async (file) => {
  const { module, steps } = readTrace(join(TRACES, file));
  const sc = scopeOf(specText, module);
  const s = await make(sc);
  replaySystems.add(s);
  await using(s, async () => {
    expect(s.modelState()).toEqual(steps[0]!.state);
    const out = await replay(sc, s, steps);
    expect({ mismatch: out.mismatch, known: out.known, violations: s.violations }).toEqual({ mismatch: null, known: null, violations: [] });
    expect(out.replayed).toBe(out.steps);
    replayed += 1;
  });
}, 60_000);

// ---- 무작위 명령 순서 ----
const totals = { runs: 0, steps: 0, ms: 0, counts: {} as Record<string, number>, blockedSends: 0 };
/** 승인 기한이 지난 뒤의 판매 예약(T8)·승인 명령(T11) 걸음 수(무작위·경합 전체) */
const lateBranches = { reserve: 0, command: 0 };
const paths = { event: 0, pull: 0, pullThenEvent: 0 };
const pairKinds: Record<string, number> = {};
const tally = (t: typeof totals, s: PaymentSystem, started: number) => {
  t.runs += 1;
  t.steps += s.steps;
  t.ms += Date.now() - started;
  t.blockedSends += s.blockedSends;
  lateBranches.reserve += s.lateBranches.reserve;
  lateBranches.command += s.lateBranches.command;
  for (const [k, n] of Object.entries(s.counts)) t.counts[k] = (t.counts[k] ?? 0) + n;
  for (const k of Object.keys(paths) as Array<keyof typeof paths>) paths[k] += s.resultPaths[k];
  for (const [k, n] of Object.entries(s.pairKinds)) pairKinds[k] = (pairKinds[k] ?? 0) + n;
};
const VARIANTS: Array<[string, Scope]> = [
  ['payment_proposed: 주문 2·시도 1', PROPOSED],
  ['payment_proposed_attempts: 주문 1·시도 2', ATTEMPTS],
  ['payment_proposed_full: 주문 2·시도 2', scopeOf(specText, 'payment_proposed_full')],
];
test.each(VARIANTS)('V-T40 모델 기반 무작위 명령 순서(%s): 명세 불변식과 명세 다음 상태가 지켜진다', async (_name, scope) => {
  await checkProperty(
    [fc.array(fc.oneof(...commandArbs(scope)), { minLength: 600, maxLength: 1000 }), fc.constantFrom<number | undefined>(undefined, 1, 2), fc.nat()],
    async (runs, cmds, bulkhead, seed) => {
      const started = Date.now();
      const w: World = { s: await runs.make(scope, { random: seededRandom(seed), ...(bulkhead === undefined ? {} : { bulkhead }) }) };
      randomSystems.add(w.s);
      await using(w.s, async () => {
        try {
          await fc.asyncModelRun(() => ({ model: w, real: w }), cmds);
        } finally {
          tally(totals, w.s, started);
        }
      });
    },
    { numRuns: RUNS, ...replayParams },
  );
}, PROPERTY_TIMEOUT_MS);

// ---- 경합(fc.scheduler): 운영 코드의 DB 문 차례를 스케줄러가 섞고, 두 걸음을 함께 돌린 결과가 어느 한 차례와 같아야 한다 ----
const contention = { runs: 0, steps: 0, ms: 0, counts: {} as Record<string, number>, blockedSends: 0, pairs: 0, lost: 0 };
test.each(VARIANTS)('V-T40 경합(fc.scheduler, %s): 함께 돌린 두 걸음의 결과가 어느 한 차례의 명세 다음 상태와 같고 불변식이 지켜진다', async (_name, scope) => {
  await checkProperty(
    [fc.scheduler(), fc.array(fc.oneof({ arbitrary: pairArb(), weight: 40 }, ...commandArbs(scope)), { minLength: 300, maxLength: 500 }), fc.constantFrom<number | undefined>(undefined, 1), fc.nat()],
    async (runs, sch, cmds, bulkhead, seed) => {
      const started = Date.now();
      const w: World = { s: await runs.make(scope, { scheduler: sch, random: seededRandom(seed), ...(bulkhead === undefined ? {} : { bulkhead }) }) };
      randomSystems.add(w.s);
      await using(w.s, async () => {
        try {
          await fc.asyncModelRun(() => ({ model: w, real: w }), cmds);
        } finally {
          tally(contention, w.s, started);
          contention.pairs += w.s.pairs.steps;
          contention.lost += w.s.pairs.lost;
        }
      });
    },
    { numRuns: CONTENTION_RUNS, ...replayParams },
  );
}, PROPERTY_TIMEOUT_MS);

interface PairOptions {
  /** a를 끝낸 뒤 b를 시작한다(PaymentSystem.pair) */
  serial?: boolean;
  /** 속성 매개변수 덮어쓰기(재현 시험 R2가 작은 시간 한도를 준다) */
  params?: fc.Parameters<[Scheduler]>;
  /** 스케줄러 감싸개(재현 시험 R3). 시스템은 감싼 스케줄러로 만든 뒤에 생기므로 늦게 받는다 */
  wrap?: (sch: Scheduler, system: () => PaymentSystem) => Scheduler;
  /** 재현 시험이 판을 지켜보는 칸 */
  watch?: RunWatch;
  /** 준비 걸음 after개 뒤에서 기다릴 것(재현 시험 R2의 문). 나머지 준비 걸음과 쌍은 그 뒤에 돈다 */
  hold?: { after: number; wait: () => Promise<void> };
}
/** 집중 경합 하나: setup으로 상태를 만든 뒤 쌍을 돌리고 결과 이름을 센다 */
async function focusedPair(scope: Scope, setup: SpecMove[], a: SpecMove, b: SpecMove, outcome: (s: PaymentSystem) => string, runs: number, opts: PairOptions = {}): Promise<Record<string, number>> {
  const seen: Record<string, number> = {};
  await checkProperty(
    [fc.scheduler()],
    async (props, sch) => {
      const body = async () => {
        let made: PaymentSystem | undefined;
        const system = () => {
          if (!made) throw new Error('focusedPair: 감싸개가 시스템을 만들기 전에 시스템을 찾았다');
          return made;
        };
        const s = await props.make(scope, { scheduler: opts.wrap ? opts.wrap(sch, system) : sch });
        made = s;
        if (opts.watch) opts.watch.made = s;
        await using(s, async () => {
          const at = opts.hold?.after ?? setup.length;
          await run(s, setup.slice(0, at));
          if (opts.hold) await opts.hold.wait();
          await run(s, setup.slice(at));
          await s.pair(a, b, opts.serial === undefined ? {} : { serial: opts.serial });
          for (const [k, n] of Object.entries(s.pairKinds)) pairKinds[k] = (pairKinds[k] ?? 0) + n;
          const o = outcome(s);
          seen[o] = (seen[o] ?? 0) + 1;
        });
      };
      await (opts.watch ? opts.watch.track(body) : body());
    },
    { numRuns: runs, ...replayParams, ...opts.params },
  );
  return seen;
}

/** 늦게 온 발권 성공 답 ∥ 보상 시작의 준비(승인·결과 반영 뒤 발권 기한 넘김 → CS 확인 → 발권 호출에 ticket-svc가 답함) */
const LATE_TICKET_SETUP: SpecMove[] = [...upToSent(1), { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'respond', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }, { a: 'overdue', o: 1 }, { a: 'csConfirm', o: 1 }, { a: 'issue', o: 1 }, { a: 'ticketSvc', o: 1, c: 'OK' }];
/** 승인 응답 ∥ 재시작의 준비(승인 호출을 보내고 결제사가 승인함, 답은 아직 실행기에 돌아가지 않음) */
const RESPOND_RESTART_SETUP: SpecMove[] = [...upToSent(1), { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }];
/**
 * 승인 응답 ∥ payment-svc 재시작의 허용 결과(결제 원장 상태): 두 차례 가운데 하나다(docs/verification.md §2.4 '무작위로 드문 경합', V-T40 행 '어느 한 차례의
 * 명세 다음 상태'). 값은 docs/features/payment.md §2 '승인 실행기의 첫 구현'이 정한다.
 * - 응답 먼저: '답 반영(한 트랜잭션)'이 ACCEPTED에서 승인으로 쓰고 명령 행을 지운다 → APPROVED. 뒤의 재시작은 잃을 호출이 없다.
 * - 재시작 먼저: 옛 실행기의 쓰기는 막히고 다시 뜬 실행기가 '임대 잔해(restart)'로 결제사를 다시 부르지 않고 UNKNOWN으로 쓴다 → UNKNOWN.
 * 어느 차례와도 맞지 않는 결과(직렬 가능이 아님)는 판마다 PaymentSystem.pair가 위반으로 잡고 using이 실패로 낸다
 */
const RESPOND_RESTART_ALLOWED: readonly string[] = ['UNKNOWN', 'APPROVED'];
/** 승인 응답 ∥ 재시작의 결과(결제 원장 상태) 판정: 결과가 있고 모두 허용 집합 안이다. 집중 경합의 스케줄러 차례와 재현 시험 R3가 같이 쓴다 */
function judgeRespondRestart(seen: Record<string, number>): void {
  expect(Object.keys(seen).length).toBeGreaterThan(0);
  expect(Object.keys(seen).filter((k) => !RESPOND_RESTART_ALLOWED.includes(k))).toEqual([]);
}

test('V-T40 집중 경합: 늦게 온 발권 성공 답과 보상 시작이 겹쳐도 결과는 어느 한 차례와 같고, 두 갈래(성공 반영이 먼저면 CONFIRMED, 보상이 먼저면 보상 중)가 모두 나온다(명세 ⑥)', async () => {
  const seen = await focusedPair(ONE, LATE_TICKET_SETUP, { a: 'issueAck', o: 1 }, { a: 'compStart', o: 1 }, (s) => s.obs.ord[1]!.st, 16);
  console.info(`발권 답 ∥ 보상 시작: ${JSON.stringify(seen)}`);
  expect(Object.keys(seen).sort()).toEqual(['COMPENSATING', 'CONFIRMED']);
}, PROPERTY_TIMEOUT_MS);

test('V-T40 집중 경합: 접수 ∥ 새 결제 시도가 겹쳐도 결과는 어느 한 차례와 같고, 두 갈래(접수가 먼저면 ACCEPTED, 새 시도가 먼저면 앞 시도 대체)가 모두 나온다(코드 리뷰 H5)', async () => {
  const seen = await focusedPair(ATTEMPTS, [{ a: 'newAttempt', o: 1 }, { a: 'auth', o: 1, k: 1 }], { a: 'accept', o: 1, k: 1 }, { a: 'newAttempt', o: 1 }, (s) => `${s.obs.ord[1]!.st}/${s.obs.att['1,1']!.st}`, 12);
  console.info(`접수 ∥ 새 시도: ${JSON.stringify(seen)}`);
  expect(Object.keys(seen).sort()).toEqual(['ACCEPTED/ACCEPTED', 'CREATED/SUPERSEDED']);
}, PROPERTY_TIMEOUT_MS);

test('V-T40 집중 경합: 승인 응답 ∥ payment-svc 재시작의 결과는 두 차례 가운데 하나이고(재시작 먼저면 쓰기가 막혀 결과 모름, 응답 먼저면 승인이 남고 재시작은 잃을 호출이 없다), 스케줄러 차례에서 결과 모름 갈래가 나온다(두 갈래, 코드 리뷰 H5)', async () => {
  const raced = await focusedPair(ONE, RESPOND_RESTART_SETUP, { a: 'respond', o: 1, p: 1 }, { a: 'restart' }, (s) => s.obs.pay['1,1']!, 8);
  // 스케줄러 차례에서는 대개 재시작의 DB 끊기가 응답의 쓰기보다 먼저 온다(쓰기는 문을 여러 개 지난다). 차례는 실제 시간에 따라 달라(머리 주석) 응답 먼저(APPROVED)도 나온다.
  // 응답 먼저 갈래는 차례를 정해 바로 만든다
  const serial = await focusedPair(ONE, RESPOND_RESTART_SETUP, { a: 'respond', o: 1, p: 1 }, { a: 'restart' }, (s) => `${s.obs.pay['1,1']}/${s.obs.env.restarts}`, 2, { serial: true });
  console.info(`응답 ∥ 재시작(스케줄러 차례): ${JSON.stringify(raced)}, 응답 먼저(차례 정함): ${JSON.stringify(serial)}`);
  judgeRespondRestart(raced);
  // 이 시험의 목적: 겹치면 재시작이 쓰기를 막아 결과 모름이 되는 갈래가 스케줄러 차례에서 나온다
  expect(Object.keys(raced)).toContain('UNKNOWN');
  expect(Object.keys(serial)).toEqual(['APPROVED/1']);
}, PROPERTY_TIMEOUT_MS);

test('V-T40 집중 경합: 전환 ∥ 접수, 전환 ∥ 새 결제 시도, 주문 만료 ∥ 새 결제 시도가 겹쳐도 결과는 어느 한 차례와 같다(무작위 경합이 느린 CI에서 놓칠 수 있는 쌍, 코드 리뷰)', async () => {
  await focusedPair(ONE, [{ a: 'newAttempt', o: 1 }, { a: 'auth', o: 1, k: 1 }], { a: 'toggleSwitch' }, { a: 'accept', o: 1, k: 1 }, (s) => s.obs.ord[1]!.st, 4);
  const pg = await focusedPair(ONE, [], { a: 'toggleSwitch' }, { a: 'newAttempt', o: 1 }, (s) => String(s.obs.att['1,1']!.pg), 6);
  const exp = await focusedPair(ONE, [], { a: 'expireOrder', o: 1 }, { a: 'newAttempt', o: 1 }, (s) => s.obs.ord[1]!.st, 6);
  console.info(`전환 ∥ 새 시도(시도의 결제사): ${JSON.stringify(pg)}, 만료 ∥ 새 시도: ${JSON.stringify(exp)}`);
}, PROPERTY_TIMEOUT_MS);

test('V-T40 집중 경합: 결과 모름 조회 ∥ 다른 주문의 승인 응답, 결과 반영 ∥ 다른 주문의 만료가 겹쳐도 결과는 어느 한 차례와 같다(무작위가 드물게 닿는 쌍)', async () => {
  await focusedPair(PROPOSED, [...upToSent(1), { a: 'timeout', o: 1, p: 1 }, { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, ...upToSent(2), { a: 'pgProcess', o: 2, p: 1, c: 'APPROVED' }], { a: 'query', o: 1, p: 1 }, { a: 'respond', o: 2, p: 1 }, (s) => `${s.obs.pay['1,1']}/${s.obs.pay['2,1']}`, 6);
  await focusedPair(PROPOSED, [...upToSent(1), { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'respond', o: 1, p: 1 }], { a: 'applyResult', o: 1, p: 1 }, { a: 'expireOrder', o: 2 }, (s) => `${s.obs.ord[1]!.st}/${s.obs.ord[2]!.st}`, 6);
}, PROPERTY_TIMEOUT_MS);

// ---- 하네스 재현 시험(W12-vt40): 시간 한도에 끊긴 판 멈추기, 승인 응답 ∥ 재시작의 응답 먼저 차례 ----
test('V-T40 R1 하네스(시간 한도): 시간 한도에 끊긴 무작위 판은 속성이 돌아오기 전에 멈추고 닫혀, 열린 PaymentSystem이 0이고 그 판의 행이 다른 판의 잡기 대상에서 빠진다', async () => {
  const watch = new RunWatch();
  const gate = new InterruptGate();
  // 앞 걸음(두 주문의 승인 호출까지)을 정해 두어 끊길 때 잡기 대상이 될 행이 있게 하고, 문 뒤에 늘 할 수 있는 걸음(pgProcess) 하나를 두며,
  // 그 뒤는 무작위 속성과 같은 명령 순서다
  const prefix = [...upToSent(1), ...upToSent(2)].map((m) => new Act(m, () => true));
  const afterGate = new Act({ a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, () => true);
  const property = checkProperty(
    [fc.array(fc.oneof(...commandArbs(PROPOSED)), { minLength: 600, maxLength: 1000 })],
    (runs, cmds) =>
      watch.track(async () => {
        const w: World = { s: await runs.make(PROPOSED) };
        watch.made = w.s;
        randomSystems.add(w.s);
        const all: Array<fc.AsyncCommand<World, World>> = [...prefix, gate.command, afterGate, ...cmds];
        await using(w.s, () => fc.asyncModelRun(() => ({ model: w, real: w }), all));
      }),
    { numRuns: 1, seed: 0x7640, interruptAfterTimeLimit: R_LIMIT_MS, markInterruptAsFailure: false, plugins: [gate.plugin()] },
  );
  await expectStoppedAndClosed(property, watch, gate);
}, PROPERTY_TIMEOUT_MS);

test('V-T40 R2 하네스(시간 한도): 시간 한도에 끊긴 집중 경합 판도 같은 방법으로 멈추고 닫힌다', async () => {
  const watch = new RunWatch();
  const gate = new InterruptGate();
  const property = focusedPair(ONE, LATE_TICKET_SETUP, { a: 'issueAck', o: 1 }, { a: 'compStart', o: 1 }, (s) => s.obs.ord[1]!.st, 1, {
    params: { interruptAfterTimeLimit: R_LIMIT_MS, markInterruptAsFailure: false, plugins: [gate.plugin()] },
    watch,
    // 승인 호출까지(Saga·승인 명령 행이 잡기 대상인 때) 문에서 끊고, 그 뒤 준비 걸음 일곱과 쌍이 남는다
    hold: { after: upToSent(1).length, wait: () => gate.wait() },
  });
  await expectStoppedAndClosed(property, watch, gate);
}, PROPERTY_TIMEOUT_MS);

/**
 * 재현 시험 R3의 스케줄러 감싸개: fc.scheduler의 스케줄러를 그대로 잇고, 재시작의 시작 문만 그 주문의 결제 원장이 ACCEPTED에서 벗어날 때까지
 * (승인 응답의 쓰기가 커밋됨, 감싸지 않은 pool로 읽는다) 안쪽 스케줄러에 넘기지 않는다. 미뤄 둔 문은 안쪽 count()에 들지 않아 하네스(#drive)가 그동안 응답 쪽 문만 푼다
 */
class RestartAfterRespondWrite implements Scheduler {
  readonly #restart = `시작 ${labelOf({ a: 'restart' })}`;
  readonly #inner: Scheduler;
  readonly #system: () => PaymentSystem;
  readonly #order: number;
  constructor(inner: Scheduler, system: () => PaymentSystem, order: number) {
    this.#inner = inner;
    this.#system = system;
    this.#order = order;
  }
  readonly schedule = <T>(task: Promise<T>, label?: string, metadata?: unknown, customAct?: SchedulerAct): Promise<T> => {
    if (label !== this.#restart) return this.#inner.schedule(task, label, metadata, customAct);
    return this.#respondWritten().then(() => this.#inner.schedule(task, label, metadata, customAct));
  };
  readonly scheduleFunction: Scheduler['scheduleFunction'] = (f, customAct) => this.#inner.scheduleFunction(f, customAct);
  scheduleSequence(items: SchedulerSequenceItem[], customAct?: SchedulerAct): ReturnType<Scheduler['scheduleSequence']> {
    return this.#inner.scheduleSequence(items, customAct);
  }
  count(): number {
    return this.#inner.count();
  }
  readonly waitOne = (customAct?: SchedulerAct) => this.#inner.waitOne(customAct);
  readonly waitAll = (customAct?: SchedulerAct) => this.#inner.waitAll(customAct);
  readonly waitNext = (count: number, customAct?: SchedulerAct) => this.#inner.waitNext(count, customAct);
  readonly waitIdle = (customAct?: SchedulerAct) => this.#inner.waitIdle(customAct);
  readonly waitFor = <T>(task: Promise<T>, customAct?: SchedulerAct) => this.#inner.waitFor(task, customAct);
  readonly report = () => this.#inner.report();
  toString(): string {
    return String(this.#inner);
  }
  /** 승인 응답의 원장 쓰기가 커밋될 때까지(상한 10초) */
  async #respondWritten(): Promise<void> {
    const s = this.#system();
    const end = Date.now() + 10_000;
    for (;;) {
      const status = (await s.paymentDb().pool.query<{ status: string }>('select status from payment where order_id = $1', [s.orderIdOf(this.#order)])).rows[0]?.status;
      if (status !== undefined && status !== 'ACCEPTED') return;
      if (Date.now() > end) throw new Error(`R3 감싸개: 주문 ${this.#order}의 승인 응답 쓰기가 10초 안에 커밋되지 않았다(원장 ${status})`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}

test('V-T40 R3 집중 경합(차례 고정): 승인 응답의 쓰기가 끝난 뒤에 재시작의 시작 문을 푸는 스케줄러 차례도 직렬 결과(APPROVED, 재시작 1)이고 같은 허용 집합 판정을 통과한다', async () => {
  const seen = await focusedPair(ONE, RESPOND_RESTART_SETUP, { a: 'respond', o: 1, p: 1 }, { a: 'restart' }, (s) => `${s.obs.pay['1,1']}/${s.obs.env.restarts}`, 4, {
    wrap: (sch, system) => new RestartAfterRespondWrite(sch, system, 1),
  });
  console.info(`R3 응답 쓰기 뒤 재시작(차례 고정): ${JSON.stringify(seen)}`);
  // 빈 시험 막기: 감싸개가 실제로 차례를 정했다(4판 모두 응답 먼저의 직렬 결과, docs/features/payment.md §2 '답 반영(한 트랜잭션)' 뒤 재시작 한 번)
  expect(seen).toEqual({ 'APPROVED/1': 4 });
  judgeRespondRestart(Object.fromEntries(Object.entries(seen).map(([k, n]) => [k.slice(0, k.indexOf('/')), n])));
}, PROPERTY_TIMEOUT_MS);

// ---- 집중 시험(무작위가 드물게 닿는 갈래를 바로 만든다) ----
test('V-T40 집중: 승인 응답 시간 초과 뒤 결제사가 늦게 승인해도 결과를 가정하지 않고(UNKNOWN) 조회로 승인을 확정한다(명세 ⑤)', async () => {
  const s = await make(ONE);
  await using(s, async () => {
    await run(s, [...upToSent(1), { a: 'timeout', o: 1, p: 1 }]);
    expect(s.obs.pay['1,1']).toBe('UNKNOWN');
    await run(s, [{ a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'query', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }]);
    expect(s.obs.ord[1]!.st).toBe('APPROVED');
  });
}, 60_000);

test('V-T40 집중: payment-svc 재시작으로 기다리던 승인 호출이 끊기면 다시 뜬 실행기가 결과 모름으로 두고, 결제사가 거절한 결제는 조회로 실패가 되며 주문은 과금 없이 끝난다', async () => {
  const s = await make(ONE);
  await using(s, async () => {
    await run(s, [...upToSent(1), { a: 'restart' }]);
    expect(s.obs.pay['1,1']).toBe('UNKNOWN');
    expect(s.obs.req['1,1']).toBe(true);
    await run(s, [{ a: 'pgProcess', o: 1, p: 1, c: 'DECLINED' }, { a: 'query', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }]);
    expect(s.obs.ord[1]!.st).toBe('FAILED');
    expect(s.obs.pgs['1,1']).toBe('DECLINED');
  });
}, 60_000);

test('V-T40 집중(상한): 채널 동시 호출 상한(1)이 찬 동안 다른 주문의 승인 명령은 실행기를 돌려도 보내지 않고 결제 원장·작업 행이 그대로이며, 자리가 나면 같은 멱등키로 보낸다(코드 리뷰 H3)', async () => {
  const s = await make(PROPOSED, { bulkhead: 1 });
  await using(s, async () => {
    await run(s, [...upToSent(1), { a: 'newAttempt', o: 2 }, { a: 'auth', o: 2, k: 1 }, { a: 'accept', o: 2, k: 1 }, { a: 'reserve', o: 2, c: 'RESERVED' }, { a: 'command', o: 2 }]);
    expect(s.sendRoom(1)).toBe(false);
    await s.blockedSend(2, 1);
    expect(s.blockedSends).toBe(1);
    expect(s.obs.pay['2,1']).toBe('ACCEPTED');
    await run(s, [{ a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'respond', o: 1, p: 1 }]);
    expect(s.sendRoom(1)).toBe(true);
    await run(s, [{ a: 'send', o: 2, p: 1 }, { a: 'pgProcess', o: 2, p: 1, c: 'APPROVED' }, { a: 'respond', o: 2, p: 1 }]);
    expect([s.obs.pay['1,1'], s.obs.pay['2,1']]).toEqual(['APPROVED', 'APPROVED']);
  });
}, 60_000);

test('V-T40 집중(임대): 옛 파드가 승인 명령을 잡은 채 멈춘 사이 새 실행기가 넘겨받아 보내면, 옛 파드의 늦은 쓰기(보냄 표시·다시 미룸·놓기·지우기)는 모두 임대 소유자 조건에 막힌다(코드 리뷰 M8)', async () => {
  const s = await make(ONE);
  await using(s, async () => {
    await run(s, [{ a: 'newAttempt', o: 1 }, { a: 'auth', o: 1, k: 1 }, { a: 'accept', o: 1, k: 1 }, { a: 'reserve', o: 1, c: 'RESERVED' }, { a: 'command', o: 1 }]);
    expect(await s.staleOwnerWrites(1, 1)).toEqual({ markSent: 'LEASE_LOST', reschedule: false, release: false, drop: false, owner: s.runnerPod(), sent: true });
    await run(s, [{ a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'respond', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }]);
    expect(s.obs.ord[1]!.st).toBe('APPROVED');
  });
}, 60_000);

test('V-T40 집중: 결과 모름인 동안 결제사가 전액 취소하면 조회와 대사의 닫기로 CANCELED가 되고 주문은 과금 없이 실패로 끝난다(pgCancel)', async () => {
  const s = await make(ONE);
  await using(s, async () => {
    await run(s, [...upToSent(1), { a: 'timeout', o: 1, p: 1 }, { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'pgCancel', o: 1, p: 1 }, { a: 'query', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }]);
    expect(s.obs.pay['1,1']).toBe('CANCELED');
    expect(s.obs.ord[1]!.st).toBe('FAILED');
  });
}, 60_000);

test('V-T40 집중: 토스형으로 접수한 뒤 전환을 켜도 승인 명령·호출·조회는 접수한 결제사로만 간다(명세 ②), 전환 뒤 새 시도는 포트원형이다', async () => {
  const s = await make(PROPOSED);
  await using(s, async () => {
    await run(s, [{ a: 'newAttempt', o: 1 }, { a: 'auth', o: 1, k: 1 }, { a: 'accept', o: 1, k: 1 }, { a: 'toggleSwitch' }, { a: 'newAttempt', o: 2 }, { a: 'reserve', o: 1, c: 'RESERVED' }, { a: 'command', o: 1 }, { a: 'send', o: 1, p: 1 }, { a: 'timeout', o: 1, p: 1 }, { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'query', o: 1, p: 1 }]);
    expect(s.obs.att['2,1']).toEqual({ pg: 2, st: 'READY' });
    expect(s.obs.pay['1,1']).toBe('APPROVED');
    expect(s.obs.pay['1,2']).toBe('NONE');
    expect(s.obs.ghost.offPg).toBe(false);
  });
}, 60_000);

test('V-T40 집중: 발권이 끝내 안 되는 주문은 기한 넘김 → CS 확인 → 보상(발권 막기 → 결제사 취소)으로 끝나고, 늦게 온 발권 성공 답은 주문을 바꾸지 않는다(명세 ⑥)', async () => {
  const s = await make(ONE);
  await using(s, async () => {
    const statusOf = async (table: 'purchase_order' | 'order_compensation'): Promise<string | undefined> => {
      const column = table === 'purchase_order' ? 'id' : 'order_id';
      return (await s.purchaseDb().pool.query<{ status: string }>(`select status from ${table} where ${column} = $1`, [s.orderIdOf(1)])).rows[0]?.status;
    };
    await run(s, [
      ...upToSent(1),
      { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' },
      { a: 'respond', o: 1, p: 1 },
      { a: 'applyResult', o: 1, p: 1 },
      { a: 'issue', o: 1 },
      { a: 'issueAck', o: 1 },
      { a: 'overdue', o: 1 },
      { a: 'csConfirm', o: 1 },
      { a: 'issue', o: 1 },
    ]);
    expect(s.obs.ord[1]).toMatchObject({ st: 'APPROVED', job: true });
    // compStart: 운영 주문은 APPROVED로 두고 order_compensation만 STARTED다(ADR-0354 결정 3). 하네스는 그 표로 COMPENSATING을 관측한다
    await run(s, [{ a: 'compStart', o: 1 }]);
    expect(s.obs.ord[1]).toMatchObject({ st: 'COMPENSATING', job: false });
    expect(await statusOf('purchase_order')).toBe('APPROVED');
    expect(await statusOf('order_compensation')).toBe('STARTED');
    // compFence: 발권을 막아도 결제 취소 전이라 주문은 APPROVED, 보상 행만 FENCED다
    await run(s, [{ a: 'ticketSvc', o: 1, c: 'OK' }, { a: 'compFence', o: 1 }]);
    expect(s.obs.ord[1]).toMatchObject({ st: 'COMPENSATING', job: false });
    expect(await statusOf('purchase_order')).toBe('APPROVED');
    expect(await statusOf('order_compensation')).toBe('FENCED');
    // compCancel: 결제 취소가 끝난 뒤 T20으로 주문과 보상 행이 함께 COMPENSATED다
    await run(s, [{ a: 'issueAck', o: 1 }, { a: 'compCancel', o: 1 }]);
    expect(s.obs.ord[1]!.st).toBe('COMPENSATED');
    expect(await statusOf('purchase_order')).toBe('COMPENSATED');
    expect(await statusOf('order_compensation')).toBe('COMPENSATED');
    expect(s.obs.tks[1]!.tk).toBe('REVOKED');
    expect(s.obs.pgs['1,1']).toBe('CANCELED');
    expect(s.obs.pay['1,1']).toBe('CANCELED');
    // 드문 동작 도달 단언(맨 끝 시험)이 이 집중 시험의 셈을 본다
    expect([s.counts.compStart, s.counts.compFence, s.counts.compCancel]).toEqual([1, 1, 1]);
  });
}, 60_000);

test('V-T40 집중(회차 취소 환불): 발권 완료 주문은 회차 취소 확정 뒤 환불(T24)로 끝나고 티켓은 폐기, 결제사 쪽은 취소다(명세 eventRefund, ④)', async () => {
  const s = await make(ONE);
  await using(s, async () => {
    await run(s, [...upToSent(1), { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'respond', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }, { a: 'issue', o: 1 }, { a: 'ticketSvc', o: 1, c: 'OK' }, { a: 'issueAck', o: 1 }, { a: 'eventCancel' }, { a: 'eventRefund', o: 1 }]);
    expect(s.obs.ord[1]!.st).toBe('REFUNDED');
    expect(s.obs.tks[1]!.tk).toBe('REVOKED');
    expect([s.obs.pgs['1,1'], s.obs.pay['1,1']]).toEqual(['CANCELED', 'CANCELED']);
    expect(s.counts.eventRefund).toBe(1);
  });
}, 60_000);

test('V-T40 집중(접수 뒤 기한 지남): 승인 명령을 접수한 뒤 기한이 지나면 실행기가 결제사를 부르지 않고 결제를 실패로 끝내고, 주문은 과금 없이 실패한다(명세 expireCommand)', async () => {
  const s = await make(ONE);
  await using(s, async () => {
    await run(s, [{ a: 'newAttempt', o: 1 }, { a: 'auth', o: 1, k: 1 }, { a: 'accept', o: 1, k: 1 }, { a: 'reserve', o: 1, c: 'RESERVED' }, { a: 'command', o: 1 }, { a: 'deadlinePasses', o: 1 }, { a: 'expireCommand', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }]);
    expect(s.obs.pay['1,1']).toBe('FAILED');
    expect(s.obs.req['1,1']).toBe(false);
    expect(s.obs.ord[1]!.st).toBe('FAILED');
    expect(s.counts.expireCommand).toBe(1);
  });
}, 60_000);

test('V-T40 집중(발권 불가): ticket-svc가 그 주문을 끝내 발권하지 못하면(ticketBreaks) 발권 실패는 다시 보내기로 남고 주문은 승인 상태다(명세 ④·⑥의 앞 단계)', async () => {
  const s = await make(ONE);
  await using(s, async () => {
    await run(s, [...upToSent(1), { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'respond', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }, { a: 'ticketBreaks', o: 1 }, { a: 'issue', o: 1 }, { a: 'ticketSvc', o: 1, c: 'OK' }, { a: 'issueAck', o: 1 }]);
    expect(s.obs.ord[1]).toMatchObject({ st: 'APPROVED', job: true });
    expect(s.obs.tks[1]).toMatchObject({ tk: 'NONE', broken: true });
    expect(s.counts.ticketBreaks).toBe(1);
  });
}, 60_000);

test('V-T40 집중(웹훅): 서명 없는 \'승인됨\' 웹훅의 처리 길이 조회 신호 → 중복 → 조회 신호 건너뜀 차례이고 결제 원장을 바꾸지 않으며, 포트원 경로의 서명 없음·틀림은 거절, 토스 경로로 온 포트원 고정 주문은 결제사 불일치다(명세 ③, 코드 리뷰 M5)', async () => {
  const receiverOf = (s: PaymentSystem, outcomes: string[]) =>
    new ReceivePaymentWebhook({ store: new DrizzleWebhookStore({ database: s.paymentDb() }), gateways: s.gateways(), log: new Proxy({}, { get: () => () => undefined }) as never, signals: { outcome: (_pg, o) => outcomes.push(o) }, clock: s.clock, allowSimulator: true });
  const tossBody = (s: PaymentSystem, paymentKey: string) => Buffer.from(JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: new Date(s.clock.now()).toISOString(), data: { paymentKey, orderId: s.orderIdOf(1), status: 'DONE' } }));

  const s = await make(ONE);
  await using(s, async () => {
    await run(s, [...upToSent(1), { a: 'timeout', o: 1, p: 1 }]);
    const outcomes: string[] = [];
    const receiver = receiverOf(s, outcomes);
    const forged = (id: string) => receiver.receive('toss', { 'tosspayments-webhook-transmission-id': id }, tossBody(s, s.authOf(1, 1)!.paymentKey!));
    const answers: string[] = [];
    await s.noChange('웹훅 승인됨(서명 없음)', async () => answers.push(await forged('wh-1')));
    await s.noChange('같은 웹훅 다시', async () => answers.push(await forged('wh-1')));
    await s.noChange('다른 웹훅(조회가 이미 때가 됨)', async () => answers.push(await forged('wh-2')));
    expect(outcomes).toEqual(['query_signal', 'duplicate', 'query_signal_skipped']);
    await run(s, [{ a: 'pgProcess', o: 1, p: 1, c: 'DECLINED' }]);
    await s.noChange('늦게 온 옛 웹훅', async () => answers.push(await forged('wh-0')));
    expect(answers).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
    // 포트원 경로: 서명이 없거나 틀리면 거절(본문을 읽지 않는다)
    const portone = (headers: Record<string, string>) => receiver.receive('portone', headers, Buffer.from(JSON.stringify({ type: 'Transaction.Paid', timestamp: new Date().toISOString(), data: { paymentId: `pay-${s.orderIdOf(1)}` } })));
    const before = outcomes.length;
    await s.noChange('포트원 서명 없음', async () => answers.push(await portone({})));
    await s.noChange('포트원 서명 틀림', async () => answers.push(await portone({ 'webhook-id': 'wh-p1', 'webhook-timestamp': String(Math.floor(s.clock.now() / 1000)), 'webhook-signature': 'v1,AAAA' })));
    expect(answers.slice(-2)).toEqual(['REJECTED', 'REJECTED']);
    expect(outcomes.slice(before)).toEqual(['invalid', 'invalid']);
    expect(s.obs.pay['1,1']).toBe('UNKNOWN');
    await run(s, [{ a: 'query', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }]);
    expect(s.obs.ord[1]!.st).toBe('FAILED');
    expect(s.obs.tks[1]!.tk).toBe('NONE');
  });

  // 포트원으로 고정한 주문의 웹훅이 토스 경로로 오면 결제사 불일치(조회를 부르지 않는다)
  const p = await make(ONE);
  await using(p, async () => {
    await run(p, [{ a: 'toggleSwitch' }, ...upToSent(1, 2), { a: 'timeout', o: 1, p: 2 }]);
    const outcomes: string[] = [];
    await p.noChange('토스 경로의 포트원 주문 웹훅', async () => receiverOf(p, outcomes).receive('toss', { 'tosspayments-webhook-transmission-id': 'wh-x' }, tossBody(p, `pay-${p.orderIdOf(1)}`)));
    expect(outcomes).toEqual(['pg_mismatch']);
  });
}, 60_000);

test('V-T40 집중(멱등): 같은 주문의 승인 명령을 다른 결제사·다른 금액·다른 시도 ID로 다시 보내면 거절되고 결제 원장은 접수한 결제사의 한 건이다(명세 ①·② ONE_PAYMENT_PER_ORDER)', async () => {
  const s = await make(ONE);
  await using(s, async () => {
    await run(s, [{ a: 'newAttempt', o: 1 }, { a: 'auth', o: 1, k: 1 }, { a: 'accept', o: 1, k: 1 }, { a: 'reserve', o: 1, c: 'RESERVED' }, { a: 'command', o: 1 }]);
    expect(await s.resendCommand(1, 'PORTONE')).toBe('PaymentCommandMismatchError');
    expect(await s.resendCommand(1, 'SIMULATOR', { amount: 9_999 })).toBe('PaymentCommandMismatchError');
    expect(await s.resendCommand(1, 'SIMULATOR', { attemptId: '0195f3a0-0000-7000-8000-0000000000ab' })).toBe('PaymentCommandMismatchError');
    expect(await s.resendCommand(1, 'SIMULATOR')).toBe('REPLAYED');
    expect((await s.paymentDb().pool.query('select pg, amount from payment where order_id = $1', [s.orderIdOf(1)])).rows).toEqual([{ pg: 'SIMULATOR', amount: 10000 }]);
  });
}, 60_000);

// ---- 맨 끝: 실행 전체의 도달 단언(앞 시험이 돈 때만) ----
test('V-T40 무작위 실행이 정본 범위에서 고를 수 있는 동작마다 1번 이상 돌았다(코드 리뷰 M1)', (ctx) => {
  if (totals.runs === 0) ctx.skip();
  const counts = { ...totals.counts };
  for (const [k, n] of Object.entries(contention.counts)) counts[k] = (counts[k] ?? 0) + n;
  expect(SPEC_ACTIONS.filter((a) => !NOT_IN_CANON.has(a) && !(RARE_IN_RANDOM as readonly string[]).includes(a) && !(counts[a]! > 0))).toEqual([]);
  console.info(`무작위의 드문 동작(단언하지 않음): ${JSON.stringify(Object.fromEntries(RARE_IN_RANDOM.map((a) => [a, counts[a] ?? 0])))}`);
  // 이름만이 아니라 승인 기한 갈래(T8 EXPIRED의 판매 예약, T11의 승인 명령)도 지났다(코드 리뷰)
  console.info(`기한 갈래: ${JSON.stringify(lateBranches)}`);
  expect(lateBranches.reserve).toBeGreaterThan(0);
  expect(lateBranches.command).toBeGreaterThan(0);
});

test('V-T40 무작위에서 드문 동작은 결정적 시험(집중과 재생)이 운영 코드나 흉내로 1번 이상 돌렸다(머리 주석의 목록)', (ctx) => {
  if (replayed === 0 || Object.keys(focusedCounts).length === 0) ctx.skip();
  console.info(`드문 동작의 결정적 시험: 집중 ${JSON.stringify(Object.fromEntries(RARE_IN_RANDOM.map((a) => [a, focusedCounts[a] ?? 0])))}, 재생 ${JSON.stringify(Object.fromEntries(RARE_IN_RANDOM.map((a) => [a, replayCounts[a] ?? 0])))}`);
  expect(RARE_IN_RANDOM.filter((a) => !(focusedCounts[a]! > 0))).toEqual([]);
  expect(RARE_IN_RANDOM.filter((a) => !(replayCounts[a]! > 0))).toEqual([]);
});

test('V-T40 경합 쌍 종류마다 1번 이상 돌았다(무작위 경합과 집중 경합, 코드 리뷰 H5)', (ctx) => {
  if (contention.runs === 0) ctx.skip();
  expect(PAIRS.map(([a, b]) => `${a} ∥ ${b}`).filter((k) => !(pairKinds[k]! > 0))).toEqual([]);
});

afterAll(() => {
  console.info(`재생: 끝까지 ${replayed}개(기록 ${manifest.files.length}개)`);
  console.info(`무작위: 실행 ${totals.runs}번, 걸음 ${totals.steps}개(실행마다 평균 ${(totals.steps / Math.max(1, totals.runs)).toFixed(1)}), ${(totals.ms / 1000).toFixed(1)}초, 상한 찬 send ${totals.blockedSends}번`);
  console.info(`걸음별: ${JSON.stringify(totals.counts)}`);
  console.info(`결과 반영 길: ${JSON.stringify(paths)}`);
  console.info(`경합: 실행 ${contention.runs}번, 걸음 ${contention.steps}개(경합 걸음 ${contention.pairs}개, 그 가운데 한 걸음이 진 것 ${contention.lost}개), ${(contention.ms / 1000).toFixed(1)}초`);
  console.info(`경합 쌍별: ${JSON.stringify(pairKinds)}`);
});
