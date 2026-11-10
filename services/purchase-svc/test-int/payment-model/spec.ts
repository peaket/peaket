// 명세 specs/payment.qnt의 다음 상태·할 수 있음·불변식을 TS로 옮긴 것(wbs 2.7.6, docs/verification.md §2.4, V-T40, BUILD_ORDER PRF-210).
// 무작위 실행은 걸음마다 앞 관측(명세 상태 꼴)에서 이 계산으로 다음 상태를 내다보고 운영 코드의 관측과 칸마다 견준다. 재생은 기록(quint)의 다음 상태와도 견주므로
// 이 옮김도 함께 검사된다(시험 'V-T40 명세 옮김'이 기록의 걸음마다 specNext가 기록의 다음 상태와 같은지 본다).
// 범위의 설계 장치는 운영 코드에 있는 값(PG_PINNED·ONE_PAYMENT_PER_ORDER·NO_ASSUME·WEBHOOK_QUERY·FORWARD_RECOVERY·ISSUE_RETRY·CS_PATH·ACK_CONDITIONAL 모두 켬)만 다룬다.
// ISSUE_FENCE(정본에 없는 추천안)는 범위 값 그대로 따른다(발권 막기는 하네스가 흉내 낸다).
// 명세가 nondet으로 고르는 갈래(판매 예약 성공·실패, 결제사 승인·거절, 발권 성공·실패)는 걸음의 choice로 받는다(무작위 실행은 하네스가 정하고, 재생은 기록의 다음 상태로 정한다).
import { isDeepStrictEqual } from 'node:util';
import type { SpecAction } from './actions.js';

export interface Ord {
  st: string;
  apg: number;
  job: boolean;
  over: boolean;
  cs: boolean;
}
export interface Att {
  pg: number;
  st: string;
}
export interface Tk {
  tk: string;
  closed: boolean;
  req: boolean;
  wait: string;
  broken: boolean;
}
export interface Env {
  sw: boolean;
  switches: number;
  timeouts: number;
  restarts: number;
  hooks: number;
  canceled: boolean;
}
export interface Ghost {
  offPg: boolean;
  badRefund: boolean;
  /** 승인 기한이 지나 승인 명령 없이 실패(T11)한 주문이 있었다(재생 기록의 목표 상태만 본다) */
  expiredCommand: boolean;
}
/** 명세 상태. 열쇠: att `${o},${k}`, pgs·req `${p},${o}`, pay `${o},${p}` */
export interface MState {
  ord: Record<number, Ord>;
  att: Record<string, Att>;
  pgs: Record<string, string>;
  req: Record<string, boolean>;
  pay: Record<string, string>;
  late: Record<number, boolean>;
  tks: Record<number, Tk>;
  env: Env;
  ghost: Ghost;
}
/** 검사 모듈의 범위(itf.ts scopeOf가 명세 import 줄에서 읽는다) */
export interface Scope {
  orders: number[];
  maxAttempts: number;
  maxSwitches: number;
  maxTimeouts: number;
  maxRestarts: number;
  maxWebhooks: number;
  eventCancel: boolean;
  ticketBreak: boolean;
  issueFence: boolean;
}
/** 걸음 하나: 동작과 nondet 값(o·p·k·b), 명세가 고르는 갈래(choice) */
export interface SpecMove {
  a: SpecAction;
  o?: number;
  p?: number;
  k?: number;
  b?: string;
  /** reserve: RESERVED·FAILED, pgProcess: APPROVED·DECLINED, ticketSvc: OK·ERR */
  c?: string;
}

export const PGS = [1, 2] as const;
const PRIMARY = 1;
const FALLBACK = 2;
export const ak = (o: number, k: number) => `${o},${k}`;
export const po = (p: number, o: number) => `${p},${o}`;
export const op = (o: number, p: number) => `${o},${p}`;
const ks = (sc: Scope) => Array.from({ length: sc.maxAttempts }, (_, i) => i + 1);
const clone = <T>(v: T): T => structuredClone(v);

