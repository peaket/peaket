// 명세 동작 기록(ITF) 재생(wbs 2.3.4, docs/verification.md §2.4, V-T40). tools/spec-check traces가 `quint run --mbt`로 낸 기록의 걸음마다
// 고른 동작(mbt::actionTaken)과 nondet 값(mbt::nondetPicks)을 같은 이름의 하네스 동작으로 구현에 다시 돌리고, 걸음마다 명세의 다음 상태와 견준다:
// 탭마다 단계(대기표가 있으면 번호·세대), 회차 슬롯의 카운터·serving·세대·리더 세대. 검사 모듈의 범위는 명세 파일의 import 줄에서 읽는다.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { SpecAction } from './actions.js';
import type { K, QueueSystem, Scope } from './system.js';

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

interface SpecTab {
  phase: string;
  seq: number;
  gen: number;
}
interface SpecEv {
  seq: number;
  serving: number;
  leader: number;
  skips: unknown[];
  closed: boolean;
  first: number;
  size: number;
  bgen: number;
  pub: boolean;
  removed: number[];
  node: number;
}
interface SpecSlot {
  kind: string;
}
export interface SpecState {
  action: string;
  picks: Record<string, unknown>;
  tabs: Map<string, SpecTab>;
  ev: SpecEv;
  env: { primary: number };
  pss: Map<number, { dup: SpecSlot; adm: SpecSlot }>;
  ctl: { c: Array<[number, { gen: number; op: string }]> };
}

/** 기록 파일 하나: 모듈 이름과 걸음별 상태 */
export function readTrace(file: string): { module: string; states: SpecState[] } {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { vars: string[]; states: Array<Record<string, Itf>> };
  const prefix = raw.vars.find((v) => v.endsWith('::ev'))!.slice(0, -'ev'.length);
  const module = prefix.split('::')[0]!;
  const states = raw.states.map((s) => {
    const picks = Object.fromEntries(
      Object.entries(s['mbt::nondetPicks'] as Record<string, { tag: string; value: Itf }>).map(([k, o]) => [k, o.tag === 'Some' ? decode(o.value) : undefined]),
    );
    const tabs = new Map((decode(s[`${prefix}tabs`]) as Array<[[number, number], SpecTab]>).map(([k, t]) => [`${k[0]},${k[1]}`, t]));
    const pss = new Map(decode(s[`${prefix}pss`]) as Array<[number, { dup: SpecSlot; adm: SpecSlot }]>);
    return {
      action: s['mbt::actionTaken'] as string,
      picks,
      tabs,
      ev: decode(s[`${prefix}ev`]) as SpecEv,
      env: decode(s[`${prefix}env`]) as SpecState['env'],
      pss,
      ctl: decode(s[`${prefix}ctl`]) as SpecState['ctl'],
    };
  });
  return { module, states };
}

/** 명세 파일의 검사 모듈 import 줄에서 범위 상수를 읽는다 */
export function scopeOf(spec: string, module: string): Scope {
  const m = new RegExp(`module\\s+${module}\\s*\\{\\s*import\\s+queue\\(([\\s\\S]*?)\\)\\.\\*`).exec(spec);
  if (!m) throw new Error(`명세에 모듈 ${module}가 없다`);
  const v = (name: string) => {
    const x = new RegExp(`\\b${name}\\s*=\\s*(Set\\((?:[^()]|\\([^()]*\\))*\\)|true|false|\\d+)`).exec(m[1]!);
    if (!x) throw new Error(`${module}: ${name}가 없다`);
    return x[1]!;
  };
  const ints = (s: string) => [...s.matchAll(/\d+/g)].map((x) => Number(x[0]));
  const pairs = (s: string) => [...s.matchAll(/\((\d+),\s*(\d+)\)/g)].map((x) => [Number(x[1]), Number(x[2])] as const);
  return {
    tickets: pairs(v('TICKETS')),
    ctrls: ints(v('CTRLS')),
    lag: Number(v('LAG')),
    openBatch: v('OPEN_BATCH') === 'true',
    admitSteps: v('ADMIT_STEPS') === 'true',
    maxFailovers: Number(v('MAX_FAILOVERS')),
    personFailovers: v('PERSON_FAILOVERS') === 'true',
    maxLeaderChanges: Number(v('MAX_LEADER_CHANGES')),
    epochJumps: ints(v('EPOCH_JUMPS')),
  };
}

