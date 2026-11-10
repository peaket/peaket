// 결제 모델 기반 시험의 명령(wbs 2.7.6, docs/verification.md §2.4, BUILD_ORDER PRF-210). 명세 specs/payment.qnt의 동작마다 명령 하나이고 이름이 같다.
// check는 명세의 '할 수 있음'(spec.ts enabled)을 마지막 걸음 뒤 관측(PaymentSystem.obs)으로 따르고, run은 하네스(system.ts)로 운영 코드를 부른 뒤 불변식 위반이나
// 명세 다음 상태와 다른 것이 있으면 실패한다. COMMANDS의 열쇠가 명세 이름 목록(SpecAction)과 같아야 한다(빠지거나 더한 이름은 컴파일 오류).
// send는 채널 동시 승인 호출 상한(명세가 뺀 채널 상한·재시도 큐 대기)이 하네스 셈으로 차 있으면 명세 걸음 대신 blockedSend로 실행기를 돌려
// '보내지 않음·결제 원장 그대로'를 본다(상한 판정이 보호기와 다르면 위반, 코드 리뷰 H3). 승인 기한이 지난 reserve·command는 명세가 실패 갈래만 두므로 그대로 고른다(코드 리뷰 H1).
import fc from 'fast-check';
import type { SpecAction } from './actions.js';
import { enabled, PGS, type Scope, type SpecMove } from './spec.js';
import { debug, labelOf, type PaymentSystem } from './system.js';

export interface World {
  s: PaymentSystem;
}

export class Act implements fc.AsyncCommand<World, World> {
  constructor(
    readonly move: SpecMove,
    private readonly ok: (s: PaymentSystem) => boolean,
  ) {}
  check(m: Readonly<World>): boolean {
    return enabled(m.s.scope, m.s.obs, this.move) && this.ok(m.s);
  }
  async run(_m: World, r: World): Promise<void> {
    try {
      if (this.move.a === 'send' && !r.s.sendRoom(this.move.p!)) await r.s.blockedSend(this.move.o!, this.move.p!);
      else await r.s.move(this.move);
    } catch (e) {
      debug(`${r.s.eventId} 오류 ${this.toString()}: ${(e as Error).stack}`);
      throw e;
    }
    if (r.s.violations.length > 0) throw new Error(`불변식 위반:\n${r.s.violations.join('\n')}`);
  }
  toString(): string {
    const m = this.move;
    return `${m.a}(${[m.o, m.p, m.k, m.c].filter((x) => x !== undefined).join(', ')})`;
  }
}

const oo = (sc: Scope) => fc.constantFrom(...sc.orders);
const pp = () => fc.constantFrom(...PGS);
const kk = (sc: Scope) => fc.integer({ min: 1, max: sc.maxAttempts });
const always = () => true;
const byO = (a: SpecAction, ok: (s: PaymentSystem, m: SpecMove) => boolean = always) => (sc: Scope) => oo(sc).map((o) => new Act({ a, o }, (s) => ok(s, { a, o })));
const byOP = (a: SpecAction, ok: (s: PaymentSystem, m: SpecMove) => boolean = always) => (sc: Scope) => fc.tuple(oo(sc), pp()).map(([o, p]) => new Act({ a, o, p }, (s) => ok(s, { a, o, p })));
const byOK = (a: SpecAction) => (sc: Scope) => fc.tuple(oo(sc), kk(sc)).map(([o, k]) => new Act({ a, o, k }, always));
const plain = (a: SpecAction) => () => fc.constant(new Act({ a }, always));
/** 갈래를 무게대로 고른다(끝으로 가는 갈래를 덜 골라 깊은 걸음에 닿게) */
const weighted = (...xs: Array<[string, number]>) => fc.oneof(...xs.map(([v, weight]) => ({ arbitrary: fc.constant(v), weight })));