export function initState(sc: Scope): MState {
  const s: MState = { ord: {}, att: {}, pgs: {}, req: {}, pay: {}, late: {}, tks: {}, env: { sw: false, switches: 0, timeouts: 0, restarts: 0, hooks: 0, canceled: false }, ghost: { offPg: false, badRefund: false, expiredCommand: false } };
  for (const o of sc.orders) {
    s.ord[o] = { st: 'CREATED', apg: 0, job: false, over: false, cs: false };
    s.late[o] = false;
    s.tks[o] = { tk: 'NONE', closed: false, req: false, wait: 'NONE', broken: false };
    for (const k of ks(sc)) s.att[ak(o, k)] = { pg: 0, st: 'NONE' };
    for (const p of PGS) {
      s.pgs[po(p, o)] = 'NONE';
      s.req[po(p, o)] = false;
      s.pay[op(o, p)] = 'NONE';
    }
  }
  return s;
}

const selected = (s: MState) => (s.env.sw ? FALLBACK : PRIMARY);
/** 정본(PG_PINNED): 접수 뒤 결제사로 가는 길은 결제 기록의 결제사다 */
const route = (_s: MState, rowPg: number) => rowPg;
const rows = (s: MState, o: number) => PGS.filter((p) => s.pay[op(o, p)] !== 'NONE');
const newK = (sc: Scope, s: MState, o: number) => 1 + ks(sc).filter((x) => s.att[ak(o, x)]!.st !== 'NONE').length;

/** 그 걸음을 지금 할 수 있는가(명세의 전제. choice는 보지 않는다) */
export function enabled(sc: Scope, s: MState, m: SpecMove): boolean {
  const o = m.o ?? 0;
  const p = m.p ?? 0;
  const k = m.k ?? 0;
  const ord = s.ord[o];
  const tk = s.tks[o];
  switch (m.a) {
    case 'newAttempt':
      return ord!.st === 'CREATED' && newK(sc, s, o) <= sc.maxAttempts;
    case 'auth': {
      const a = s.att[ak(o, k)]!;
      return ord!.st === 'CREATED' && ['READY', 'SUPERSEDED'].includes(a.st) && s.pgs[po(a.pg, o)] === 'NONE';
    }
    case 'accept': {
      const a = s.att[ak(o, k)]!;
      return ord!.st === 'CREATED' && a.st === 'READY' && s.pgs[po(a.pg, o)] === 'AUTH';
    }
    case 'expireAttempt':
      return s.att[ak(o, k)]!.st === 'READY';
    case 'expireOrder':
      return ord!.st === 'CREATED' && ks(sc).every((x) => s.att[ak(o, x)]!.st !== 'READY');
    case 'reserve':
      // 승인 기한이 지났으면 실패 갈래만 있다(T8 EXPIRED, 명세 reserve, 코드 리뷰 H1)
      return ord!.st === 'ACCEPTED' && !(s.late[o] && m.c === 'RESERVED');
    case 'command':
      return ord!.st === 'RESERVED' && s.pay[op(o, route(s, ord!.apg))] === 'NONE' && rows(s, o).length === 0;
    case 'send':
      return s.pay[op(o, p)] === 'ACCEPTED' && !s.late[o];
    case 'expireCommand':
      return s.pay[op(o, p)] === 'ACCEPTED' && s.late[o]!;
    case 'pgProcess':
      return s.req[po(p, o)]!;
    case 'pgCancel':
      return s.pgs[po(p, o)] === 'APPROVED' && s.pay[op(o, p)] === 'UNKNOWN';
    case 'pgExpire':
      return s.pgs[po(p, o)] === 'AUTH' && s.late[o]! && !s.req[po(p, o)];
    case 'respond':
      return s.pay[op(o, p)] === 'SENT' && !s.req[po(p, o)];
    case 'timeout':
      return s.pay[op(o, p)] === 'SENT' && s.env.timeouts < sc.maxTimeouts;
    case 'restart':
      return s.env.restarts < sc.maxRestarts && Object.values(s.pay).some((v) => v === 'SENT');
    case 'query':
      return s.pay[op(o, p)] === 'UNKNOWN' && s.pgs[po(route(s, p), o)] !== 'AUTH';
    case 'webhook':
      // 정본(WEBHOOK_QUERY)은 웹훅 본문을 믿지 않아 이 걸음이 없다
      return false;
    case 'deadlinePasses':
      return ['ACCEPTED', 'RESERVED'].includes(ord!.st) && !s.late[o] && PGS.every((q) => !['APPROVED', 'FAILED', 'CANCELED'].includes(s.pay[op(o, q)]!));
    case 'applyResult':
      return ord!.st === 'RESERVED' && ['APPROVED', 'FAILED', 'CANCELED'].includes(s.pay[op(o, p)]!);
    case 'issue':
      return ord!.st === 'APPROVED' && ord!.job && tk!.wait === 'NONE';
    case 'ticketSvc':
      return tk!.req;
    case 'issueAck':
      return tk!.wait !== 'NONE';
    case 'ticketBreaks':
      return sc.ticketBreak && ord!.st === 'APPROVED' && !tk!.broken;
    case 'overdue':
      return ord!.st === 'APPROVED' && ord!.job && !ord!.over;
    case 'csConfirm':
      return ord!.st === 'APPROVED' && ord!.over && !ord!.cs;
    case 'compStart':
      return ord!.st === 'APPROVED' && (s.env.canceled || ord!.cs);
    case 'compFence':
      return sc.issueFence && ord!.st === 'COMPENSATING' && !tk!.closed;
    case 'compCancel':
      return ord!.st === 'COMPENSATING' && (!sc.issueFence || tk!.closed);
    case 'eventCancel':
      return sc.eventCancel && !s.env.canceled;
    case 'eventRefund':
      return s.env.canceled && ord!.st === 'CONFIRMED';
    case 'toggleSwitch':
      return s.env.switches < sc.maxSwitches;
  }
}

