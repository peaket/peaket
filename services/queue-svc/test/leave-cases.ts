// 대기 취소·로비 참가 취소(docs/features/queue-admission.md §4 '대기 취소·로비 참가 취소의 첫 구현', Q-T68·Q-T35②·Q-T34⑦·Q-T52⑤, ADR-0233).
// 메모리 저장소(test/entry.test.ts)와 실제 Valkey의 Lua(test-int/entry-store.int.test.ts)에 같은 사례를 돌린다. 서버 시각을 쓰는 Lua는 실제 시계라 일정은 지금을 기준으로 잡는다.
import type { Clock } from '@peaket/platform';
import { TestSeedSealer } from '@peaket/shuffle';
import { expect, test } from 'vitest';
import { DEFAULT_ENTRY_OPTIONS, EnterQueue, type EnterResult } from '../src/modules/entry/application/enter-queue.js';
import { EntryError } from '../src/modules/entry/application/entry-error.js';
import { JoinLobby } from '../src/modules/entry/application/join-lobby.js';
import { LeaveQueue } from '../src/modules/entry/application/leave-queue.js';
import { ShuffleCommits } from '../src/modules/entry/application/shuffle-commits.js';
import type { EntryStore, EventSchedules, ShuffleCommitStore } from '../src/modules/entry/domain/ports.js';
import { type EventSchedule, QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, DEVICE, newEvent, newRequest, openSchedule, PID, preverifyToken, recordingRisk, tokens } from './support.js';

export interface LeaveWorld {
  store: EntryStore;
  commits: ShuffleCommitStore;
  schedules: EventSchedules & { set(eventId: string, s: EventSchedule): Promise<void> };
  clock: Clock;
  admit(pid: string, eventId: string, hash: string): Promise<void>;
  /** 로비·묶음 표시를 쓴다(목록 고정) */
  closeList(eventId: string, field: 'lobby' | '1', marker: string): Promise<void>;
  lobbyMembers(eventId: string): Promise<string[]>;
  batchMembers(eventId: string): Promise<string[]>;
  dupValue(pid: string, eventId: string): Promise<string | null>;
  setDup(pid: string, eventId: string, value: string): Promise<void>;
  verifyOf(eventId: string, hash: string): Promise<string | null>;
  setVerify(eventId: string, hash: string, value: string): Promise<void>;
  removed(eventId: string, seq: number): Promise<boolean>;
  /** 결과 키(q:lobby·q:batch) */
  setResult(tokenHash: string, group: 'lobby' | 1, seq: number, gen: number): Promise<void>;
  addSoon(eventId: string, hash: string, seq: number): Promise<void>;
  /** 곧 입장 키 셋의 해시(soon, soon_at, soon_first 순) */
  soonOf(eventId: string): Promise<[string[], string[], string[]]>;
  /** batch_done의 칸 값 */
  markerOf(eventId: string, field: string): Promise<string | null>;
}

const PID2 = `${PID}x`;
const sealer = new TestSeedSealer(Buffer.alloc(32, 6));

