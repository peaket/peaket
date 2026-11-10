// 명세 동작 기록(ITF) 재생(wbs 2.7.6, docs/verification.md §2.4, V-T40 ③, BUILD_ORDER PRF-210). tools/spec-check traces가 `quint run --mbt`로 낸 기록의 걸음마다
// 고른 동작(mbt::actionTaken)과 nondet 값(mbt::nondetPicks: o·p·k·b)을 같은 이름의 하네스 동작으로 운영 코드에 다시 돌리고, 걸음마다 명세의 다음 상태와 견준다.
// 좌석 하네스 seat-model/itf.ts와 같은 꼴이다. 다른 점:
// - 안에 `any`(갈래)가 있는 동작(reserve·pgProcess·ticketSvc)은 quint가 이름을 남기지 않고(빈 글), 안쪽 도움 동작(keepOrderSide)을 부르는 동작은 그 이름을 남긴다.
//   그런 걸음은 명세가 허락하고 다음 상태가 기록과 같은 동작으로 정한다(inferAction, 코드 리뷰 H2).
// - 갈래(choice)는 기록의 다음 상태에서 읽는다(choiceOf): 판매 예약 성공·실패, 결제사 승인·거절, 발권 성공·실패.
import { readFileSync } from 'node:fs';
import { SPEC_ACTIONS, type SpecAction } from './actions.js';
import { compareState, enabled, type MState, PGS, po, type Scope, specNext, type SpecMove } from './spec.js';

type Itf = unknown;
/** ITF 값을 JS 값으로: 정수 → number, 집합 → 정렬한 배열, 맵 → [열쇠, 값] 배열, 튜플 → 배열 */
export function decode(v: Itf): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#bigint' in o) return Number(o['#bigint']);
    if ('#set' in o) return (o['#set'] as Itf[]).map(decode);
    if ('#map' in o) return (o['#map'] as Itf[][]).map(([k, x]) => [decode(k), decode(x)]);
    if ('#tup' in o) return (o['#tup'] as Itf[]).map(decode);
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== '#meta').map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

export interface SpecStep {
  /** 기록의 동작 이름(빈 글이면 inferAction이 정한다) */
  action: string;
  picks: { o?: number; p?: number; k?: number; b?: string };
  state: MState;
}

const keyOf = (k: unknown) => (Array.isArray(k) ? k.join(',') : String(k));
const recOf = <V>(pairs: unknown): Record<string, V> => Object.fromEntries((pairs as Array<[unknown, V]>).map(([k, v]) => [keyOf(k), v]));

/** 기록 파일 하나: 모듈 이름과 걸음별 상태 */
export function readTrace(file: string): { module: string; steps: SpecStep[] } {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { vars: string[]; states: Array<Record<string, Itf>> };
  const prefix = raw.vars.find((v) => v.endsWith('::ord'))!.slice(0, -'ord'.length);
  const module = prefix.split('::')[0]!;
  const steps = raw.states.map((s) => {
    const picks = Object.fromEntries(
      Object.entries(s['mbt::nondetPicks'] as Record<string, { tag: string; value: Itf }>).map(([k, o]) => [k, o.tag === 'Some' ? decode(o.value) : undefined]),
    ) as SpecStep['picks'];
    const v = (name: string) => decode(s[`${prefix}${name}`]);
    return {
      action: s['mbt::actionTaken'] as string,
      picks,
      state: {
        ord: recOf(v('ord')),
        att: recOf(v('att')),
        pgs: recOf(v('pgs')),
        req: recOf(v('req')),
        pay: recOf(v('pay')),
        late: recOf(v('late')),
        tks: recOf(v('tks')),
        env: v('env'),
        ghost: v('ghost'),
      } as MState,
    };
  });
  return { module, steps };
}

