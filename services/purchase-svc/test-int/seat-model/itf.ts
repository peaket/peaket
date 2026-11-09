// 명세 동작 기록(ITF) 재생(wbs 2.5.5, docs/verification.md §2.4, V-T40, BUILD_ORDER PRF-151). tools/spec-check traces가 `quint run --mbt`로 낸 기록의 걸음마다
// 고른 동작(mbt::actionTaken)과 nondet 값(mbt::nondetPicks: h·l)을 같은 이름의 하네스 동작으로 운영 코드에 다시 돌리고, 걸음마다 명세의 다음 상태와 견준다:
// 시도마다 단계·좌석·late·ins·판 번호, 좌석 Redis(주 노드·복제본)의 준비·판 번호·좌석(시도·묶음)·보유 수, purchase DB의 판매 행·한도 행·원장(HELD 적재)·판 번호,
// 낡은 판매 수. 검사 모듈의 범위는 명세 파일의 import 줄에서 읽는다(대기열 하네스 queue-model/itf.ts와 같은 꼴).
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { SpecAction } from './actions.js';
import { compareState, type MState, specNext, type SpecMove } from './spec.js';
import type { Att, Red, Scope, SeatSystem } from './system.js';

// ---- ITF 값 ----
type Itf = unknown;
/** ITF 값을 JS 값으로: 정수 → number, 집합 → 정렬한 배열, 맵 → [열쇠, 값] 배열, 튜플 → 배열 */
export function decode(v: Itf): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#bigint' in o) return Number(o['#bigint']);
    if ('#set' in o) {
      const xs = (o['#set'] as Itf[]).map(decode);
      return xs.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : JSON.stringify(a).localeCompare(JSON.stringify(b))));
    }
    if ('#map' in o) return (o['#map'] as Itf[][]).map(([k, x]) => [decode(k), decode(x)]);
    if ('#tup' in o) return (o['#tup'] as Itf[]).map(decode);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

type Pairs<V> = Array<[number, V]>;
interface SpecRed {
  ready: boolean;
  gen: number;
  counter: number;
  seats: Pairs<{ hid: number; pinned: boolean }>;
  quota: Pairs<number>;
}
interface SpecDb {
  sale: Pairs<number[]>;
  unc: Pairs<number>;
  used: Pairs<number>;
  ledger: number[];
  gen: number;
}
export interface SpecState {
  action: string;
  picks: Record<string, unknown>;
  atts: Map<number, Att>;
  red: SpecRed;
  redRep: SpecRed;
  db: SpecDb;
  env: { partials: number; fulls: number };
  ghost: { stale: number; newest: Array<[number, number]> };
}

/** 기록 파일 하나: 모듈 이름과 걸음별 상태 */
export function readTrace(file: string): { module: string; states: SpecState[] } {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { vars: string[]; states: Array<Record<string, Itf>> };
  const prefix = raw.vars.find((v) => v.endsWith('::red'))!.slice(0, -'red'.length);
  const module = prefix.split('::')[0]!;
  const states = raw.states.map((s) => {
    const picks = Object.fromEntries(
      Object.entries(s['mbt::nondetPicks'] as Record<string, { tag: string; value: Itf }>).map(([k, o]) => [k, o.tag === 'Some' ? decode(o.value) : undefined]),
    );
    return {
      action: s['mbt::actionTaken'] as string,
      picks,
      atts: new Map(decode(s[`${prefix}atts`]) as Array<[number, Att]>),
      red: decode(s[`${prefix}red`]) as SpecRed,
      redRep: decode(s[`${prefix}redRep`]) as SpecRed,
      db: decode(s[`${prefix}db`]) as SpecDb,
      env: decode(s[`${prefix}env`]) as SpecState['env'],
      ghost: decode(s[`${prefix}ghost`]) as SpecState['ghost'],
    };
  });
  return { module, states };
}

/**
 * 명세 파일의 검사 모듈 import 줄에서 범위 상수를 읽는다(목록 형 상수 REQUESTS 포함). 운영 코드에 있는 설계 장치(UNIQUE_INDEX·DB_QUOTA·SORTED_INSERT·READY_CHECK·
 * PIN_BEFORE_SALE·TOKEN_TIME_FLOOR)를 끈 모듈은 운영 코드로 재생할 수 없어 던진다
 */