export function leaveCases(name: string, setup: () => Promise<LeaveWorld>): void {
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e instanceof EntryError) return e.code;
      if (e instanceof QueueStoreUnavailable) return 'STORE_DOWN';
      throw e;
    }
  };

  /** 줄에 선 사람(오픈이 지났고 묶음을 끈 회차) */
  async function queued(o: { pidPrev?: string; vr?: 'NETWORK' } = {}) {
    const w = await setup();
    const eventId = newEvent();
    const now = w.clock.now();
    const schedule = openSchedule(now, { lobbyShuffle: false, openBatch: true, batchWindowMs: 1 });
    await w.schedules.set(eventId, schedule);
    await w.closeList(eventId, '1', '1:0:1');
    const enter = new EnterQueue(w.store, w.schedules, tokens, w.clock, DEFAULT_ENTRY_OPTIONS);
    const enterAs = async (rq: string, pid = PID, pidPrev = o.pidPrev) =>
      (await enter.run({ accountId: ACCOUNT, sessionId: 's', pid, ...(pidPrev ? { pidPrev } : {}), eventId, body: { preverifyToken: preverifyToken(w.clock, eventId, o.vr ? { vr: o.vr } : {}), deviceId: DEVICE, entryRequestId: rq } })) as EnterResult;
    const join = (pid = PID, pidPrev = o.pidPrev) => enterAs(newRequest(), pid, pidPrev);
    const leave = new LeaveQueue(w.store, w.schedules);
    return { w, eventId, schedule, join, enterAs, leave };
  }

  /** 로비 참가자(오픈 5분 전) */
  async function inLobby(o: { verdict?: Parameters<typeof recordingRisk>[0] } = {}) {
    const w = await setup();
    const eventId = newEvent();
    const now = w.clock.now();
    const schedule: EventSchedule = { opensAtMs: now + 5 * 60_000, startsAtMs: now + 3 * 24 * 3600_000, lobbyShuffle: true, openBatch: true, lobbyMinutes: 10 };
    await w.schedules.set(eventId, schedule);
    const app = new JoinLobby(w.store, w.schedules, tokens, recordingRisk(o.verdict ?? { kind: 'OK' }), new ShuffleCommits(w.commits, sealer, w.schedules, w.clock), w.clock);
    const join = (i: { pid?: string; pidPrev?: string } = {}) => app.run({ eventId, accountId: ACCOUNT, pid: i.pid ?? PID, ...(i.pidPrev ? { pidPrev: i.pidPrev } : {}), body: { humanCheckToken: 'ok', deviceId: DEVICE } });
    const leave = new LeaveQueue(w.store, w.schedules);
    return { w, eventId, schedule, join, leave };
  }

  /** 묶음 참가자(묶음 구간 안) */
  async function inBatch() {
    const w = await setup();
    const eventId = newEvent();
    const now = w.clock.now();
    await w.schedules.set(eventId, openSchedule(now, { opensAtMs: now - 1_000, lobbyShuffle: false, openBatch: true, batchWindowMs: 60_000 }));
    const enter = new EnterQueue(w.store, w.schedules, tokens, w.clock, DEFAULT_ENTRY_OPTIONS);
    const pre = preverifyToken(w.clock, eventId, { i0: now - 60_000 });
    const rq = newRequest();
    const send = (token: string, requestId: string) => enter.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { preverifyToken: token, deviceId: DEVICE, entryRequestId: requestId } });
    const r = await send(pre, rq);
    expect(r.kind).toBe('BATCHING');
    return { w, eventId, hash: tokens.hash(pre), rq, leave: new LeaveQueue(w.store, w.schedules), again: () => send(pre, rq), fresh: () => send(preverifyToken(w.clock, eventId, { i0: now - 50_000 }), newRequest()) };
  }

  /** 첫 호출의 사람 키 바꾸기 직전에 일을 끼운다(읽은 뒤 값이 바뀐 것을 흉내 낸다) */
  const beforeFirstSwap = (store: EntryStore, act: () => Promise<void>): EntryStore => {
    let done = false;
    return new Proxy(store, {
      get(target, k) {
        const f = Reflect.get(target, k) as unknown;
        if (typeof f !== 'function') return f;
        if (k !== 'swapHeld') return (f as (...x: unknown[]) => unknown).bind(target);
        return async (...args: unknown[]) => {
          if (!done) {
            done = true;
            await act();
          }
          return (f as (...x: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    });
  };

  test(`[${name}] Q-T68① 로비 참가를 취소하면 목록·추가 검증 기록·사람 키에서 빠지고 다시 참가하면 새 토큰이다`, async () => {
    const a = await inLobby({ verdict: { kind: 'VERIFY', reason: 'NETWORK' } });
    const first = await a.join();
    const hash = tokens.hash(first.lobbyToken);
    expect(await a.w.verifyOf(a.eventId, hash)).toMatch(/^VERIFYING:/);
    await a.leave.lobby({ eventId: a.eventId, pid: PID });
    expect(await a.w.lobbyMembers(a.eventId)).toEqual([]);
    expect(await a.w.verifyOf(a.eventId, hash)).toBeNull();
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
    const again = await a.join();
    expect(again.lobbyToken).not.toBe(first.lobbyToken);
    expect(await a.w.lobbyMembers(a.eventId)).toEqual([tokens.hash(again.lobbyToken)]);
  });

  test(`[${name}] Q-T52⑤ Q-T68② [ASVS v5.0.0-15.4.2] 표시가 선 뒤의 로비 참가 취소는 409이고 목록·사람 키가 그대로다`, async () => {
    const a = await inLobby();
    const t = await a.join();
    await a.w.closeList(a.eventId, 'lobby', '1:1:1');
    const before = await a.w.dupValue(PID, a.eventId);
    expect(await code(a.leave.lobby({ eventId: a.eventId, pid: PID }))).toBe('LOBBY_CLOSED');
    expect(await a.w.lobbyMembers(a.eventId)).toEqual([tokens.hash(t.lobbyToken)]);
    expect(await a.w.dupValue(PID, a.eventId)).toBe(before);
    expect(await a.w.verifyOf(a.eventId, tokens.hash(t.lobbyToken))).toBeNull();
  });

  test(`[${name}] Q-T52⑤ 서버 시각이 오픈을 지났으면 표시가 없어도 로비 참가 취소는 409다`, async () => {
    const a = await inLobby();
    await a.join();
    const now = a.w.clock.now();
    const late = new LeaveQueue(a.w.store, { get: async () => ({ ...a.schedule, opensAtMs: now - 1_000 }) });
    expect(await code(late.lobby({ eventId: a.eventId, pid: PID }))).toBe('LOBBY_CLOSED');
    expect(await a.w.lobbyMembers(a.eventId)).toHaveLength(1);
  });

  test(`[${name}] Q-T68② 표시가 선 뒤의 대기 취소는 목록을 바꾸지 않고 주인 없는 자리로 적고, 게시 뒤면 그 번호를 돌리고 곧 입장 대기열에서 뺀다`, async () => {
    const a = await inLobby({ verdict: { kind: 'VERIFY', reason: 'NETWORK' } });
    const t = await a.join();
    const hash = tokens.hash(t.lobbyToken);
    await a.w.closeList(a.eventId, 'lobby', '1:1:1');
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.lobbyMembers(a.eventId)).toEqual([hash]);
    expect(await a.w.verifyOf(a.eventId, hash)).toMatch(/^ORPHAN:\d+$/);
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
    expect(await a.w.removed(a.eventId, 1)).toBe(false);

    const b = await inLobby();
    const u = await b.join();
    const h = tokens.hash(u.lobbyToken);
    await b.w.closeList(b.eventId, 'lobby', '7:1:1');
    await b.w.setResult(h, 'lobby', 7, 1);
    await b.w.addSoon(b.eventId, h, 7);
    await b.leave.entry({ eventId: b.eventId, pid: PID });
    expect(await b.w.removed(b.eventId, 7)).toBe(true);
    expect(await b.w.soonOf(b.eventId)).toEqual([[], [], []]);
    expect(await b.w.lobbyMembers(b.eventId)).toEqual([h]);
    expect(await b.w.dupValue(PID, b.eventId)).toMatch(/^LEFT:/);
  });

  test(`[${name}] Q-T35② Q-T68③ 대기를 취소하면 번호가 빠진 번호가 되고 사람 키가 지워져 다시 진입하면 맨 뒤 번호다`, async () => {
    const a = await queued();
    const first = await a.join();
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.removed(a.eventId, first.seq)).toBe(true);
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
    expect((await a.join()).seq).toBe(first.seq + 1);
  });

  test(`[${name}] Q-T68③ 번호를 돌릴 때 곧 입장 대기열 셋과 추가 검증 칸에서 뺀다`, async () => {
    const a = await queued({ vr: 'NETWORK' });
    const t = await a.join();
    const hash = tokens.hash(t.queueTicket);
    expect(await a.w.verifyOf(a.eventId, hash)).toMatch(/^VERIFYING:/);
    await a.w.addSoon(a.eventId, hash, t.seq);
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.verifyOf(a.eventId, hash)).toBeNull();
    expect(await a.w.soonOf(a.eventId)).toEqual([[], [], []]);
  });

  test(`[${name}] Q-T34⑦ Q-T68③ 통과한 대기표를 취소하면 PASSED를 지우고 BLOCKED는 그대로 둔다`, async () => {
    const a = await queued();
    const t = await a.join();
    const hash = tokens.hash(t.queueTicket);
    await a.w.setVerify(a.eventId, hash, 'PASSED:1');
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.verifyOf(a.eventId, hash)).toBeNull();
    const b = await queued();
    const u = await b.join();
    const h = tokens.hash(u.queueTicket);
    await b.w.setVerify(b.eventId, h, 'BLOCKED:1');
    await b.leave.entry({ eventId: b.eventId, pid: PID });
    expect(await b.w.verifyOf(b.eventId, h)).toBe('BLOCKED:1');
  });

  test(`[${name}] Q-T68③ 해시가 없는 옛 번호 기록도 번호를 돌리고 사람 키를 지운다`, async () => {
    const a = await queued();
    await a.w.setDup(PID, a.eventId, '42:1:rq-old:jny:');
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.removed(a.eventId, 42)).toBe(true);
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
  });

  test(`[${name}] Q-T68④ 구간이 닫히기 전의 묶음 기록을 취소하면 목록에서 빠진다`, async () => {
    const a = await inBatch();
    expect(await a.w.batchMembers(a.eventId)).toEqual([a.hash]);
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.batchMembers(a.eventId)).toEqual([]);
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
  });

  test(`[${name}] Q-T68④ 구간이 닫힌 뒤의 취소는 목록을 바꾸지 않고, 게시 뒤면 번호를 돌린다`, async () => {
    const a = await inBatch();
    await a.w.closeList(a.eventId, '1', '5:1:1');
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.batchMembers(a.eventId)).toEqual([a.hash]);
    expect(await a.w.verifyOf(a.eventId, a.hash)).toMatch(/^ORPHAN:\d+$/);
    expect(await a.w.removed(a.eventId, 5)).toBe(false);

    const b = await inBatch();
    await b.w.closeList(b.eventId, '1', '5:1:1');
    await b.w.setResult(b.hash, 1, 5, 1);
    await b.leave.entry({ eventId: b.eventId, pid: PID });
    expect(await b.w.removed(b.eventId, 5)).toBe(true);
    expect(await b.w.dupValue(PID, b.eventId)).toMatch(/^LEFT:/);
  });

  test(`[${name}] Q-T68⑦ [ASVS v5.0.0-15.4.2] 표시를 쓴 뒤 게시가 결과 키를 쓰면 취소가 그 결과를 읽어 번호를 돌린다`, async () => {
    const a = await inBatch();
    await a.w.closeList(a.eventId, '1', '5:1:1');
    const racing = new Proxy(a.w.store, {
      get(target, k) {
        const f = Reflect.get(target, k) as unknown;
        if (k !== 'leaveMember' || typeof f !== 'function') return typeof f === 'function' ? (f as (...x: unknown[]) => unknown).bind(target) : f;
        return async (...args: unknown[]) => {
          const r = await (f as (...x: unknown[]) => Promise<unknown>).apply(target, args);
          await a.w.setResult(a.hash, 1, 5, 1);
          return r;
        };
      },
    });
    await new LeaveQueue(racing, a.w.schedules).entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.removed(a.eventId, 5)).toBe(true);
  });

  test(`[${name}] Q-T68⑤ Q-T45 두 pid 키로 줄을 서면 대기 취소가 두 키를 모두 지우고 번호는 한 번만 돌린다`, async () => {
    const a = await queued({ pidPrev: PID2 });
    const t = await a.join();
    expect(await a.w.dupValue(PID2, a.eventId)).not.toBeNull();
    let turned = 0;
    const counting = new Proxy(a.w.store, {
      get(target, k) {
        const f = Reflect.get(target, k) as unknown;
        if (typeof f !== 'function') return f;
        if (k === 'leaveNumber') turned++;
        return (f as (...x: unknown[]) => unknown).bind(target);
      },
    });
    await new LeaveQueue(counting, a.w.schedules).entry({ eventId: a.eventId, pid: PID, pidPrev: PID2 });
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
    expect(await a.w.dupValue(PID2, a.eventId)).toMatch(/^LEFT:/);
    expect(await a.w.removed(a.eventId, t.seq)).toBe(true);
    expect(turned).toBe(1);
  });

  test(`[${name}] Q-T68⑩ 구간이 닫히기 전에 취소한 묶음의 같은 요청 ID 재전송은 새 번호 없이 취소됨이다`, async () => {
    const a = await inBatch();
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await code(a.again())).toBe('ENTRY_CANCELLED');
    expect(await a.w.batchMembers(a.eventId)).toEqual([]);
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
  });

  test(`[${name}] Q-T68⑩ 구간이 닫힌 뒤 취소한 묶음의 같은 요청 ID 재전송도 게시 뒤 새 번호를 받지 않는다`, async () => {
    const a = await inBatch();
    await a.w.closeList(a.eventId, '1', '5:1:1');
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    await a.w.setResult(a.hash, 1, 5, 1);
    expect(await code(a.again())).toBe('ENTRY_CANCELLED');
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
  });

  test(`[${name}] Q-T68⑩ 취소 뒤 새 요청 ID의 다시 참가는 지나가고, 그 뒤 처음 기기의 재전송은 409다`, async () => {
    const a = await inBatch();
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect((await a.fresh()).kind).toBe('BATCHING');
    expect(await code(a.again())).toBe('ALREADY_WAITING');
  });

  test(`[${name}] Q-T68⑩ Q-T35② 번호 기록을 취소한 뒤 같은 요청 ID로 다시 오면 새 번호 없이 취소됨이고, 새 요청 ID는 맨 뒤 번호다`, async () => {
    const a = await queued();
    const rq = newRequest();
    const first = await a.enterAs(rq);
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await code(a.enterAs(rq))).toBe('ENTRY_CANCELLED');
    expect((await a.join()).seq).toBe(first.seq + 1);
  });

  test(`[${name}] Q-T68⑩ 다른 요청의 취소 끝 표지는 빈 키와 같아 기록이 지나가고, 같은 요청의 늦은 기록은 막는다`, async () => {
    const a = await queued();
    const rq = newRequest();
    await a.enterAs(rq);
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    const base = { pid: PID, eventId: a.eventId, seq: 9, gen: 1, jny: 'j', expireAtMs: a.w.clock.now() + 60_000 };
    expect(await a.w.store.record({ ...base, requestId: rq })).toEqual({ kind: 'TAKEN' });
    expect(await a.w.store.batchRecord({ pid: PID, eventId: a.eventId, requestId: rq, tokenHash: 'ab', jny: 'j', expireAtMs: base.expireAtMs })).toEqual({ kind: 'TAKEN' });
    expect(await a.w.store.record({ ...base, requestId: newRequest() })).toEqual({ kind: 'RECORDED' });
  });

  test(`[${name}] Q-T68⑩ Q-T45 두 pid 키에서도 취소한 요청 ID의 재전송은 취소됨이다`, async () => {
    const a = await queued({ pidPrev: PID2 });
    const rq = newRequest();
    await a.enterAs(rq);
    await a.leave.entry({ eventId: a.eventId, pid: PID, pidPrev: PID2 });
    expect(await code(a.enterAs(rq))).toBe('ENTRY_CANCELLED');
  });

  test(`[${name}] Q-T68⑩ Q-T16 취소한 요청 ID로는 도착 시각 칸을 다시 받지 못하고, 새 요청 ID는 쿠키를 다시 쓰지 못해 맨 뒤다`, async () => {
    const a = await queued();
    const now = a.w.clock.now();
    const seen: string[] = [];
    const arrivals = { read: () => ({ kid: 'k', e: a.eventId, t: now - 1_000, rid: `cf-${a.eventId}`, sid: 's' }) };
    const signals = { cookie: (r: string) => void seen.push(r), number: () => undefined };
    const enter = new EnterQueue(a.w.store, a.w.schedules, tokens, a.w.clock, { ...DEFAULT_ENTRY_OPTIONS, arrivalSlotInitial: 10 }, undefined, arrivals, signals);
    const send = (rq: string) => enter.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId: a.eventId, arrivalCookie: 'c', body: { preverifyToken: preverifyToken(a.w.clock, a.eventId), deviceId: DEVICE, entryRequestId: rq } });
    const rq = newRequest();
    const first = (await send(rq)) as EnterResult;
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await code(send(rq))).toBe('ENTRY_CANCELLED');
    const again = (await send(newRequest())) as EnterResult;
    expect(again.seq).toBeGreaterThan(first.seq);
    expect(seen).toEqual(['ok', 'reused']);
  });

  test(`[${name}] Q-T68④ 취소와 묶음→번호 변환이 겹치면 다시 읽어 번호 기록을 취소한다`, async () => {
    const a = await inBatch();
    await a.w.closeList(a.eventId, '1', '5:1:1');
    await a.w.setResult(a.hash, 1, 5, 1);
    const converting = beforeFirstSwap(a.w.store, () => a.w.setDup(PID, a.eventId, `5:1:${a.rq}:jny::${'ab'.repeat(32)}`));
    await new LeaveQueue(converting, a.w.schedules).entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.removed(a.eventId, 5)).toBe(true);
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
  });

  test(`[${name}] Q-T68⑨ [ASVS v5.0.0-15.4.2] 읽은 뒤 같은 토큰으로 다시 참가했으면 늦은 취소가 목록에서 빼지 않는다`, async () => {
    const a = await inBatch();
    const rejoined = `BATCH:1:${a.hash}:rq-new:jny:`;
    const late = beforeFirstSwap(a.w.store, () => a.w.setDup(PID, a.eventId, rejoined));
    await new LeaveQueue(late, a.w.schedules).entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.batchMembers(a.eventId)).toEqual([a.hash]);
    expect(await a.w.dupValue(PID, a.eventId)).toBe(rejoined);
  });

  test(`[${name}] Q-T68⑨ [ASVS v5.0.0-15.4.2] 번호 기록 뒤 취소가 끝나면 추가 검증 표시를 되살리지 않는다`, async () => {
    const w = await setup();
    const eventId = newEvent();
    await w.schedules.set(eventId, openSchedule(w.clock.now(), { lobbyShuffle: false, openBatch: true, batchWindowMs: 1 }));
    await w.closeList(eventId, '1', '1:0:1');
    const leave = new LeaveQueue(w.store, w.schedules);
    let hash = '';
    const racing = new Proxy(w.store, {
      get(target, k) {
        const f = Reflect.get(target, k) as unknown;
        if (typeof f !== 'function') return f;
        if (k !== 'markVerifying') return (f as (...x: unknown[]) => unknown).bind(target);
        return async (i: { ticketHash: string }) => {
          hash = i.ticketHash;
          await leave.entry({ eventId, pid: PID });
          return (f as (...x: unknown[]) => Promise<unknown>).call(target, i);
        };
      },
    });
    const enter = new EnterQueue(racing, w.schedules, tokens, w.clock, DEFAULT_ENTRY_OPTIONS);
    expect(await code(enter.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { preverifyToken: preverifyToken(w.clock, eventId, { vr: 'NETWORK' }), deviceId: DEVICE, entryRequestId: newRequest() } }))).toBe('ENTRY_CANCELLED');
    expect(hash).not.toBe('');
    expect(await w.verifyOf(eventId, hash)).toBeNull();
  });

  test(`[${name}] Q-T68② 목록을 고정한 뒤의 취소는 차단 사유(BLOCKED)를 덮지 않는다`, async () => {
    const a = await inLobby();
    const t = await a.join();
    const h = tokens.hash(t.lobbyToken);
    await a.w.setVerify(a.eventId, h, 'BLOCKED:1:NETWORK');
    await a.w.closeList(a.eventId, 'lobby', '1:1:1');
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.verifyOf(a.eventId, h)).toBe('BLOCKED:1:NETWORK');
  });

  test(`[${name}] Q-T68④ 구간이 닫힌 뒤의 취소는 표시를 batch_done에 남겨 게시가 ORPHAN이 있는지 한 번에 안다`, async () => {
    const a = await inBatch();
    await a.w.closeList(a.eventId, '1', '5:1:1');
    expect(await a.w.markerOf(a.eventId, 'orphan:1')).toBeNull();
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.markerOf(a.eventId, 'orphan:1')).not.toBeNull();
  });

  test(`[${name}] Q-T68⑤ Q-T45 두 pid 키의 로비 참가 취소도 두 키를 모두 지운다`, async () => {
    const a = await inLobby();
    await a.join({ pidPrev: PID2 });
    await a.leave.lobby({ eventId: a.eventId, pid: PID, pidPrev: PID2 });
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
    expect(await a.w.dupValue(PID2, a.eventId)).toMatch(/^LEFT:/);
    expect(await a.w.lobbyMembers(a.eventId)).toEqual([]);
  });

  test(`[${name}] Q-T68⑥ 줄에 없으면 대기 취소는 아무것도 바꾸지 않고, 로비 참가 취소는 404다`, async () => {
    const a = await queued();
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.dupValue(PID, a.eventId)).toBeNull();
    const b = await inLobby();
    expect(await code(b.leave.lobby({ eventId: b.eventId, pid: PID }))).toBe('LOBBY_PARTICIPANT_NOT_FOUND');
  });

  test(`[${name}] Q-T68⑥ 선점 값(PENDING)은 그대로 둔다`, async () => {
    const a = await queued();
    await a.w.setDup(PID, a.eventId, 'PENDING:rq-1');
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.dupValue(PID, a.eventId)).toBe('PENDING:rq-1');
  });

  test(`[${name}] Q-T68⑥ 번호 기록만 있는 사람의 로비 참가 취소는 404이고 기록이 그대로다`, async () => {
    const a = await inLobby();
    await a.w.setDup(PID, a.eventId, '42:1:rq-old:jny:');
    expect(await code(a.leave.lobby({ eventId: a.eventId, pid: PID }))).toBe('LOBBY_PARTICIPANT_NOT_FOUND');
    expect(await a.w.dupValue(PID, a.eventId)).toBe('42:1:rq-old:jny:');
  });

  test(`[${name}] Q-T68⑥ 이미 입장한 사람의 대기 취소는 입장 이력을 지우지 않아 다시 진입하면 409다`, async () => {
    const a = await queued();
    await a.w.admit(PID, a.eventId, 'h');
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await code(a.join())).toBe('ALREADY_ADMITTED');
  });

  test(`[${name}] Q-T68⑥ 없는 회차는 NOT_FOUND이고, 로비를 켜지 않은 회차의 로비 참가 취소도 NOT_FOUND다`, async () => {
    const a = await queued();
    expect(await code(a.leave.entry({ eventId: 'no-such-event', pid: PID }))).toBe('NOT_FOUND');
    expect(await code(a.leave.lobby({ eventId: a.eventId, pid: PID }))).toBe('NOT_FOUND');
  });

  test(`[${name}] Q-T68⑧ [ASVS v5.0.0-16.5.2] 회차 슬롯의 일이 실패하면 사람 키를 지우지 않고, 다시 보내면 끝난다`, async () => {
    const a = await queued();
    const t = await a.join();
    let down = true;
    const flaky = new Proxy(a.w.store, {
      get(target, k) {
        const f = Reflect.get(target, k) as unknown;
        if (typeof f !== 'function') return f;
        return (...args: unknown[]) => (k === 'leaveNumber' && down ? Promise.reject(new QueueStoreUnavailable(new Error('down'))) : (f as (...x: unknown[]) => unknown).apply(target, args));
      },
    });
    const app = new LeaveQueue(flaky, a.w.schedules);
    expect(await code(app.entry({ eventId: a.eventId, pid: PID }))).toBe('STORE_DOWN');
    expect(await a.w.dupValue(PID, a.eventId)).not.toBeNull();
    down = false;
    await app.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.removed(a.eventId, t.seq)).toBe(true);
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
  });

  test(`[${name}] Q-T68⑧ [ASVS v5.0.0-16.5.2] 사람 키를 지우다 실패해도 번호는 돌렸고, 다시 보내면 사람 키가 지워진다`, async () => {
    const a = await queued();
    const t = await a.join();
    let down = true;
    const flaky = new Proxy(a.w.store, {
      get(target, k) {
        const f = Reflect.get(target, k) as unknown;
        if (typeof f !== 'function') return f;
        return (...args: unknown[]) => (k === 'swapHeld' && (args[0] as { to: string }).to.startsWith('LEFT:') && down ? Promise.reject(new QueueStoreUnavailable(new Error('down'))) : (f as (...x: unknown[]) => unknown).apply(target, args));
      },
    });
    const app = new LeaveQueue(flaky, a.w.schedules);
    expect(await code(app.entry({ eventId: a.eventId, pid: PID }))).toBe('STORE_DOWN');
    expect(await a.w.removed(a.eventId, t.seq)).toBe(true);
    expect(await a.w.dupValue(PID, a.eventId)).not.toBeNull();
    down = false;
    await app.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LEFT:/);
  });

  test(`[${name}] Q-T68⑨ [ASVS v5.0.0-8.2.2] 호출한 사람의 참가만 취소하고 다른 사람의 기록은 그대로다`, async () => {
    const a = await queued();
    const mine = await a.join();
    const other = await a.join(PID2, undefined);
    await a.leave.entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.removed(a.eventId, mine.seq)).toBe(true);
    expect(await a.w.removed(a.eventId, other.seq)).toBe(false);
    expect(await a.w.dupValue(PID2, a.eventId)).toMatch(new RegExp(`^${other.seq}:`));
  });

  test(`[${name}] Q-T68⑨ [ASVS v5.0.0-15.4.2] 읽은 뒤 그 사람이 다시 참가했으면 새 기록을 지우지 않는다`, async () => {
    const a = await queued();
    await a.join();
    const racing = beforeFirstSwap(a.w.store, () => a.w.setDup(PID, a.eventId, '99:1:rq-new:jny:'));
    await new LeaveQueue(racing, a.w.schedules).entry({ eventId: a.eventId, pid: PID });
    expect(await a.w.dupValue(PID, a.eventId)).toBe('99:1:rq-new:jny:');
  });
}
