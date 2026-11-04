// pid 키 전환 기간의 1인 1순번(docs/features/queue-admission.md §3 'pid 키 전환 기간'의 '첫 구현', BUILD_ORDER BOT-025, Q-T45, ADR-0127).
// 진입과 입장 확정을 메모리 저장소(test/entry.test.ts·test/admission.test.ts)와 실제 Valkey의 Lua(test-int/entry-store.int.test.ts·admission-store.int.test.ts)에 똑같이 돈다.
import { describe, expect, test } from 'vitest';
import { AdmissionError } from '../src/modules/admission/application/admission-error.js';
import { ConfirmAdmission } from '../src/modules/admission/application/confirm-admission.js';
import { TURN_GRACE_MS } from '../src/modules/admission/domain/admission.js';
import type { AdmissionStore } from '../src/modules/admission/domain/ports.js';
import { EnterQueue, type EnterOutcome, type EnterResult } from '../src/modules/entry/application/enter-queue.js';
import { EntryError } from '../src/modules/entry/application/entry-error.js';
import type { EntryStore } from '../src/modules/entry/domain/ports.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { type AdmissionHarness, recordingSignals, signer } from './admission-cases.js';
import type { EntryWorld } from './entry-cases.js';
import { ACCOUNT, DEVICE, JNY, newEvent, newRequest, openSchedule, preverifyToken, tokens } from './support.js';

/** 진입 사례가 쓰는 세계에 사람 키 값 읽기·쓰기를 더한다 */
export type PidWorld = EntryWorld & {
  dupOf(pid: string, eventId: string): Promise<{ value: string | null; expireAtMs: number | null }>;
  /** 사람 키 값을 바꾼다(null이면 지운다). 장애 전환으로 쓰기를 잃은 것이나 다른 요청을 흉내 낸다 */
  setDup(pid: string, eventId: string, value: string | null, expireAtMs?: number): Promise<void>;
};

let n = 0;
const pids = () => {
  const k = `${process.pid}-${Date.now().toString(36)}-${n++}`;
  return { OLD: `pid-old-${k}`, NEW: `pid-new-${k}` };
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof EntryError || e instanceof AdmissionError) return e.code;
    if (e instanceof QueueStoreUnavailable) return 'STORE_DOWN';
    throw e;
  }
}

function ticketOf(r: EnterOutcome): EnterResult {
  if (r.kind !== 'TICKET') throw new Error(`대기표가 아니라 ${r.kind}다`);
  return r;
}

