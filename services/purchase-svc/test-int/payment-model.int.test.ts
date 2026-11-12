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
// 횟수와 시간(CI 기본, 코드 리뷰 M12): MBT_RUNS(기본 16, 범위마다. 경합은 그 반), MBT_TIME_LIMIT_MS(기본 45초, 속성 하나의 시간 한도. 넘으면 그때까지 돈 것으로 끝낸다).
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
import fc from 'fast-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migratePayment } from '../../payment-svc/scripts/migrate.mjs';
import { DrizzleWebhookStore } from '../../payment-svc/src/modules/payment/adapters/db/drizzle-webhook-store.js';
import { ReceivePaymentWebhook } from '../../payment-svc/src/modules/payment/application/receive-payment-webhook.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { SPEC_ACTIONS } from './payment-model/actions.js';
import { commandArbs, PAIRS, pairArb, type World } from './payment-model/commands.js';
import { readTrace, replay, scopeOf } from './payment-model/itf.js';
import type { Scope, SpecMove } from './payment-model/spec.js';
import { PaymentSystem, seededRandom, type SystemOptions } from './payment-model/system.js';
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

const make = async (scope: Scope, o: SystemOptions = {}) => {
  const s = new PaymentSystem(purchase, payment, fakeClock({ now: Date.now() }), scope, o);
  systems.push(s);
  await s.init();
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
  await fc.assert(
    fc.asyncProperty(fc.array(fc.oneof(...commandArbs(scope)), { minLength: 600, maxLength: 1000 }), fc.constantFrom<number | undefined>(undefined, 1, 2), fc.nat(), async (cmds, bulkhead, seed) => {
      const started = Date.now();
      const w: World = { s: await make(scope, { random: seededRandom(seed), ...(bulkhead === undefined ? {} : { bulkhead }) }) };
      randomSystems.add(w.s);
      await using(w.s, async () => {
        try {
          await fc.asyncModelRun(() => ({ model: w, real: w }), cmds);
        } finally {
          tally(totals, w.s, started);
        }
      });
    }),
    { numRuns: RUNS, ...replayParams },
  );
}, PROPERTY_TIMEOUT_MS);

// ---- 경합(fc.scheduler): 운영 코드의 DB 문 차례를 스케줄러가 섞고, 두 걸음을 함께 돌린 결과가 어느 한 차례와 같아야 한다 ----
const contention = { runs: 0, steps: 0, ms: 0, counts: {} as Record<string, number>, blockedSends: 0, pairs: 0, lost: 0 };
test.each(VARIANTS)('V-T40 경합(fc.scheduler, %s): 함께 돌린 두 걸음의 결과가 어느 한 차례의 명세 다음 상태와 같고 불변식이 지켜진다', async (_name, scope) => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.array(fc.oneof({ arbitrary: pairArb(), weight: 40 }, ...commandArbs(scope)), { minLength: 300, maxLength: 500 }), fc.constantFrom<number | undefined>(undefined, 1), fc.nat(), async (sch, cmds, bulkhead, seed) => {
      const started = Date.now();
      const w: World = { s: await make(scope, { scheduler: sch, random: seededRandom(seed), ...(bulkhead === undefined ? {} : { bulkhead }) }) };
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
    }),
    { numRuns: CONTENTION_RUNS, ...replayParams },
  );
}, PROPERTY_TIMEOUT_MS);

/** 집중 경합 하나: setup으로 상태를 만든 뒤 쌍을 돌리고 결과 이름을 센다 */
async function focusedPair(scope: Scope, setup: SpecMove[], a: SpecMove, b: SpecMove, outcome: (s: PaymentSystem) => string, runs: number, order: { serial?: boolean } = {}): Promise<Record<string, number>> {
  const seen: Record<string, number> = {};
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), async (sch) => {
      const s = await make(scope, { scheduler: sch });
      await using(s, async () => {
        await run(s, setup);
        await s.pair(a, b, order);
        for (const [k, n] of Object.entries(s.pairKinds)) pairKinds[k] = (pairKinds[k] ?? 0) + n;
        const o = outcome(s);
        seen[o] = (seen[o] ?? 0) + 1;
      });
    }),
    { numRuns: runs, ...replayParams },
  );
  return seen;
}