/**
 * 명세 파일의 검사 모듈 import 줄에서 범위 상수를 읽는다. 운영 코드에 있는 설계 장치(PG_PINNED·ONE_PAYMENT_PER_ORDER·NO_ASSUME·WEBHOOK_QUERY·FORWARD_RECOVERY·
 * ISSUE_RETRY·CS_PATH·ACK_CONDITIONAL)를 끈 모듈은 운영 코드로 재생할 수 없어 던진다(변형 모듈은 명세 검사가 반례로 본다)
 */
export function scopeOf(spec: string, module: string): Scope {
  const m = new RegExp(`module\\s+${module}\\s*\\{\\s*import\\s+payment\\(([\\s\\S]*?)\\)\\.\\*`).exec(spec);
  if (!m) throw new Error(`명세에 모듈 ${module}가 없다`);
  const v = (name: string) => {
    const x = new RegExp(`\\b${name}\\s*=\\s*(Set\\([^)]*\\)|true|false|\\d+)`).exec(m[1]!);
    if (!x) throw new Error(`${module}: ${name}가 없다`);
    return x[1]!;
  };
  for (const d of ['PG_PINNED', 'ONE_PAYMENT_PER_ORDER', 'NO_ASSUME', 'WEBHOOK_QUERY', 'FORWARD_RECOVERY', 'ISSUE_RETRY', 'CS_PATH', 'ACK_CONDITIONAL']) {
    if (v(d) !== 'true') throw new Error(`${module}: ${d} = false인 변형은 운영 코드에 그 장치가 있어 재생하지 않는다`);
  }
  return {
    orders: [...v('ORDERS').matchAll(/\d+/g)].map((x) => Number(x[0])),
    maxAttempts: Number(v('MAX_ATTEMPTS')),
    maxSwitches: Number(v('MAX_SWITCHES')),
    maxTimeouts: Number(v('MAX_TIMEOUTS')),
    maxRestarts: Number(v('MAX_RESTARTS')),
    maxWebhooks: Number(v('MAX_WEBHOOKS')),
    eventCancel: v('EVENT_CANCEL') === 'true',
    ticketBreak: v('TICKET_BREAK') === 'true',
    issueFence: v('ISSUE_FENCE') === 'true',
  };
}

/** 갈래가 있는 동작의 갈래 값 */
const CHOICES: Partial<Record<SpecAction, readonly string[]>> = { reserve: ['RESERVED', 'FAILED'], pgProcess: ['APPROVED', 'DECLINED'], ticketSvc: ['OK', 'ERR'] };

/**
 * 이름이 없거나(안에 갈래 `any`가 있는 동작) 명세 동작이 아닌 이름(안쪽 도움 동작 `keepOrderSide` 등, quint가 마지막으로 부른 동작 이름을 남긴다)인 걸음의
 * 동작을 정한다: 그 걸음의 nondet 값(o·p·k·b)으로 만든 동작 가운데 명세가 앞 상태에서 허락하고 다음 상태가 기록과 같은 것(코드 리뷰 H2).
 * 둘 이상이면 SPEC_ACTIONS 차례로 첫 것이다(같은 다음 상태라 재생 대조는 같다)
 */
export function inferAction(sc: Scope, pre: MState, post: MState, picks: SpecStep['picks']): SpecAction {
  for (const a of SPEC_ACTIONS) {
    for (const c of CHOICES[a] ?? [undefined]) {
      const m: SpecMove = { a, ...picks, ...(c === undefined ? {} : { c }) };
      if (enabled(sc, pre, m) && compareState(sc, specNext(sc, pre, m), post).length === 0) return a;
    }
  }
  throw new Error(`이름 없는 걸음의 동작을 정하지 못했다(nondet ${JSON.stringify(picks)}, 범위 주문 ${sc.orders.join(',')})`);
}