/** 저장소를 감싸 사람 키 호출에 장애·끼어들기를 넣는다 */
function wrapped(store: EntryStore, o: { failPreempt?: string; failMirrorOnce?: boolean; beforeMirror?: () => Promise<void> }): EntryStore {
  let mirrorFailed = false;
  const preempt: EntryStore['preempt'] = async (i) => {
    if (o.failPreempt === i.pid) throw new QueueStoreUnavailable(new Error('주입한 장애'));
    return store.preempt(i);
  };
  const mirror: EntryStore['mirror'] = async (i) => {
    await o.beforeMirror?.();
    if (o.failMirrorOnce && !mirrorFailed) {
      mirrorFailed = true;
      throw new QueueStoreUnavailable(new Error('주입한 장애'));
    }
    return store.mirror(i);
  };
  return new Proxy(store, {
    get: (target, prop, recv) => {
      if (prop === 'preempt') return preempt;
      if (prop === 'mirror') return mirror;
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

export function pidTransitionEntryCases(label: string, make: () => Promise<PidWorld>) {
  describe(`pid 키 전환 기간의 진입(${label})`, () => {
    const setup = async () => {
      const w = await make();
      const eventId = newEvent();
      await w.schedules.set(eventId, openSchedule(w.clock.now()));
      const body = (o: { entryRequestId?: string } = {}) => ({ preverifyToken: preverifyToken(w.clock, eventId), deviceId: DEVICE, entryRequestId: o.entryRequestId ?? newRequest() });
      const run = async (b: ReturnType<typeof body>, who: { pid: string; pidPrev?: string }, store: EntryStore = w.store) =>
        ticketOf(await new EnterQueue(store, w.schedules, tokens, w.clock, { pendingTtlMs: w.pendingTtlMs }).run({ accountId: ACCOUNT, eventId, body: b, ...who }));
      return { w, eventId, body, run, ...pids() };
    };

    test('[Q-T45①] 옛 pid로 줄을 선 사람이 두 pid를 실은 새 토큰으로 다시 진입하면 409 이미 대기 중이고 새 pid 키에 값을 남기지 않는다', async () => {
      const { w, eventId, body, run, OLD, NEW } = await setup();
      expect((await run(body(), { pid: OLD })).seq).toBe(1);
      expect(await code(run(body(), { pid: NEW, pidPrev: OLD }))).toBe('ALREADY_WAITING');
      expect((await w.dupOf(NEW, eventId)).value).toBeNull();
      expect(await w.counter(eventId)).toBe(1);
    });

    test('[Q-T45②] 다른 사람이 옛 pid만 실은 교체 직전 토큰과 두 pid 토큰으로 동시에 진입하면 번호는 하나만 나간다', async () => {
      const { w, eventId, body, run, OLD, NEW } = await setup();
      const codes = await Promise.all([code(run(body(), { pid: OLD })), code(run(body(), { pid: NEW, pidPrev: OLD })), code(run(body(), { pid: OLD })), code(run(body(), { pid: NEW, pidPrev: OLD }))]);
      expect(codes.filter((c) => c === 'OK')).toHaveLength(1);
      expect(codes.filter((c) => c === 'ALREADY_WAITING')).toHaveLength(3);
      expect(await w.counter(eventId)).toBe(1);
    });

    test('[Q-T45②] 두 pid 진입이 번호를 받으면 두 키에 같은 기록과 같은 수명이 남고, 같은 요청 ID 재시도는 같은 대기표다', async () => {
      const { w, eventId, body, run, OLD, NEW } = await setup();
      const b = body();
      const first = await run(b, { pid: NEW, pidPrev: OLD });
      const o = await w.dupOf(OLD, eventId);
      const c = await w.dupOf(NEW, eventId);
      expect(o.value).toMatch(new RegExp(`^1:1:${b.entryRequestId}:`));
      expect(c).toEqual(o);
      expect((await run({ ...b, preverifyToken: preverifyToken(w.clock, eventId) }, { pid: NEW, pidPrev: OLD })).queueTicket).toBe(first.queueTicket);
      expect(await w.counter(eventId)).toBe(1);
    });

    test('[Q-T45③] 입장한 사람이 새 토큰으로 진입하면 409 ALREADY_ADMITTED이고 두 키 모두 선점이 남지 않는다', async () => {
      const { w, eventId, body, run, OLD, NEW } = await setup();
      await w.admit(OLD, eventId, 'a'.repeat(64));
      expect(await code(run(body(), { pid: NEW, pidPrev: OLD }))).toBe('ALREADY_ADMITTED');
      expect((await w.dupOf(OLD, eventId)).value).toBeNull();
      expect((await w.dupOf(NEW, eventId)).value).toBeNull();
      // 새 pid 쪽에서 입장 키가 보여도(전환 중 두 키 입장 뒤 옛 키를 잃음) 옛 선점을 풀고 같은 409다
      const x = pids();
      await w.admit(x.NEW, eventId, 'b'.repeat(64));
      expect(await code(run(body(), { pid: x.NEW, pidPrev: x.OLD }))).toBe('ALREADY_ADMITTED');
      expect((await w.dupOf(x.OLD, eventId)).value).toBeNull();
      expect(await w.counter(eventId)).toBe(0);
    });

    test('[Q-T45④] 전환 중에 두 pid로 줄을 선 뒤 전환이 끝나 새 pid만 실린 토큰으로 다시 진입하면 새 pid 키로 막힌다', async () => {
      const { w, eventId, body, run, OLD, NEW } = await setup();
      const b = body();
      const first = await run(b, { pid: NEW, pidPrev: OLD });
      expect(await code(run(body(), { pid: NEW }))).toBe('ALREADY_WAITING');
      // 같은 요청 ID의 재시도는 새 pid 키의 기록으로 같은 대기표를 다시 받는다
      expect((await run(b, { pid: NEW })).queueTicket).toBe(first.queueTicket);
      expect(await w.counter(eventId)).toBe(1);
    });

    test('[Q-T45⑤] 새 pid 쪽 호출에 장애를 넣으면 옛 pid 쪽 선점이 지워지고 503이며, 다시 보내면 번호가 하나 나간다', async () => {
      const { w, eventId, body, run, OLD, NEW } = await setup();
      const b = body();
      expect(await code(run(b, { pid: NEW, pidPrev: OLD }, wrapped(w.store, { failPreempt: NEW })))).toBe('STORE_DOWN');
      expect((await w.dupOf(OLD, eventId)).value).toBeNull();
      expect(await w.counter(eventId)).toBe(0);
      expect((await run(b, { pid: NEW, pidPrev: OLD })).seq).toBe(1);
      expect(await w.counter(eventId)).toBe(1);
    });

    test('[Q-T45] 옮겨 쓰기가 오류로 끝나면 503이고, 같은 요청 ID로 다시 보내면 같은 번호의 대기표를 받고 두 키에 기록이 남는다', async () => {
      const { w, eventId, body, run, OLD, NEW } = await setup();
      const b = body();
      expect(await code(run(b, { pid: NEW, pidPrev: OLD }, wrapped(w.store, { failMirrorOnce: true })))).toBe('STORE_DOWN');
      const again = await run(b, { pid: NEW, pidPrev: OLD });
      expect(again.seq).toBe(1);
      expect((await w.dupOf(NEW, eventId)).value).toBe((await w.dupOf(OLD, eventId)).value);
      expect(await w.counter(eventId)).toBe(1);
    });

    test('[Q-T45] 옛 키의 기록을 잃고 새 키에만 있으면 새 키가 앞 키가 되어 같은 대기표를 다시 주고 옛 키에 다시 쓴다', async () => {
      const { w, eventId, body, run, OLD, NEW } = await setup();
      const b = body();
      const first = await run(b, { pid: NEW, pidPrev: OLD });
      const kept = await w.dupOf(NEW, eventId);
      await w.setDup(OLD, eventId, null);
      expect((await run(b, { pid: NEW, pidPrev: OLD })).queueTicket).toBe(first.queueTicket);
      expect(await w.dupOf(OLD, eventId)).toEqual(kept);
      expect(await w.counter(eventId)).toBe(1);
    });

    test('[Q-T45] 옮겨 쓰기 전에 다른 요청이 새 키를 차지했으면 앞 키의 이 요청 값을 지우고 받은 번호를 빠진 번호로 돌린 뒤 409다', async () => {
      const { w, eventId, body, run, OLD, NEW } = await setup();
      const other = `7:1:${newRequest()}:${JNY}:`;
      const store = wrapped(w.store, { beforeMirror: () => w.setDup(NEW, eventId, other, w.clock.now() + 3_600_000) });
      expect(await code(run(body(), { pid: NEW, pidPrev: OLD }, store))).toBe('ALREADY_WAITING');
      expect((await w.dupOf(OLD, eventId)).value).toBeNull();
      expect((await w.dupOf(NEW, eventId)).value).toBe(other);
      expect(await w.removed(eventId, 1)).toBe(true);
    });

    test('[Q-T45] 옛 pid와 새 pid가 같으면 한 키로만 처리한다', async () => {
      const { w, eventId, body, run, OLD } = await setup();
      expect((await run(body(), { pid: OLD, pidPrev: OLD })).seq).toBe(1);
      expect(await w.counter(eventId)).toBe(1);
    });
  });
}

export function pidTransitionAdmissionCases(label: string, setup: () => Promise<AdmissionHarness>) {
  describe(`pid 키 전환 기간의 입장 확정(${label})`, () => {
    async function world(o: { turnAgoMs?: number; wrap?: (s: AdmissionStore) => AdmissionStore } = {}) {
      const h = await setup();
      const eventId = newEvent();
      const now = h.clock.now();
      await h.schedules.set(eventId, openSchedule(now));
      await h.setServing(eventId, 200);
      const turnAt = now - (o.turnAgoMs ?? 60_000);
      await h.logServing(eventId, turnAt, 200);
      const app = new ConfirmAdmission(o.wrap ? o.wrap(h.store) : h.store, h.schedules, tokens, signer, recordingSignals(), h.clock);
      const ticket = (seq: number) => tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: seq, g: 1, seg: Math.floor((seq - 1) / 1000), rq: crypto.randomUUID(), jny: JNY });
      const confirm = (t: string, who: { pid: string; pidPrev?: string }) => app.run({ accountId: ACCOUNT, sessionId: 'sess-1', eventId, body: { queueTicket: t }, ...who });
      return { h, eventId, now, ticket, confirm, ...pids() };
    }

    test('[Q-T45] 두 pid로 입장하면 두 키의 q:adm이 이 대기표이고 q:dup이 지워지며, 전환이 끝난 뒤 새 pid만으로 낸 다른 대기표는 409 DUPLICATE_ADMISSION이다', async () => {
      const { h, eventId, ticket, confirm, OLD, NEW } = await world();
      await h.setDup(OLD, eventId, `150:1:rq:${JNY}:`);
      await h.setDup(NEW, eventId, `150:1:rq:${JNY}:`);
      const t = ticket(150);
      expect((await confirm(t, { pid: NEW, pidPrev: OLD })).status).toBe('ADMITTED');
      for (const p of [OLD, NEW]) {
        expect((await h.adm(p, eventId))?.startsWith(`${tokens.hash(t)}:`)).toBe(true);
        expect(await h.dup(p, eventId)).toBeNull();
      }
      // 같은 대기표로 다시 오면 그대로 통과한다
      expect((await confirm(t, { pid: NEW, pidPrev: OLD })).status).toBe('ADMITTED');
      expect((await code(confirm(ticket(160), { pid: NEW })))).toBe('DUPLICATE_ADMISSION');
      expect(await h.isRemoved(eventId, 160)).toBe(true);
    });

    test('[Q-T45③] 옛 pid로 입장한 사람이 두 pid로 다른 대기표를 내면 409이고 새 키에 값을 남기지 않는다', async () => {
      const { h, eventId, ticket, confirm, OLD, NEW } = await world();
      expect((await confirm(ticket(150), { pid: OLD })).status).toBe('ADMITTED');
      expect(await code(confirm(ticket(160), { pid: NEW, pidPrev: OLD }))).toBe('DUPLICATE_ADMISSION');
      expect(await h.adm(NEW, eventId)).toBeNull();
      expect(await h.isRemoved(eventId, 160)).toBe(true);
    });

    test('[Q-T45] 새 pid 쪽 q:adm이 다른 대기표면 옛 쪽에 이 요청이 새로 채운 값을 지우고 409이며 번호는 빠진 번호다', async () => {
      const { h, eventId, ticket, confirm, OLD, NEW } = await world();
      await h.setAdm(NEW, eventId, `${'b'.repeat(64)}:jti-x`);
      expect(await code(confirm(ticket(150), { pid: NEW, pidPrev: OLD }))).toBe('DUPLICATE_ADMISSION');
      expect(await h.adm(OLD, eventId)).toBeNull();
      expect(await h.isRemoved(eventId, 150)).toBe(true);
      expect((await h.slots(eventId)).size).toBe(0);
    });

    test('[Q-T45] 새 pid 쪽 확인이 오류로 끝나면 옛 쪽에 새로 채운 값을 지우고 503 원인을 그대로 던진다', async () => {
      let id = '';
      const { h, eventId, ticket, confirm, OLD, NEW } = await world({
        wrap: (s) =>
          new Proxy(s, {
            get: (target, prop, recv) => {
              if (prop === 'claim') return async (i: Parameters<AdmissionStore['claim']>[0]) => (i.pid === id ? Promise.reject(new QueueStoreUnavailable(new Error('주입한 장애'))) : target.claim(i));
              const v = Reflect.get(target, prop, recv) as unknown;
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
          }),
      });
      id = NEW;
      expect(await code(confirm(ticket(150), { pid: NEW, pidPrev: OLD }))).toBe('STORE_DOWN');
      expect(await h.adm(OLD, eventId)).toBeNull();
      expect((await h.slots(eventId)).size).toBe(0);
    });

    test('[Q-T45] 입장이 확정된 뒤 새 pid 쪽 마무리가 오류로 끝나도 옛 키의 q:adm을 지우지 않는다(되돌리지 않고 503, 같은 대기표로 다시 오면 마무리한다)', async () => {
      let failNew = '';
      const { h, eventId, ticket, confirm, OLD, NEW } = await world({
        wrap: (s) =>
          new Proxy(s, {
            get: (target, prop, recv) => {
              if (prop === 'settle')
                return async (i: Parameters<AdmissionStore['settle']>[0]) => {
                  if (i.pid === failNew && i.outcome === 'ADMITTED') {
                    failNew = '';
                    throw new QueueStoreUnavailable(new Error('주입한 장애'));
                  }
                  return target.settle(i);
                };
              const v = Reflect.get(target, prop, recv) as unknown;
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
          }),
      });
      failNew = NEW;
      const t = ticket(150);
      expect(await code(confirm(t, { pid: NEW, pidPrev: OLD }))).toBe('STORE_DOWN');
      expect((await h.adm(OLD, eventId))?.startsWith(`${tokens.hash(t)}:`)).toBe(true);
      expect((await h.adm(NEW, eventId))?.startsWith(`${tokens.hash(t)}:`)).toBe(true);
      expect((await confirm(t, { pid: NEW, pidPrev: OLD })).status).toBe('ADMITTED');
      for (const p of [OLD, NEW]) expect((await h.adm(p, eventId))?.startsWith(`${tokens.hash(t)}:`)).toBe(true);
    });

    test('[Q-T45] 곧 입장(SOON)이면 두 키에서 이 요청이 새로 채운 값을 지운다', async () => {
      const { h, eventId, now, ticket, confirm, OLD, NEW } = await world();
      await h.setTarget(eventId, 1);
      await h.addSlot(eventId, 'someone', now + 60_000);
      expect((await confirm(ticket(150), { pid: NEW, pidPrev: OLD })).status).toBe('SOON');
      expect(await h.adm(OLD, eventId)).toBeNull();
      expect(await h.adm(NEW, eventId)).toBeNull();
    });

    test('[Q-T45] 15분 만료는 두 키의 q:dup을 지우고, 둘 중 하나에 입장 이력이 있으면 rejoinAllowed false다', async () => {
      const { h, eventId, ticket, confirm, OLD, NEW } = await world({ turnAgoMs: TURN_GRACE_MS + 60_000 });
      await h.setDup(OLD, eventId, `150:1:rq:${JNY}:`);
      await h.setDup(NEW, eventId, `150:1:rq:${JNY}:`);
      const e = await confirm(ticket(150), { pid: NEW, pidPrev: OLD }).catch((x: unknown) => x as AdmissionError);
      expect(e).toBeInstanceOf(AdmissionError);
      expect((e as AdmissionError).rejoinAllowed).toBe(true);
      expect(await h.dup(OLD, eventId)).toBeNull();
      expect(await h.dup(NEW, eventId)).toBeNull();
      await h.setAdm(NEW, eventId, `${'c'.repeat(64)}:jti-y`);
      const e2 = await confirm(ticket(150), { pid: NEW, pidPrev: OLD }).catch((x: unknown) => x as AdmissionError);
      expect((e2 as AdmissionError).rejoinAllowed).toBe(false);
    });
  });
}
