// 명세 specs/seat.qnt의 다음 상태 계산(TS로 옮김, BUILD_ORDER PRF-151 리뷰). 무작위 실행이 경합이 아닌 걸음마다 앞 상태에서 명세의 다음 상태를 계산해
// 운영 코드의 관측과 칸마다 견준다(재생은 기록의 다음 상태와도 견주므로 이 옮김도 함께 검사된다). 범위의 설계 장치는 운영 코드에 있는 값(UNIQUE_INDEX·DB_QUOTA·
// SORTED_INSERT·READY_CHECK·PIN_BEFORE_SALE·TOKEN_TIME_FLOOR 모두 켬)만 다룬다. 펜싱 카운터는 TOKEN_TIME_FLOOR가 켜져 바뀌지 않아 두지 않는다.
import { isDeepStrictEqual } from 'node:util';
import type { SpecAction } from './actions.js';
import type { Att, Phase, Red, Scope, SeatR } from './system.js';

export interface MDb {
  sale: Record<number, number[]>;
  /** 커밋 전 삽입 행의 시도(0은 없음) */
  unc: Record<number, number>;
  used: Record<number, number>;
  ledger: number[];
  gen: number;
}
/** 명세 상태(견주는 칸만) */
export interface MState {
  red: Red;
  rep: Red;
  atts: Map<number, Att>;
  db: MDb;
  env: { partials: number; fulls: number };
  ghost: { stale: number; newest: Record<number, number> };
}
export interface SpecMove {
  a: SpecAction;
  h?: number;
  l?: readonly number[];
}

const personOf = (h: number) => Math.floor(h / 10);
const EMPTY: SeatR = { hid: 0, pinned: false };
const clone = <T>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const sortedSeats = (l: readonly number[]) => [...l].sort((x, y) => x - y);

/** 명세 redWrite: 바뀌었으면 복제본은 앞 상태가 된다(복제 지연 쓰기 하나) */
function redWrite(s: MState, r2: Red): void {
  if (same(r2, s.red)) return;
  s.rep = s.red;
  s.red = r2;
}
function setQuota(r: Red, p: number, n: number): void {
  r.quota[p] = Math.max(0, n);
}