export const COMMANDS: Record<SpecAction, (sc: Scope) => fc.Arbitrary<Act>> = {
  newAttempt: byO('newAttempt'),
  auth: byOK('auth'),
  accept: byOK('accept'),
  expireAttempt: byOK('expireAttempt'),
  expireOrder: byO('expireOrder'),
  reserve: (sc) => fc.tuple(oo(sc), weighted(['RESERVED', 4], ['FAILED', 1])).map(([o, c]) => new Act({ a: 'reserve', o, c }, always)),
  command: byO('command'),
  send: byOP('send'),
  expireCommand: byOP('expireCommand'),
  pgProcess: (sc) => fc.tuple(oo(sc), pp(), weighted(['APPROVED', 3], ['DECLINED', 1])).map(([o, p, c]) => new Act({ a: 'pgProcess', o, p, c }, always)),
  pgExpire: byOP('pgExpire'),
  pgCancel: byOP('pgCancel'),
  respond: byOP('respond'),
  timeout: byOP('timeout'),
  query: byOP('query'),
  webhook: (sc) => fc.tuple(oo(sc), pp(), fc.constantFrom('APPROVED', 'FAILED')).map(([o, p, b]) => new Act({ a: 'webhook', o, p, b }, always)),
  deadlinePasses: byO('deadlinePasses'),
  applyResult: byOP('applyResult'),
  issue: byO('issue'),
  ticketSvc: (sc) => fc.tuple(oo(sc), weighted(['OK', 3], ['ERR', 1])).map(([o, c]) => new Act({ a: 'ticketSvc', o, c }, always)),
  issueAck: byO('issueAck'),
  ticketBreaks: byO('ticketBreaks'),
  overdue: byO('overdue'),
  csConfirm: byO('csConfirm'),
  compStart: byO('compStart'),
  compFence: byO('compFence'),
  compCancel: byO('compCancel'),
  eventRefund: byO('eventRefund'),
  restart: plain('restart'),
  eventCancel: plain('eventCancel'),
  toggleSwitch: plain('toggleSwitch'),
};

// ---- 경합 쌍(fc.scheduler, docs/verification.md §2.4, BUILD_ORDER PRF-210) ----
/** 함께 돌릴 걸음 쌍: 같은 행을 두고 다투거나(접수 ∥ 새 시도, 늦은 발권 답 ∥ 보상 시작, 응답 ∥ 재시작 등) 서로 다른 주문의 행을 함께 쓰는 것 */
export const PAIRS: ReadonlyArray<readonly [SpecAction, SpecAction]> = [
  ['applyResult', 'expireOrder'],
  ['respond', 'restart'],
  ['query', 'respond'],
  ['issueAck', 'compStart'],
  ['accept', 'newAttempt'],
  ['toggleSwitch', 'accept'],
  ['toggleSwitch', 'newAttempt'],
  ['expireOrder', 'newAttempt'],
];
/** 걸음마다 고르는 칸(경합 쌍에 드는 걸음만) */
const PARAMS: Partial<Record<SpecAction, ReadonlyArray<'o' | 'p' | 'k'>>> = {
  applyResult: ['o', 'p'],
  expireOrder: ['o'],
  respond: ['o', 'p'],
  restart: [],
  query: ['o', 'p'],
  issueAck: ['o'],
  compStart: ['o'],
  accept: ['o', 'k'],
  newAttempt: ['o'],
  toggleSwitch: [],
};
function movesOf(sc: Scope, a: SpecAction): SpecMove[] {
  let out: SpecMove[] = [{ a }];
  const ks = Array.from({ length: sc.maxAttempts }, (_, i) => i + 1);
  for (const f of PARAMS[a] ?? []) out = out.flatMap((m) => (f === 'o' ? sc.orders : f === 'p' ? PGS : ks).map((v) => ({ ...m, [f]: v })));
  return out;
}