test('V-T40 집중 경합: 늦게 온 발권 성공 답과 보상 시작이 겹쳐도 결과는 어느 한 차례와 같고, 두 갈래(성공 반영이 먼저면 CONFIRMED, 보상이 먼저면 보상 중)가 모두 나온다(명세 ⑥)', async () => {
  const setup: SpecMove[] = [...upToSent(1), { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }, { a: 'respond', o: 1, p: 1 }, { a: 'applyResult', o: 1, p: 1 }, { a: 'overdue', o: 1 }, { a: 'csConfirm', o: 1 }, { a: 'issue', o: 1 }, { a: 'ticketSvc', o: 1, c: 'OK' }];
  const seen = await focusedPair(ONE, setup, { a: 'issueAck', o: 1 }, { a: 'compStart', o: 1 }, (s) => s.obs.ord[1]!.st, 16);
  console.info(`발권 답 ∥ 보상 시작: ${JSON.stringify(seen)}`);
  expect(Object.keys(seen).sort()).toEqual(['COMPENSATING', 'CONFIRMED']);
}, PROPERTY_TIMEOUT_MS);

test('V-T40 집중 경합: 접수 ∥ 새 결제 시도가 겹쳐도 결과는 어느 한 차례와 같고, 두 갈래(접수가 먼저면 ACCEPTED, 새 시도가 먼저면 앞 시도 대체)가 모두 나온다(코드 리뷰 H5)', async () => {
  const seen = await focusedPair(ATTEMPTS, [{ a: 'newAttempt', o: 1 }, { a: 'auth', o: 1, k: 1 }], { a: 'accept', o: 1, k: 1 }, { a: 'newAttempt', o: 1 }, (s) => `${s.obs.ord[1]!.st}/${s.obs.att['1,1']!.st}`, 12);
  console.info(`접수 ∥ 새 시도: ${JSON.stringify(seen)}`);
  expect(Object.keys(seen).sort()).toEqual(['ACCEPTED/ACCEPTED', 'CREATED/SUPERSEDED']);
}, PROPERTY_TIMEOUT_MS);

test('V-T40 집중 경합: 승인 응답 ∥ payment-svc 재시작이 겹치면 재시작이 쓰기를 막아 결과 모름이 되고, 응답이 먼저 끝나면(차례를 정함) 승인이 남고 재시작은 잃을 호출이 없다(두 갈래, 코드 리뷰 H5)', async () => {
  const setup: SpecMove[] = [...upToSent(1), { a: 'pgProcess', o: 1, p: 1, c: 'APPROVED' }];
  const raced = await focusedPair(ONE, setup, { a: 'respond', o: 1, p: 1 }, { a: 'restart' }, (s) => s.obs.pay['1,1']!, 8);
  // 스케줄러 차례에서는 재시작의 DB 끊기가 응답의 쓰기보다 늘 먼저 와서(쓰기는 문을 여러 개 지난다) 응답이 이기는 갈래가 나오지 않는다. 그 갈래는 차례를 정해 바로 만든다
  const serial = await focusedPair(ONE, setup, { a: 'respond', o: 1, p: 1 }, { a: 'restart' }, (s) => `${s.obs.pay['1,1']}/${s.obs.env.restarts}`, 2, { serial: true });
  console.info(`응답 ∥ 재시작: ${JSON.stringify(raced)}, 응답 먼저(차례 정함): ${JSON.stringify(serial)}`);
  expect(Object.keys(raced)).toEqual(['UNKNOWN']);
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
      { a: 'compStart', o: 1 },
      { a: 'ticketSvc', o: 1, c: 'OK' },
      { a: 'compFence', o: 1 },
      { a: 'issueAck', o: 1 },
      { a: 'compCancel', o: 1 },
    ]);
    expect(s.obs.ord[1]!.st).toBe('COMPENSATED');
    expect(s.obs.tks[1]!.tk).toBe('REVOKED');
    expect(s.obs.pgs['1,1']).toBe('CANCELED');
    expect(s.obs.pay['1,1']).toBe('CANCELED');
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