export function scopeOf(spec: string, module: string): Scope {
  const m = new RegExp(`module\\s+${module}\\s*\\{\\s*import\\s+seat\\(([\\s\\S]*?)\\)\\.\\*`).exec(spec);
  if (!m) throw new Error(`명세에 모듈 ${module}가 없다`);
  const v = (name: string) => {
    const x = new RegExp(`\\b${name}\\s*=\\s*(Set\\((?:[^()]|\\([^()]*\\))*\\)|true|false|\\d+)`).exec(m[1]!);
    if (!x) throw new Error(`${module}: ${name}가 없다`);
    return x[1]!;
  };
  const ints = (s: string) => [...s.matchAll(/\d+/g)].map((x) => Number(x[0]));
  const pairs = (s: string) => [...s.matchAll(/\((\d+),\s*(\d+)\)/g)].map((x) => [Number(x[1]), Number(x[2])] as const);
  const lists = (s: string) => [...s.matchAll(/\[([^\]]*)\]/g)].map((x) => ints(x[1]!));
  for (const d of ['UNIQUE_INDEX', 'DB_QUOTA', 'SORTED_INSERT', 'READY_CHECK', 'PIN_BEFORE_SALE', 'TOKEN_TIME_FLOOR']) {
    if (v(d) !== 'true') throw new Error(`${module}: ${d} = false인 변형은 운영 코드에 그 장치가 있어 재생하지 않는다`);
  }
  return {
    people: ints(v('PEOPLE')),
    seats: ints(v('SEATS')),
    limit: Number(v('LIMIT')),
    attempts: pairs(v('ATTEMPTS')),
    requests: lists(v('REQUESTS')),
    maxFailovers: Number(v('MAX_FAILOVERS')),
    fullLoss: v('FULL_LOSS') === 'true',
    promote: v('PROMOTE') === 'true',
    failRelease: v('FAIL_RELEASE') === 'true',
  };
}

/** 걸음 하나를 하네스로. 명세가 이 걸음을 좌석 Redis 쓰기로 보는지(write)는 앞뒤 red로 정한다. 하네스도 앞 상태에서 명세 다음 상태(spec.ts)를 계산해 견준다 */
async function apply(s: SeatSystem, a: SpecAction, picks: Record<string, unknown>, pre: SpecState, post: SpecState): Promise<void> {
  const h = picks.h as number;
  const l = picks.l as number[];
  const write = !isDeepStrictEqual(pre.red, post.red);
  const label = a === 'hold' ? `hold(${h}, [${l}])` : h !== undefined ? `${a}(${h})` : a;
  const move: SpecMove = { a, ...(h !== undefined ? { h } : {}), ...(l !== undefined ? { l } : {}) };
  const step = (f: () => Promise<unknown>) => s.step(label, f, write, move);
  switch (a) {
    case 'hold':
      return step(() => s.hold(h, l));
    case 'ttlPasses':
      return step(() => s.ttlPasses(h));
    case 'expire':
      return step(() => s.expire(h));
    case 'accept':
      return step(() => s.accept(h));
    case 'pin':
      return step(() => s.pin(h));
    case 'saleStep':
      return step(() => s.saleStep(h));
    case 'approve':
      return step(() => s.approve(h));
    case 'decline':
      return step(() => s.decline(h));
    case 'releaseFailed':
      return step(() => s.releaseFailed(h));
    case 'relay':
      return step(() => s.relay(h));
    case 'rebuild':
      return step(() => s.rebuild());
  }
  const before = s.modelState();
  if (a === 'replicate') s.replicate();
  else if (a === 'promote') await s.promote();
  else if (a === 'loseAll') await s.loseAll();
  else throw new Error(`재생: 모르는 동작 ${String(a)}(명세에 동작을 더했으면 하네스와 명령도 더한다)`);
  await s.note(a, before, move);
}

/** 명세 Red → 하네스 Red 꼴(펜싱 카운터는 견주지 않는다) */
function redOfSpec(r: SpecRed): Red {
  return {
    ready: r.ready,
    gen: r.gen,
    seats: Object.fromEntries(r.seats.map(([x, v]) => [x, { hid: v.hid, pinned: v.pinned }])),
    quota: Object.fromEntries(r.quota),
  };
}