/** 걸음 하나를 하네스로. 명세가 이 걸음을 회차 슬롯 쓰기로 보는지(evWrite)는 앞뒤 ev로 정한다 */
async function apply(s: QueueSystem, a: SpecAction, picks: Record<string, unknown>, pre: SpecState, post: SpecState): Promise<void> {
  const k = picks.k as K;
  const p = picks.p as number;
  const c = picks.c as number;
  const evWrite = !isDeepStrictEqual(pre.ev, post.ev);
  const step = (f: () => Promise<unknown>) => s.step(a, async () => void (await f()), evWrite);
  switch (a) {
    case 'enterPreempt':
      return step(() => s.enterPreempt(k));
    case 'pendingExpires':
      return step(() => s.pendingExpires(p));
    case 'enterNumber':
      return step(() => s.enterNumber(k));
    case 'enterRecord':
      return step(() => s.enterRecord(k));
    case 'enterBatchRecord':
      return step(() => s.enterBatchRecord(k));
    case 'batchMissing':
      return step(() => s.batchMissing(k));
    case 'leave':
      return step(() => s.leave(k));
    case 'takeBatchResult':
      return step(() => s.takeBatchResult(k));
    case 'publishBatch':
      return step(() => s.publishBatch());
    case 'applyWrite':
      return step(() => s.applyWrite(c));
    case 'rb05':
      return step(() => s.rb05());
    case 'admit':
      return step(() => s.admit(k));
    case 'admitCheck':
      return step(() => s.admitCheck(k));
    case 'admitClaim':
      return step(() => s.admitClaim(k));
    case 'admitSlot':
      return step(() => s.admitSlot(k, picks.ok as boolean));
    case 'admitSettle':
      return step(() => s.admitSettle(k));
    case 'admitRelease':
      return step(() => s.admitRelease(k));
    case 'windowEnds':
      await s.windowEnds();
      break;
    case 'acquire':
      s.acquire(c);
      break;
    case 'plan':
      // ADVANCE·CLOSE는 nondet이 아니라 step의 인자라 다음 상태의 ctl에서 읽는다
      s.plan(c, post.ctl.c.find(([x]) => x === c)![1].op as 'ADVANCE' | 'CLOSE');
      break;
    case 'replicateEv':
      s.replicateEv();
      break;
    case 'replicatePerson':
      await s.replicatePerson(p);
      break;
    case 'failoverEv':
      await s.failoverEv(picks.j as number);
      break;
    case 'failoverPerson':
      await s.failoverPerson(p);
      break;
    default:
      throw new Error(`재생: 모르는 동작 ${String(a)}(명세에 동작을 더했으면 하네스와 명령도 더한다)`);
  }
  s.note(a);
}

export interface ReplayOutcome {
  steps: number;
  replayed: number;
  mismatch: string | null;
}

/** 기록 하나를 재생한다. 처음 어긋난 걸음에서 멈추고 그 내용을 돌려준다(불변식 위반은 하네스의 violations에 남는다) */
export async function replay(s: QueueSystem, states: SpecState[]): Promise<ReplayOutcome> {
  for (let i = 1; i < states.length; i++) {
    const pre = states[i - 1]!;
    const post = states[i]!;
    await apply(s, post.action as SpecAction, post.picks, pre, post);
    const diffs: string[] = [];
    for (const [key, want] of post.tabs) {
      const got = s.tabs.get(key)!;
      if (got.phase !== want.phase) diffs.push(`탭 ${key} 단계 ${got.phase} ≠ 명세 ${want.phase}`);
      else if (!['IDLE', 'PREEMPTED', 'SADDED', 'BATCHED', 'DONE'].includes(want.phase) && (got.seq !== want.seq || got.gen !== want.gen)) {
        diffs.push(`탭 ${key} 대기표 ${got.seq}:${got.gen} ≠ 명세 ${want.seq}:${want.gen}`);
      }
    }
    const ev = await s.eventValues();
    const specGen = post.ev.skips.length + 1;
    if (ev.seq !== post.ev.seq || ev.serving !== post.ev.serving || ev.gen !== specGen || ev.leader !== post.ev.leader) {
      diffs.push(`회차 슬롯 seq·serving·세대·리더 ${ev.seq}·${ev.serving}·${ev.gen}·${ev.leader} ≠ 명세 ${post.ev.seq}·${post.ev.serving}·${specGen}·${post.ev.leader}`);
    }
    const o = s.observed();
    const marker = post.ev.closed ? `${post.ev.first}:${post.ev.size}:${post.ev.bgen}` : null;
    if (o.marker !== marker) diffs.push(`묶음 표시 ${o.marker ?? '없음'} ≠ 명세 ${marker ?? '없음'}`);
    if (o.pub !== post.ev.pub) diffs.push(`게시 표시 ${o.pub} ≠ 명세 ${post.ev.pub}`);
    if (JSON.stringify(o.removed) !== JSON.stringify(post.ev.removed)) diffs.push(`빠진 번호 ${JSON.stringify(o.removed)} ≠ 명세 ${JSON.stringify(post.ev.removed)}`);
    if (o.markerOk !== (post.ev.node === post.env.primary)) diffs.push(`세대 키가 지금 노드인가 ${o.markerOk} ≠ 명세 ${post.ev.node === post.env.primary}`);
    for (const [p, want] of post.pss) {
      const got = await s.personKinds(p);
      if (got.dup !== want.dup.kind || got.adm !== want.adm.kind) diffs.push(`사람 ${p} q:dup·q:adm ${got.dup}·${got.adm} ≠ 명세 ${want.dup.kind}·${want.adm.kind}`);
    }
    if (diffs.length > 0) {
      const picks = JSON.stringify(post.picks);
      return { steps: states.length - 1, replayed: i - 1, mismatch: `걸음 ${i} ${post.action} ${picks}: ${diffs.join('; ')}` };
    }
  }
  return { steps: states.length - 1, replayed: states.length - 1, mismatch: null };
}