/** 경합 쌍 하나: 지금 명세가 둘 다 허락하는 칸 조합 가운데 i번째(나머지로)를 PaymentSystem.pair로 함께 돌린다 */
export class PairAct implements fc.AsyncCommand<World, World> {
  #label: string;
  constructor(
    readonly kinds: readonly [SpecAction, SpecAction],
    readonly i: number,
  ) {
    this.#label = `경합(${kinds[0]} ∥ ${kinds[1]})`;
  }
  #cands(s: PaymentSystem): Array<[SpecMove, SpecMove]> {
    const xs = movesOf(s.scope, this.kinds[0]).filter((m) => enabled(s.scope, s.obs, m));
    const ys = movesOf(s.scope, this.kinds[1]).filter((m) => enabled(s.scope, s.obs, m));
    return xs.flatMap((x) => ys.filter((y) => JSON.stringify(x) !== JSON.stringify(y)).map((y): [SpecMove, SpecMove] => [x, y]));
  }
  check(m: Readonly<World>): boolean {
    return this.#cands(m.s).length > 0;
  }
  async run(_m: World, r: World): Promise<void> {
    const c = this.#cands(r.s);
    const [a, b] = c[this.i % c.length]!;
    this.#label = `경합(${labelOf(a)} ∥ ${labelOf(b)})`;
    try {
      await r.s.pair(a, b);
    } catch (e) {
      debug(`${r.s.eventId} 오류 ${this.#label}: ${(e as Error).stack}`);
      throw e;
    }
    if (r.s.violations.length > 0) throw new Error(`불변식 위반:\n${r.s.violations.join('\n')}`);
  }
  toString(): string {
    return this.#label;
  }
}
export const pairArb = (): fc.Arbitrary<PairAct> => fc.tuple(fc.constantFrom(...PAIRS), fc.nat()).map(([k, i]) => new PairAct(k, i));

/**
 * 명령 모음과 고르는 무게: 사람·Saga·결제사·발권 걸음은 자주, 시간 흐름·장애·환경과 주문을 끝내는 걸음(만료·보상 시작)은 드물게(그래야 승인·발권·보상까지 깊이 닿는다).
 * weights로 이름마다 바꾼다
 */
export function commandArbs(sc: Scope, weights: Partial<Record<SpecAction, number>> = {}): Array<{ arbitrary: fc.Arbitrary<Act>; weight: number }> {
  const rare = new Set<SpecAction>(['eventCancel', 'toggleSwitch', 'expireOrder', 'expireAttempt', 'pgExpire', 'compStart', 'deadlinePasses']);
  // 할 수 있는 창이 좁은 걸음은 무게를 올린다(기록된 실행에서 csConfirm이 0번이었다, 코드 리뷰 M1)
  const narrow = new Set<SpecAction>(['csConfirm', 'pgCancel', 'timeout', 'restart', 'overdue', 'ticketBreaks', 'expireCommand']);
  // 승인 응답은 시간 초과·재시작과 겨루어 늘 밀리면 발권 완료·회차 취소 환불(eventRefund)까지 닿지 않는다: 무게를 더 준다
  const often = new Set<SpecAction>(['respond']);
  const all = (Object.keys(COMMANDS) as SpecAction[]).map((n) => ({ arbitrary: COMMANDS[n](sc), weight: weights[n] ?? (rare.has(n) ? 1 : narrow.has(n) ? 6 : often.has(n) ? 20 : 10) }));
  // 판매 예약 뒤 승인 명령 전의 기한 지남(그 뒤 승인 명령이 T11로 끝난다)은 따로 무게를 준다. 승인 기한 지남 전체의 무게를 올리면 흐름이 일찍 끝나 승인·보상·환불에 닿지 않는다(코드 리뷰)
  const lateAfterReserve = oo(sc).map((o) => new Act({ a: 'deadlinePasses', o }, (s) => s.obs.ord[o]?.st === 'RESERVED' && PGS.every((p) => s.obs.pay[`${o},${p}`] === 'NONE')));
  return weights.deadlinePasses === undefined ? [...all, { arbitrary: lateAfterReserve, weight: 2 }] : all;
}