/** 지금 할 수 있는 걸음(choice 없이). 무작위 실행의 명령이 고른다 */
export function enabledMoves(sc: Scope, s: MState): SpecMove[] {
  const out: SpecMove[] = [];
  const add = (m: SpecMove) => {
    if (enabled(sc, s, m)) out.push(m);
  };
  for (const o of sc.orders) {
    for (const a of ['newAttempt', 'expireOrder', 'reserve', 'command', 'deadlinePasses', 'issue', 'ticketSvc', 'issueAck', 'ticketBreaks', 'overdue', 'csConfirm', 'compStart', 'compFence', 'compCancel', 'eventRefund'] as const) add({ a, o });
    for (const k of ks(sc)) for (const a of ['auth', 'accept', 'expireAttempt'] as const) add({ a, o, k });
    for (const p of PGS) for (const a of ['send', 'expireCommand', 'pgProcess', 'pgCancel', 'pgExpire', 'respond', 'timeout', 'query', 'applyResult'] as const) add({ a, o, p });
  }
  for (const a of ['restart', 'eventCancel', 'toggleSwitch'] as const) add({ a });
  return out;
}

function cancelAt(s: MState, p: number, o: number): void {
  if (s.pgs[po(p, o)] === 'APPROVED') s.pgs[po(p, o)] = 'CANCELED';
}
function payCanceled(s: MState, o: number): void {
  for (const p of PGS) if (s.pay[op(o, p)] === 'APPROVED') s.pay[op(o, p)] = 'CANCELED';
}
function noteRoute(s: MState, fixed: number, p: number): void {
  s.ghost.offPg = s.ghost.offPg || p !== fixed;
}
function refundGhost(pre: MState, s: MState, o: number): void {
  s.ghost.badRefund = s.ghost.badRefund || !(pre.env.canceled || pre.ord[o]!.cs);
}