/** 기록의 다음 상태에서 갈래를 읽는다 */
export function choiceOf(a: SpecAction, pre: MState, post: MState, picks: SpecStep['picks']): string | undefined {
  const o = picks.o!;
  const p = picks.p!;
  if (a === 'reserve') return post.ord[o]!.st;
  if (a === 'pgProcess') return pre.pgs[po(p, o)] === 'AUTH' ? post.pgs[po(p, o)] : undefined;
  if (a === 'ticketSvc') {
    const t = pre.tks[o]!;
    if (t.closed || t.broken) return 'ERR';
    if (t.wait === 'WAIT') return post.tks[o]!.wait;
    return post.tks[o]!.tk === 'ISSUED' && t.tk === 'NONE' ? 'OK' : 'ERR';
  }
  return undefined;
}

/** 기록의 걸음 i(1부터) → 하네스 걸음 */
export function moveOf(sc: Scope, steps: SpecStep[], i: number): SpecMove {
  const pre = steps[i - 1]!.state;
  const post = steps[i]!.state;
  const picks = steps[i]!.picks;
  const named = steps[i]!.action;
  const a = (SPEC_ACTIONS as readonly string[]).includes(named) ? (named as SpecAction) : inferAction(sc, pre, post, picks);
  const c = choiceOf(a, pre, post, picks);
  return { a, ...picks, ...(c === undefined ? {} : { c }) };
}

/** 재생 대상: 걸음 하나를 하고(앞 상태는 대상이 안다) 지금 관측을 명세 상태 꼴로 준다. 알려진 차이는 known에 남긴다 */
export interface ReplayTarget {
  move(m: SpecMove): Promise<void>;
  modelState(): MState;
  readonly known: ReadonlyArray<{ step: number; kind: string; msg: string; explains: string[] }>;
  readonly steps: number;
  readonly violations: readonly string[];
}

export interface ReplayOutcome {
  steps: number;
  replayed: number;
  mismatch: string | null;
  /** 알려진 차이(system.ts KNOWN)만으로 어긋나 멈췄으면 그 내용(그 뒤 걸음은 재생하지 않는다) */
  known: string | null;
}

/** 기록 하나를 재생한다: 걸음마다 기록의 다음 상태와 대상의 관측을 칸마다 견주고, 그 걸음에 난 알려진 차이가 설명하는 칸만 뺀다 */
export async function replay(sc: Scope, t: ReplayTarget, steps: SpecStep[]): Promise<ReplayOutcome> {
  for (let i = 1; i < steps.length; i++) {
    const m = moveOf(sc, steps, i);
    await t.move(m);
    const here = t.known.filter((k) => k.step === t.steps);
    const explained = new Set(here.flatMap((k) => k.explains));
    const d = compareState(sc, steps[i]!.state, t.modelState());
    const rest = d.filter((x) => !explained.has(x.key));
    const where = `걸음 ${i} ${m.a} ${JSON.stringify({ o: m.o, p: m.p, k: m.k, c: m.c })}`;
    if (rest.length > 0) return { steps: steps.length - 1, replayed: i - 1, mismatch: `${where}: ${rest.map((x) => x.msg).join('; ')}`, known: null };
    if (d.length > 0) return { steps: steps.length - 1, replayed: i, mismatch: null, known: `${where}: ${here.map((x) => `${x.kind} ${x.msg}`).join('; ')}(뒤 걸음은 재생하지 않는다)` };
  }
  return { steps: steps.length - 1, replayed: steps.length - 1, mismatch: null, known: null };
}

/** 명세 옮김만 재생하는 대상(spec.ts specNext): 걸음마다 기록의 다음 상태와 같은지 본다(V-T40 ③ 옮김 검사) */
export class SpecOnly implements ReplayTarget {
  readonly known: Array<{ step: number; kind: string; msg: string; explains: string[] }> = [];
  readonly violations: string[] = [];
  steps = 0;
  constructor(
    readonly sc: Scope,
    private s: MState,
  ) {}
  async move(m: SpecMove): Promise<void> {
    this.s = specNext(this.sc, this.s, m);
    this.steps += 1;
  }
  modelState(): MState {
    return structuredClone(this.s);
  }
}
