// 좌석 홀드·판매 확정 모델 기반 시험의 명령(wbs 2.5.5, docs/verification.md §2.4, BUILD_ORDER PRF-151). 명세 specs/seat.qnt의 동작마다 명령 하나이고 이름이 같다.
// check는 명세의 '할 수 있음'을 마지막 걸음 뒤 관측(SeatSystem.obs)과 시도 상태로 따르고(동기), run은 하네스(system.ts)로 운영 코드를 부른 뒤 불변식 위반이나
// 명세가 내다본 결과와 다른 것이 있으면 실패한다. COMMANDS의 열쇠가 명세 이름 목록(SpecAction)과 같아야 한다(빠지거나 더한 이름은 컴파일 오류).
import fc from 'fast-check';
import type { SpecAction } from './actions.js';
import { debug, hidOf, type Scope, type SeatSystem, settleAll } from './system.js';

export interface World {
  s: SeatSystem;
}

export class Act implements fc.AsyncCommand<World, World> {
  constructor(
    readonly name: SpecAction,
    public label: string,
    private readonly ok: (s: SeatSystem) => boolean,
    private readonly go: (s: SeatSystem) => Promise<void>,
  ) {}
  check(m: Readonly<World>): boolean {
    return this.ok(m.s);
  }
  async run(_m: World, r: World): Promise<void> {
    try {
      await this.go(r.s);
    } catch (e) {
      debug(`${r.s.eventId} 오류 ${this.label}: ${(e as Error).stack}`);
      throw e;
    }
    if (r.s.violations.length > 0) throw new Error(`불변식 위반:\n${r.s.violations.join('\n')}`);
  }
  toString(): string {
    return this.label;
  }
}

const hh = (sc: Scope) => fc.constantFrom(...sc.attempts.map(hidOf));
const ll = (sc: Scope) => fc.constantFrom(...sc.requests);
const is = (s: SeatSystem, h: number, ...phases: string[]) => phases.includes(s.att(h).phase);
const ready = (s: SeatSystem) => s.obs.red.ready;
const repDiffers = (s: SeatSystem) => !s.sameRed(s.obs.rep, s.obs.red);

/** 시도의 걸음(쓰기일 수 있음): 하네스가 복제 사본을 맞춘다 */
const attempt = (name: SpecAction, sc: Scope, ok: (s: SeatSystem, h: number) => boolean, f: (s: SeatSystem, h: number) => Promise<unknown>) =>
  hh(sc).map((h) => new Act(name, `${name}(${h})`, (s) => ok(s, h), (s) => s.step(`${name}(${h})`, () => f(s, h), undefined, { a: name, h })));
/** 명세 시도 걸음의 '할 수 있음'(경합 쌍도 쓴다) */
export const ENABLED: Partial<Record<SpecAction, (s: SeatSystem, h: number) => boolean>> = {
  ttlPasses: (s, h) => {
    const a = s.att(h);
    return (
      a.seats.length > 0 &&
      !a.late &&
      a.phase !== 'SOLD' &&
      (s.holding(h) || (!ready(s) && s.relayed.has(h))) &&
      !a.seats.some((x) => s.obs.red.seats[x]!.hid === h && s.obs.red.seats[x]!.pinned)
    );
  },
  expire: (s, h) => ready(s) && s.att(h).late && s.mine(h, false).length > 0,
  accept: (s, h) => is(s, h, 'HELD') && ready(s),
  pin: (s, h) => is(s, h, 'ACCEPTED') && ready(s),
  saleStep: (s, h) => is(s, h, 'PINNED') && s.att(h).ins < s.att(h).seats.length && !s.blocked(h),
  approve: (s, h) => is(s, h, 'RESERVED'),
  decline: (s, h) => is(s, h, 'RESERVED'),
  releaseFailed: (s, h) => s.scope.failRelease && is(s, h, 'FAILED') && ready(s) && s.holding(h),
};
/** 시도 걸음 하나를 부른다(경합 쌍도 쓴다) */
export const RUN: Partial<Record<SpecAction, (s: SeatSystem, h: number) => Promise<unknown>>> = {
  ttlPasses: (s, h) => s.ttlPasses(h),
  expire: (s, h) => s.expire(h),
  accept: (s, h) => s.accept(h),
  pin: (s, h) => s.pin(h),
  saleStep: (s, h) => s.saleStep(h),
  approve: (s, h) => s.approve(h),
  decline: (s, h) => s.decline(h),
  releaseFailed: (s, h) => s.releaseFailed(h),
};
const simple = (name: SpecAction) => (sc: Scope) => attempt(name, sc, ENABLED[name]!, RUN[name]!);