/** 앞 상태 pre에서 걸음 m을 한 다음 상태(걸음은 할 수 있다고 본다). 갈래가 있는 걸음은 m.c를 따른다 */
export function specNext(sc: Scope, pre: MState, m: SpecMove): MState {
  const s = clone(pre);
  const o = m.o ?? 0;
  const p = m.p ?? 0;
  const k = m.k ?? 0;
  const ord = s.ord[o]!;
  const tk = s.tks[o]!;
  switch (m.a) {
    case 'newAttempt': {
      const n = newK(sc, pre, o);
      for (const x of ks(sc)) if (s.att[ak(o, x)]!.st === 'READY') s.att[ak(o, x)]!.st = 'SUPERSEDED';
      s.att[ak(o, n)] = { pg: selected(pre), st: 'READY' };
      return s;
    }
    case 'auth':
      s.pgs[po(pre.att[ak(o, k)]!.pg, o)] = 'AUTH';
      return s;
    case 'accept': {
      const a = s.att[ak(o, k)]!;
      a.st = 'ACCEPTED';
      Object.assign(ord, { st: 'ACCEPTED', apg: a.pg });
      return s;
    }
    case 'expireAttempt':
      s.att[ak(o, k)]!.st = 'EXPIRED';
      return s;
    case 'expireOrder':
      ord.st = 'EXPIRED';
      return s;
    case 'reserve':
      ord.st = pre.late[o] || m.c === 'FAILED' ? 'FAILED' : 'RESERVED';
      return s;
    case 'command': {
      // 승인 기한이 지났고 한 번도 보내지 못한 주문은 보내지 않고 과금 없이 실패(T11 EXPIRED, 명세 command, 코드 리뷰 H1)
      if (pre.late[o] && rows(pre, o).length === 0) {
        ord.st = 'FAILED';
        s.ghost.expiredCommand = true;
        return s;
      }
      const q = route(pre, pre.ord[o]!.apg);
      s.pay[op(o, q)] = 'ACCEPTED';
      noteRoute(s, pre.ord[o]!.apg, q);
      return s;
    }
    case 'send':
      s.pay[op(o, p)] = 'SENT';
      s.req[po(p, o)] = true;
      return s;
    case 'expireCommand':
      s.pay[op(o, p)] = 'FAILED';
      return s;
    case 'pgProcess':
      s.req[po(p, o)] = false;
      if (pre.pgs[po(p, o)] === 'AUTH') s.pgs[po(p, o)] = m.c === 'DECLINED' ? 'DECLINED' : 'APPROVED';
      return s;
    case 'pgCancel':
      s.pgs[po(p, o)] = 'CANCELED';
      return s;
    case 'pgExpire':
      s.pgs[po(p, o)] = 'EXPIRED';
      return s;
    case 'respond':
      s.pay[op(o, p)] = pre.pgs[po(p, o)] === 'APPROVED' ? 'APPROVED' : 'FAILED';
      return s;
    case 'timeout':
      s.pay[op(o, p)] = 'UNKNOWN';
      s.env.timeouts += 1;
      return s;
    case 'restart':
      for (const key of Object.keys(s.pay)) if (s.pay[key] === 'SENT') s.pay[key] = 'UNKNOWN';
      s.env.restarts += 1;
      return s;
    case 'query': {
      const q = route(pre, p);
      const v = pre.pgs[po(q, o)];
      s.pay[op(o, p)] = v === 'APPROVED' ? 'APPROVED' : v === 'CANCELED' ? 'CANCELED' : 'FAILED';
      noteRoute(s, pre.ord[o]!.apg, q);
      return s;
    }
    case 'webhook':
      s.pay[op(o, p)] = m.b!;
      s.env.hooks += 1;
      return s;
    case 'deadlinePasses':
      s.late[o] = true;
      return s;
    case 'applyResult':
      if (pre.pay[op(o, p)] === 'APPROVED') Object.assign(ord, { st: 'APPROVED', job: true });
      else ord.st = 'FAILED';
      return s;
    case 'issue':
      Object.assign(tk, { req: true, wait: 'WAIT' });
      return s;
    case 'ticketSvc': {
      const t = pre.tks[o]!;
      const ans = (x: string) => (t.wait === 'WAIT' ? x : t.wait);
      if (t.closed || t.broken || m.c === 'ERR') Object.assign(tk, { req: false, wait: ans('ERR') });
      else Object.assign(tk, { req: false, wait: ans('OK'), tk: t.tk === 'NONE' ? 'ISSUED' : t.tk });
      return s;
    }
    case 'issueAck': {
      const t = pre.tks[o]!;
      tk.wait = 'NONE';
      if (pre.ord[o]!.st !== 'APPROVED') return s;
      if (t.wait === 'OK') Object.assign(ord, { st: 'CONFIRMED', job: false });
      // 그 밖(ERR·WAIT 답을 기다리다 그만둠)은 다시 보낼 수 있는 오류: 큐 행을 둔다(FORWARD_RECOVERY·ISSUE_RETRY)
      return s;
    }
    case 'ticketBreaks':
      tk.broken = true;
      return s;
    case 'overdue':
      ord.over = true;
      return s;
    case 'csConfirm':
      ord.cs = true;
      return s;
    case 'compStart':
      Object.assign(ord, { st: 'COMPENSATING', job: false });
      return s;
    case 'compFence':
      Object.assign(tk, { closed: true, tk: pre.tks[o]!.tk === 'ISSUED' ? 'REVOKED' : pre.tks[o]!.tk });
      return s;
    case 'compCancel': {
      const q = route(pre, pre.ord[o]!.apg);
      ord.st = 'COMPENSATED';
      cancelAt(s, q, o);
      payCanceled(s, o);
      refundGhost(pre, s, o);
      noteRoute(s, pre.ord[o]!.apg, q);
      return s;
    }
    case 'eventCancel':
      s.env.canceled = true;
      return s;
    case 'eventRefund': {
      const q = route(pre, pre.ord[o]!.apg);
      tk.tk = 'REVOKED';
      ord.st = 'REFUNDED';
      cancelAt(s, q, o);
      payCanceled(s, o);
      refundGhost(pre, s, o);
      noteRoute(s, pre.ord[o]!.apg, q);
      return s;
    }
    case 'toggleSwitch':
      s.env.sw = !pre.env.sw;
      s.env.switches += 1;
      return s;
  }
}