/** 기록의 한 상태 → 명세 상태(spec.ts MState) */
export function stateOf(st: SpecState): MState {
  return {
    red: redOfSpec(st.red),
    rep: redOfSpec(st.redRep),
    atts: new Map([...st.atts].map(([h, a]) => [h, { phase: a.phase, seats: a.seats, late: a.late, ins: a.ins, gen: a.gen }])),
    db: {
      sale: Object.fromEntries(st.db.sale),
      unc: Object.fromEntries(st.db.unc),
      used: Object.fromEntries(st.db.used),
      ledger: st.db.ledger,
      gen: st.db.gen,
    },
    env: st.env,
    ghost: { stale: st.ghost.stale, newest: Object.fromEntries(st.ghost.newest) },
  };
}

/** 명세 상태(spec.ts MState) → 기록의 한 상태 꼴(replay가 받는 모양). 펜싱 카운터는 견주지 않아 counter 그대로 둔다 */
function recordOf(m: MState, move: SpecMove, counter: number): SpecState {
  const pairs = <V>(r: Record<number, V>): Pairs<V> =>
    Object.entries(r)
      .map(([k, v]) => [Number(k), structuredClone(v)] as [number, V])
      .sort((a, b) => a[0] - b[0]);
  const red = (r: Red): SpecRed => ({ ready: r.ready, gen: r.gen, counter, seats: pairs(r.seats), quota: pairs(r.quota) });
  return {
    action: move.a,
    picks: { ...(move.h !== undefined ? { h: move.h } : {}), ...(move.l !== undefined ? { l: [...move.l] } : {}) },
    atts: structuredClone(m.atts),
    red: red(m.red),
    redRep: red(m.rep),
    db: { sale: pairs(m.db.sale), unc: pairs(m.db.unc), used: pairs(m.db.used), ledger: [...m.db.ledger], gen: m.db.gen },
    env: { ...m.env },
    ghost: { stale: m.ghost.stale, newest: pairs(m.ghost.newest) },
  };
}

/**
 * 기록의 첫 상태(quint init)에서 명세 다음 상태 계산(spec.ts specNext)으로 동작 차례 moves를 밟은 기록을 만든다(V-T40 ④, BUILD_ORDER PRF-165).
 * quint가 낸 기록(manifest)에 없는 걸음 차례를 재생기로 돌릴 때 쓴다. 동작의 '할 수 있음'은 보지 않는다(부르는 쪽이 명세에서 열리는 차례를 고른다)
 */
export function traceOfMoves(sc: Scope, init: SpecState, moves: readonly SpecMove[]): SpecState[] {
  const out: SpecState[] = [init];
  let m = stateOf(init);
  for (const move of moves) {
    m = specNext(sc, m, move);
    out.push(recordOf(m, move, init.red.counter));
  }
  return out;
}

export interface ReplayOutcome {
  steps: number;
  replayed: number;
  mismatch: string | null;
  /** 알려진 차이(system.ts KNOWN)만으로 어긋나 멈췄으면 그 내용(그 뒤 걸음은 재생하지 않는다) */
  known: string | null;
}

/**
 * 기록 하나를 재생한다. 걸음마다 기록의 다음 상태와 하네스 관측을 칸마다 견주고(spec.ts compareState), 그 걸음에 난 알려진 차이가 설명하는 칸만 뺀다.
 * 남은 어긋남이 있으면 그 걸음에서 멈추고 mismatch로 돌려준다. 알려진 차이로만 어긋났으면 known으로 멈춘다(불변식 위반은 하네스의 violations에 남는다)
 */
export async function replay(s: SeatSystem, states: SpecState[]): Promise<ReplayOutcome> {
  for (let i = 1; i < states.length; i++) {
    const pre = states[i - 1]!;
    const post = states[i]!;
    await apply(s, post.action as SpecAction, post.picks, pre, post);
    const here = s.known.filter((k) => k.step === s.log.length);
    const explained = new Set(here.flatMap((k) => k.explains));
    const d = compareState(s.scope, stateOf(post), s.modelState());
    const rest = d.filter((x) => !explained.has(x.key));
    const where = `걸음 ${i} ${post.action} ${JSON.stringify(post.picks)}`;
    if (rest.length > 0) return { steps: states.length - 1, replayed: i - 1, mismatch: `${where}: ${rest.map((x) => x.msg).join('; ')}`, known: null };
    if (d.length > 0) {
      const k = here.map((x) => `${x.kind} ${x.msg}`).join('; ');
      return { steps: states.length - 1, replayed: i, mismatch: null, known: `${where}: ${k}(뒤 걸음은 재생하지 않는다)` };
    }
  }
  return { steps: states.length - 1, replayed: states.length - 1, mismatch: null, known: null };
}