export const COMMANDS: Record<SpecAction, (sc: Scope) => fc.Arbitrary<Act>> = {
  hold: (sc) =>
    fc.tuple(hh(sc), ll(sc)).map(
      ([h, l]) =>
        new Act('hold', `hold(${h}, [${l}])`, (s) => is(s, h, 'IDLE') && ready(s), (s) => s.step(`hold(${h}, [${l}])`, () => s.hold(h, l), undefined, { a: 'hold', h, l })),
    ),
  ttlPasses: simple('ttlPasses'),
  expire: simple('expire'),
  accept: simple('accept'),
  pin: simple('pin'),
  saleStep: simple('saleStep'),
  approve: simple('approve'),
  decline: simple('decline'),
  releaseFailed: simple('releaseFailed'),
  relay: (sc) => attempt('relay', sc, (s, h) => sc.fullLoss && !s.relayed.has(h) && s.holding(h), (s, h) => s.relay(h)),
  replicate: () =>
    fc.constant(
      new Act('replicate', 'replicate', repDiffers, async (s) => {
        const pre = s.modelState();
        s.replicate();
        await s.note('replicate', pre, { a: 'replicate' });
      }),
    ),
  promote: (sc) =>
    fc.constant(
      new Act('promote', 'promote', (s) => sc.promote && s.failovers() < sc.maxFailovers && repDiffers(s), async (s) => {
        const pre = s.modelState();
        await s.promote();
        await s.note('promote', pre, { a: 'promote' });
      }),
    ),
  loseAll: (sc) =>
    fc.constant(
      new Act('loseAll', 'loseAll', (s) => sc.fullLoss && s.failovers() < sc.maxFailovers, async (s) => {
        const pre = s.modelState();
        await s.loseAll();
        await s.note('loseAll', pre, { a: 'loseAll' });
      }),
    ),
  rebuild: () => fc.constant(new Act('rebuild', 'rebuild', (s) => !ready(s), (s) => s.step('rebuild', () => s.rebuild(), undefined, { a: 'rebuild' }))),
};

/** 명령 모음과 고르는 무게: 사람·Saga·시스템 걸음은 자주, 장애(승격·전체 유실)는 드물게(범위가 한 번만 허락한다), 시각 흐름과 복제는 보통. weights로 이름마다 바꾼다 */
export function commandArbs(sc: Scope, weights: Partial<Record<SpecAction, number>> = {}): Array<{ arbitrary: fc.Arbitrary<Act>; weight: number }> {
  const rare = new Set<SpecAction>(['promote', 'loseAll']);
  const mid = new Set<SpecAction>(['ttlPasses', 'replicate', 'decline']);
  return (Object.keys(COMMANDS) as SpecAction[]).map((n) => ({ arbitrary: COMMANDS[n](sc), weight: weights[n] ?? (rare.has(n) ? 1 : mid.has(n) ? 4 : 10) }));
}

/** 경합 쌍에 넣는 시도 걸음(복제·장애·다시 만들기·적재는 빼고, 같은 시도의 걸음 둘은 함께 돌리지 않는다) */
const PAIRABLE: SpecAction[] = ['ttlPasses', 'expire', 'accept', 'pin', 'saleStep', 'approve', 'decline', 'releaseFailed'];

interface Cand {
  n: SpecAction;
  h: number;
}
/** 지금 할 수 있는 시도 걸음 목록(홀드 포함, 같은 시도의 걸음이 여럿일 수 있다) */
function candidates(s: SeatSystem): Cand[] {
  const out: Cand[] = [];
  for (const h of s.hids()) {
    if (is(s, h, 'IDLE') && ready(s)) out.push({ n: 'hold', h });
    for (const n of PAIRABLE) if (ENABLED[n]!(s, h)) out.push({ n, h });
  }
  return out;
}

/**
 * 무작위 경합: 지금 할 수 있는 시도 걸음 가운데 서로 다른 두 시도의 걸음(홀드 포함)을 미리 뽑은 수로 골라 함께 돌린다. check는 서로 다른 시도의 걸음이
 * 둘 이상 있는지만 본다. Redis·DB 호출을 보내는 차례는 스케줄러가 섞는다. 앞 상태로 결과를 내다볼 수 없어 예측·명세 다음 상태 대조는 끄고 불변식과 일치만 본다
 */
export function pairArb(sc: Scope): fc.Arbitrary<Act> {
  return fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat(), fc.boolean()).map(([i, j, r1, r2, sales]) => {
    const act: Act = new Act(
      'hold',
      `경합 쌍(${i}, ${j})`,
      (s) => new Set(candidates(s).map((c) => c.h)).size >= 2,
      async (s) => {
        // 절반은 판매 예약 걸음끼리를 먼저 고른다(서로 다른 시도의 판매 예약이 둘 이상 있을 때): 두 트랜잭션이 같은 좌석·한도 행을 두고 겹치게
        const saleCands = candidates(s).filter((c) => c.n === 'saleStep');
        const list = sales && new Set(saleCands.map((c) => c.h)).size >= 2 ? saleCands : candidates(s);
        const first = list[i % list.length]!;
        const others = list.filter((c) => c.h !== first.h);
        const second = others[j % others.length]!;
        const reqs = [sc.requests[r1 % sc.requests.length]!, sc.requests[r2 % sc.requests.length]!];
        const show = (c: Cand, k: number) => `${c.n}(${c.h}${c.n === 'hold' ? `, [${reqs[k]}]` : ''})`;
        const go = (c: Cand, k: number) => (c.n === 'hold' ? s.hold(c.h, reqs[k]!) : RUN[c.n]!(s, c.h));
        act.label = `경합(${show(first, 0)} ∥ ${show(second, 1)})`;
        s.pairSteps += 1;
        if (first.n === 'saleStep' && second.n === 'saleStep') {
          s.pairSales += 1;
          const a1 = s.att(first.h).seats;
          if (Math.floor(first.h / 10) === Math.floor(second.h / 10) || s.att(second.h).seats.some((x) => a1.includes(x))) s.pairSalesOverlap += 1;
        }
        s.checking = false;
        try {
          await s.step(act.label, () => settleAll([go(first, 0), go(second, 1)]));
        } finally {
          s.checking = true;
        }
      },
    );
    return act;
  });
}