/** 명세 불변식 ①~⑥(어긴 것의 글. 빈 배열이면 지켜짐). ①은 결제사 쪽 승인 기록(pgs)으로 센다 */
export function invariantViolations(sc: Scope, s: MState): string[] {
  const out: string[] = [];
  for (const o of sc.orders) {
    const charged = PGS.filter((p) => ['APPROVED', 'CANCELED'].includes(s.pgs[po(p, o)]!));
    if (charged.length > 1) out.push(`① 주문 ${o}을 승인한 결제사가 ${charged.length}곳`);
    const ok = PGS.some((p) => s.pgs[po(p, o)] === 'APPROVED');
    if (s.tks[o]!.tk === 'ISSUED' && !ok) out.push(`③ 주문 ${o}에 승인 없는 유효 티켓`);
    if (['FAILED', 'EXPIRED'].includes(s.ord[o]!.st) && ok) out.push(`⑤ 과금 없이 끝난 주문 ${o}(${s.ord[o]!.st})에 결제사 승인이 남음`);
    if (s.ord[o]!.st === 'CONFIRMED' && s.tks[o]!.tk !== 'ISSUED') out.push(`⑥ 발권 완료 주문 ${o}에 유효 티켓이 없음(${s.tks[o]!.tk})`);
  }
  if (s.ghost.offPg) out.push('② 접수 뒤 고정한 결제사가 아닌 곳으로 결제 원장·호출이 갔다');
  if (s.ghost.badRefund) out.push('④ 회차 취소 확정·CS 확인 없이 결제사 취소가 일어났다');
  return out;
}

/** 칸 하나의 어긋남(열쇠는 알려진 차이가 설명하는 칸을 가리킨다) */
export interface Diff {
  key: string;
  msg: string;
}

/** 명세 상태 want와 관측 got을 칸마다 견준다 */
export function compareState(sc: Scope, want: MState, got: MState): Diff[] {
  const out: Diff[] = [];
  const cmp = (key: string, w: unknown, g: unknown) => {
    if (!isDeepStrictEqual(w, g)) out.push({ key, msg: `${key} 운영 ${JSON.stringify(g)} ≠ 명세 ${JSON.stringify(w)}` });
  };
  for (const o of sc.orders) {
    cmp(`ord.${o}`, want.ord[o], got.ord[o]);
    cmp(`late.${o}`, want.late[o], got.late[o]);
    cmp(`tks.${o}`, want.tks[o], got.tks[o]);
    for (const k of ks(sc)) cmp(`att.${ak(o, k)}`, want.att[ak(o, k)], got.att[ak(o, k)]);
    for (const p of PGS) {
      cmp(`pgs.${po(p, o)}`, want.pgs[po(p, o)], got.pgs[po(p, o)]);
      cmp(`req.${po(p, o)}`, want.req[po(p, o)], got.req[po(p, o)]);
      cmp(`pay.${op(o, p)}`, want.pay[op(o, p)], got.pay[op(o, p)]);
    }
  }
  cmp('env', want.env, got.env);
  cmp('ghost', want.ghost, got.ghost);
  return out;
}