/** 앞 상태 pre에서 명세 동작 m을 한 걸음 한 다음 상태(동작은 할 수 있다고 본다: 명령의 check와 기록이 정한다) */
export function specNext(sc: Scope, pre: MState, m: SpecMove): MState {
  const s = clone(pre);
  const h = m.h ?? 0;
  const a = s.atts.get(h);
  const p = personOf(h);
  const live: Phase[] = ['ACCEPTED', 'PINNED', 'RESERVED', 'SOLD'];
  switch (m.a) {
    case 'hold': {
      const l = [...m.l!];
      const ok = l.every((x) => pre.red.seats[x]!.hid === 0) && pre.red.quota[p]! + new Set(l).size <= sc.limit;
      if (ok) {
        const r2 = clone(pre.red);
        for (const x of l) r2.seats[x] = { hid: h, pinned: false };
        setQuota(r2, p, pre.red.quota[p]! + new Set(l).size);
        redWrite(s, r2);
        s.atts.set(h, { phase: 'HELD', seats: l, late: false, ins: 0, gen: 0 });
        for (const x of l) s.ghost.newest[x] = h;
      } else a!.phase = 'DONE';
      return s;
    }
    case 'ttlPasses':
      a!.late = true;
      return s;
    case 'expire':
    case 'releaseFailed': {
      const mine = a!.seats.filter((x) => pre.red.seats[x]!.hid === h && (m.a === 'releaseFailed' || !pre.red.seats[x]!.pinned));
      const r2 = clone(pre.red);
      for (const x of mine) r2.seats[x] = { ...EMPTY };
      setQuota(r2, p, pre.red.quota[p]! - mine.length);
      redWrite(s, r2);
      for (const x of mine) if (s.ghost.newest[x] === h) s.ghost.newest[x] = 0;
      return s;
    }
    case 'accept': {
      const ok = a!.seats.every((x) => pre.red.seats[x]!.hid === h || pre.red.seats[x]!.hid === 0);
      Object.assign(a!, { phase: ok ? 'ACCEPTED' : 'DONE', gen: pre.red.gen });
      return s;
    }
    case 'pin': {
      const seats = a!.seats;
      const free = seats.filter((x) => pre.red.seats[x]!.hid === 0);
      const regrab = a!.gen === pre.red.gen;
      const ok = seats.every((x) => pre.red.seats[x]!.hid === h || (pre.red.seats[x]!.hid === 0 && regrab)) && pre.red.quota[p]! + free.length <= sc.limit;
      if (ok) {
        const r2 = clone(pre.red);
        for (const x of seats) r2.seats[x] = { hid: h, pinned: true };
        setQuota(r2, p, pre.red.quota[p]! + free.length);
        redWrite(s, r2);
        Object.assign(a!, { phase: 'PINNED', late: false, gen: pre.red.gen });
        for (const x of free) s.ghost.newest[x] = h;
      } else a!.phase = 'FAILED';
      return s;
    }
    case 'saleStep': {
      const l = sortedSeats(a!.seats);
      const x = l[a!.ins]!;
      const last = a!.ins + 1 === l.length;
      const rollBack = () => {
        for (const y of Object.keys(s.db.unc).map(Number)) if (s.db.unc[y] === h) s.db.unc[y] = 0;
      };
      if (pre.db.sale[x]!.length > 0) {
        rollBack();
        Object.assign(a!, { phase: 'FAILED', ins: 0 });
      } else if (!last) {
        s.db.unc[x] = h;
        a!.ins += 1;
      } else if (a!.gen !== pre.db.gen) {
        rollBack();
        Object.assign(a!, { phase: 'ACCEPTED', ins: 0 });
      } else if (pre.db.used[p]! + l.length > sc.limit) {
        rollBack();
        Object.assign(a!, { phase: 'FAILED', ins: 0 });
      } else {
        rollBack();
        for (const y of l) s.db.sale[y] = [...new Set([...s.db.sale[y]!, h])].sort((u, v) => u - v);
        s.db.used[p] = pre.db.used[p]! + l.length;
        Object.assign(a!, { phase: 'RESERVED', ins: 0 });
        const stale = l.some((y) => {
          const n = pre.ghost.newest[y] ?? 0;
          return n !== 0 && n !== h && live.includes(pre.atts.get(n)!.phase);
        });
        if (stale) s.ghost.stale += 1;
      }
      return s;
    }
    case 'approve':
      a!.phase = 'SOLD';
      return s;
    case 'decline':
      a!.phase = 'FAILED';
      for (const x of sc.seats) s.db.sale[x] = s.db.sale[x]!.filter((y) => y !== h);
      s.db.used[p] = pre.db.used[p]! - a!.seats.length;
      return s;
    case 'relay':
      s.db.ledger = [...new Set([...s.db.ledger, h])].sort((u, v) => u - v);
      return s;
    case 'replicate':
      s.rep = clone(s.red);
      return s;
    case 'promote':
      s.red = clone(s.rep);
      s.env.partials += 1;
      return s;
    case 'loseAll': {
      const r0: Red = { ready: false, gen: 0, seats: {}, quota: {} };
      for (const x of sc.seats) r0.seats[x] = { ...EMPTY };
      for (const q of sc.people) r0.quota[q] = 0;
      s.red = r0;
      s.rep = clone(r0);
      s.env.fulls += 1;
      return s;
    }
    case 'rebuild': {
      const liveP: Phase[] = ['HELD', 'ACCEPTED', 'PINNED', 'DONE'];
      const holders = pre.db.ledger.filter((g) => !pre.atts.get(g)!.late && liveP.includes(pre.atts.get(g)!.phase));
      const r2: Red = { ready: true, gen: pre.db.gen + 1, seats: {}, quota: {} };
      for (const x of sc.seats) {
        const sale = pre.db.sale[x]!;
        const owners = holders.filter((g) => pre.atts.get(g)!.seats.includes(x));
        r2.seats[x] = sale.length > 0 ? { hid: Math.min(...sale), pinned: true } : owners.length > 0 ? { hid: Math.min(...owners), pinned: false } : { ...EMPTY };
      }
      for (const q of sc.people) r2.quota[q] = sc.seats.filter((x) => r2.seats[x]!.hid !== 0 && personOf(r2.seats[x]!.hid) === q).length;
      redWrite(s, r2);
      s.db.gen = pre.db.gen + 1;
      return s;
    }
  }
}

/** 칸 하나의 어긋남(열쇠는 알려진 차이가 설명하는 칸을 가리킨다: 'red.seat.3', 'red.quota.1' 등) */
export interface Diff {
  key: string;
  msg: string;
}

const attView = (a: Att) => ({ phase: a.phase, seats: a.seats, late: a.late, ins: a.ins, gen: a.gen });

/** 명세 상태 want와 관측 got을 칸마다 견준다 */
export function compareState(sc: Scope, want: MState, got: MState): Diff[] {
  const out: Diff[] = [];
  const cmp = (key: string, w: unknown, g: unknown) => {
    if (!same(w, g)) out.push({ key, msg: `${key} 운영 ${JSON.stringify(g)} ≠ 명세 ${JSON.stringify(w)}` });
  };
  for (const [h, w] of want.atts) cmp(`att.${h}`, attView(w), attView(got.atts.get(h)!));
  for (const [name, w, g] of [
    ['red', want.red, got.red],
    ['rep', want.rep, got.rep],
  ] as const) {
    cmp(`${name}.ready`, w.ready, g.ready);
    cmp(`${name}.gen`, w.gen, g.gen);
    for (const x of sc.seats) cmp(`${name}.seat.${x}`, w.seats[x], g.seats[x]);
    for (const q of sc.people) cmp(`${name}.quota.${q}`, w.quota[q], g.quota[q]);
  }
  for (const x of sc.seats) cmp(`db.sale.${x}`, want.db.sale[x], got.db.sale[x]);
  for (const x of sc.seats) cmp(`db.unc.${x}`, want.db.unc[x] ?? 0, got.db.unc[x] ?? 0);
  for (const q of sc.people) cmp(`db.used.${q}`, want.db.used[q], got.db.used[q]);
  cmp('db.ledger', want.db.ledger, got.db.ledger);
  cmp('db.gen', want.db.gen, got.db.gen);
  cmp('env', want.env, got.env);
  cmp('ghost.stale', want.ghost.stale, got.ghost.stale);
  return out;
}
