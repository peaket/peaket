// 대기열·입장 제어 모델 기반 시험의 명령(wbs 2.3.4, docs/verification.md §2.4). 명세 specs/queue.qnt의 동작마다 명령 하나이고 이름이 같다.
// check는 명세의 '할 수 있음'을 관측한 탭 상태로 따르고(구현이 아무것도 바꾸지 않을 걸음은 조금 넓게 둔다), run은 하네스(system.ts)로 운영 코드를 부른 뒤
// 불변식 위반이 있으면 실패한다. COMMANDS의 열쇠가 명세 이름 목록(SpecAction)과 같아야 형식 검사를 통과한다(빠지거나 더한 이름은 컴파일 오류).
import fc from 'fast-check';
import type { SpecAction } from './actions.js';
import { debug, type K, type QueueSystem, type Scope } from './system.js';

export interface World {
  s: QueueSystem;
}

export class Act implements fc.AsyncCommand<World, World> {
  constructor(
    readonly name: SpecAction,
    readonly label: string,
    private readonly ok: (s: QueueSystem) => boolean,
    private readonly go: (s: QueueSystem) => Promise<void>,
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

const tk = (sc: Scope) => fc.constantFrom(...sc.tickets);
const pp = (sc: Scope) => fc.constantFrom(...new Set(sc.tickets.map((k) => k[0])));
const cc = (sc: Scope) => fc.constantFrom(...sc.ctrls);
const at = (s: QueueSystem, k: K, ...phases: string[]) => phases.includes(s.tab(k).phase);
const failovers = (s: QueueSystem) => s.env.evFailovers + s.env.psFailovers;
/** 걸음 하나(쓰기일 수 있음): 하네스가 복제 사본을 맞춘다 */
const write = (name: SpecAction, label: string, ok: (s: QueueSystem) => boolean, f: (s: QueueSystem) => Promise<unknown>) =>
  new Act(name, label, ok, (s) => s.step(label, async () => void (await f(s))));
/** 쓰기가 아닌 걸음 */
const meta = (name: SpecAction, label: string, ok: (s: QueueSystem) => boolean, f: (s: QueueSystem) => unknown) =>
  new Act(name, label, ok, async (s) => {
    await f(s);
    s.note(label);
  });

export const COMMANDS: Record<SpecAction, (sc: Scope) => fc.Arbitrary<Act>> = {
  enterPreempt: (sc) => tk(sc).map((k) => write('enterPreempt', `enterPreempt(${k})`, (s) => at(s, k, 'IDLE'), (s) => s.enterPreempt(k))),
  pendingExpires: (sc) =>
    pp(sc).map((p) =>
      write('pendingExpires', `pendingExpires(${p})`, (s) => sc.tickets.some((k) => k[0] === p && at(s, k, 'PREEMPTED', 'NUMBERED', 'SADDED')), (s) => s.pendingExpires(p)),
    ),
  enterNumber: (sc) => tk(sc).map((k) => write('enterNumber', `enterNumber(${k})`, (s) => at(s, k, 'PREEMPTED'), (s) => s.enterNumber(k))),
  enterRecord: (sc) => tk(sc).map((k) => write('enterRecord', `enterRecord(${k})`, (s) => at(s, k, 'NUMBERED'), (s) => s.enterRecord(k))),
  enterBatchRecord: (sc) => tk(sc).map((k) => write('enterBatchRecord', `enterBatchRecord(${k})`, (s) => at(s, k, 'SADDED'), (s) => s.enterBatchRecord(k))),
  batchMissing: (sc) =>
    tk(sc).map((k) => write('batchMissing', `batchMissing(${k})`, (s) => at(s, k, 'BATCHED') && s.published() && !s.isMember(k), (s) => s.batchMissing(k))),
  leave: (sc) => tk(sc).map((k) => write('leave', `leave(${k})`, (s) => at(s, k, 'HELD'), (s) => s.leave(k))),
  windowEnds: () => fc.constant(meta('windowEnds', 'windowEnds', (s) => s.env.windowOpen, (s) => s.windowEnds())),
  publishBatch: () => fc.constant(write('publishBatch', 'publishBatch', (s) => s.publishable(), (s) => s.publishBatch())),
  takeBatchResult: (sc) =>
    tk(sc).map((k) => write('takeBatchResult', `takeBatchResult(${k})`, (s) => at(s, k, 'BATCHED') && s.published() && s.isMember(k), (s) => s.takeBatchResult(k))),
  acquire: (sc) =>
    cc(sc).map((c) =>
      meta('acquire', `acquire(${c})`, (s) => s.ctl.holder !== c && s.ctl.c.get(c)!.op === 'NONE' && s.ctl.acquisitions <= sc.maxLeaderChanges, (s) => s.acquire(c)),
    ),
  plan: (sc) =>
    fc.tuple(cc(sc), fc.constantFrom('ADVANCE' as const, 'CLOSE' as const)).map(([c, op]) =>
      meta(
        'plan',
        `plan(${c}, ${op})`,
        (s) =>
          s.ctl.holder === c &&
          s.ctl.c.get(c)!.op === 'NONE' &&
          (op === 'ADVANCE' ? s.counters().seq > s.counters().serving : sc.openBatch && !s.env.windowOpen && !s.closed()),
        (s) => s.plan(c, op),
      ),
    ),
  applyWrite: (sc) => cc(sc).map((c) => write('applyWrite', `applyWrite(${c})`, (s) => s.ctl.c.get(c)!.op !== 'NONE', (s) => s.applyWrite(c))),
  replicateEv: () => fc.constant(meta('replicateEv', 'replicateEv', (s) => s.pending.length > 0, (s) => s.replicateEv())),
  // 복제본과 같으면 명세에서 할 수 없는 걸음이라 아무것도 남기지 않는다(check가 동기라 run에서 본다)
  replicatePerson: (sc) =>
    pp(sc).map(
      (p) =>
        new Act('replicatePerson', `replicatePerson(${p})`, () => true, async (s) => {
          if (!(await s.personDiffers(p))) return;
          await s.replicatePerson(p);
          s.note(`replicatePerson(${p})`);
        }),
    ),
  failoverEv: (sc) =>
    fc.constantFrom(...sc.epochJumps).map((j) =>
      meta('failoverEv', `failoverEv(${j})`, (s) => failovers(s) < sc.maxFailovers && s.pending.length > 0, (s) => s.failoverEv(j)),
    ),
  failoverPerson: (sc) =>
    pp(sc).map(
      (p) =>
        new Act('failoverPerson', `failoverPerson(${p})`, (s) => sc.personFailovers && failovers(s) < sc.maxFailovers, async (s) => {
          if (!(await s.personDiffers(p))) return;
          await s.failoverPerson(p);
          s.note(`failoverPerson(${p})`);
        }),
    ),
  rb05: () => fc.constant(write('rb05', 'rb05', (s) => !s.markerMine(), (s) => s.rb05())),
  rb05Confirm: () => fc.constant(write('rb05Confirm', 'rb05Confirm', (s) => s.markerMine() && s.rb05Pending() && s.pending.length === 0, (s) => s.rb05Confirm())),
  // 경합: 같은 대기표의 요청을 셋까지 함께 보내고(copies), 지금 목표를 0에서 시작해 요청 사이 아무 때나 올린다(raiseAfter, 곧 입장과 자리 잡기가 엇갈림)
  admit: (sc) =>
    fc.tuple(tk(sc), fc.integer({ min: 1, max: 3 }), fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined })).map(([k, copies, raiseAfter]) =>
      write(
        'admit',
        `admit(${k}${copies > 1 ? ` ×${copies}` : ''}${raiseAfter === undefined ? '' : ` 목표 경합 ${raiseAfter}`})`,
        (s) => !sc.admitSteps && at(s, k, 'HELD'),
        (s) => s.admit(k, { copies, ...(raiseAfter === undefined ? {} : { raiseAfter }) }),
      ),
    ),
  admitCheck: (sc) => tk(sc).map((k) => write('admitCheck', `admitCheck(${k})`, (s) => sc.admitSteps && at(s, k, 'HELD'), (s) => s.admitCheck(k))),
  admitClaim: (sc) => tk(sc).map((k) => write('admitClaim', `admitClaim(${k})`, (s) => at(s, k, 'CHECKED'), (s) => s.admitClaim(k))),
  admitSlot: (sc) =>
    fc.tuple(tk(sc), fc.boolean()).map(([k, ok]) => write('admitSlot', `admitSlot(${k}, ${ok})`, (s) => at(s, k, 'CLAIMED'), (s) => s.admitSlot(k, ok))),
  admitSettle: (sc) => tk(sc).map((k) => write('admitSettle', `admitSettle(${k})`, (s) => at(s, k, 'SLOTTED'), (s) => s.admitSettle(k))),
  admitRelease: (sc) => tk(sc).map((k) => write('admitRelease', `admitRelease(${k})`, (s) => at(s, k, 'RELEASING'), (s) => s.admitRelease(k))),
};

/** 명령 모음과 고르는 무게: 진입·입장·리더 쓰기는 자주, 묶음 구간 끝은 드물게(묶음이 모일 틈을 둔다), 나머지는 보통 */
export function commandArbs(sc: Scope): Array<{ arbitrary: fc.Arbitrary<Act>; weight: number }> {
  const often = new Set<SpecAction>(['enterPreempt', 'enterNumber', 'enterRecord', 'enterBatchRecord', 'takeBatchResult', 'admit', 'admitCheck', 'admitClaim', 'admitSlot', 'admitSettle', 'admitRelease', 'plan', 'applyWrite', 'publishBatch']);
  return (Object.keys(COMMANDS) as SpecAction[]).map((n) => ({ arbitrary: COMMANDS[n](sc), weight: n === 'windowEnds' ? 1 : often.has(n) ? 12 : 4 }));
}
