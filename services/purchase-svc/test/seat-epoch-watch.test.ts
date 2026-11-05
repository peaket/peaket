// 세대 올리기 감시(SeatEpochWatch, BUILD_ORDER PRF-168, docs/features/seat-hold.md §6 '세대 올리기 감시의 첫 구현'·'세대 올리기(장애 조치 뒤)',
// ADR-0121 결정 5, S-T26 ①②, docs/security/asvs/seat-hold.md 15.4.1·16.5.2·16.2.5). 릴레이 프로세스의 Lease 리더가 1초 [가정]마다 회차 목록(s:ctl:events)의
// 회차마다 세대 올리기(bumpEpoch)를 부르고, BUMPED면 info 한 줄과 seat_epoch_bumps_total을 올린다.
// 회차 목록·세대 올리기·리더 확인·로그·지표는 시험 안의 메모리 대역이고(마지막 묶음은 MemorySeatStore와 함께), 쉬기는 deps.sleep을 바꿔 끼워 손으로 푼다(고정 sleep 없음).
// 클러스터 승격은 S-T26 측정(kind·실제 클러스터)의 몫이라 여기서는 MemorySeatStore.setNodeId로 표지를 바꿔 흉내 낸다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { EPOCH_WATCH_TICK_MS, MemorySeatStore, SeatEpochWatch, type SeatEpochWatchDeps, SeatStoreUnavailable } from '../src/modules/inventory/index.js';

const NOW = Date.parse('2026-11-05T03:00:00.000Z');
const NOW_SEC = Math.floor(NOW / 1000);
const DAY = 86_400_000;
const EV_A = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const EV_B = '0190f3a1-7c2e-7a00-8000-0000000000e2';
const EV_C = '0190f3a1-7c2e-7a00-8000-0000000000e3';
const EV_D = '0190f3a1-7c2e-7a00-8000-0000000000e4';
/** 승격된 복제본의 표지(클러스터 모양 '{CLUSTER MYID}:{cluster_my_epoch}' 흉내) */
const PROMOTED = '9f3c0e7a1b2d4c5e6f708192a3b4c5d6e7f80912:7';

type BumpResult = Awaited<ReturnType<SeatEpochWatchDeps['store']['bumpEpoch']>>;
/** bumps = 세대 키에 적힌 올린 누적 수(쓰는 Lua와 세대 올리기 Lua가 올릴 때 1씩 더한다, PRF-168 리뷰 고침 중간 1) */
const SAME = (epoch = 1_700_000_000, bumps = 0): BumpResult => ({ result: 'SAME', epoch, bumps });
const BUMPED = (epoch = 1_700_000_001, bumps = 1): BumpResult => ({ result: 'BUMPED', epoch, bumps });
const NOT_READY: BumpResult = { result: 'NOT_READY' };

/** 미뤄 둔 약속 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
/** 지금 쌓인 약속 작업을 한 바퀴 돌린다(시간을 기다리지 않는다) */
const flush = () => new Promise<void>((r) => setImmediate(r));
/** 조건이 설 때까지 쌓인 작업을 한 바퀴씩 돌린다(400바퀴까지) */
async function settle(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await flush();
}

/** 이름이 있는 오류(글에는 로그에 나가면 안 되는 값을 싣는다) */
const named = (name: string, message: string) => Object.assign(new Error(message), { name });

/** 메모리 조립 하나. 대역은 호출을 차례로 적고(log), fail로 실패를, wait로 잠시 붙잡기를 끼운다 */
function world(events: string[] = []) {
  const state = { leader: true, events: [...events] };
  /** 회차마다 bumpEpoch가 돌려줄 값(없으면 SAME()) 또는 던질 오류 */
  const results = new Map<string, BumpResult | Error>();
  const fail: { list?: Error; leader?: () => Error | undefined } = {};
  const wait: { list?: () => Promise<void>; bump?: (eventId: string) => Promise<void> } = {};
  const log: string[] = [];
  /** epochBumped는 받은 n의 합, epochBumpedArgs는 받은 n들(부른 차례) */
  const calls = { leader: 0, list: 0, bump: [] as string[], epochBumped: 0, epochBumpedArgs: [] as number[] };
  const warns: { obj: Record<string, unknown>; msg: string }[] = [];
  const infos: { obj: Record<string, unknown>; msg: string }[] = [];
  const logger = {
    warn: (obj: object, msg: string) => void warns.push({ obj: obj as Record<string, unknown>, msg }),
    info: (obj: object, msg: string) => void infos.push({ obj: obj as Record<string, unknown>, msg }),
  };
  const signals = {
    epochBumped: (n: number) => {
      calls.epochBumped += n;
      calls.epochBumpedArgs.push(n);
    },
  };
  /** 손으로 푸는 쉬기. signal이 끊으면 바로 풀린다(던지지 않는다) */
  const sleeps: { ms: number; signal: AbortSignal; done: boolean; release: () => void }[] = [];
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      log.push(`sleep ${ms}`);
      const s = {
        ms,
        signal,
        done: false,
        release: () => {
          if (s.done) return;
          s.done = true;
          resolve();
        },
      };
      sleeps.push(s);
      if (signal?.aborted) s.release();
      else signal?.addEventListener('abort', () => s.release(), { once: true });
    });
  const deps: SeatEpochWatchDeps = {
    store: {
      saleEvents: async () => {
        calls.list += 1;
        log.push('list');
        await wait.list?.();
        if (fail.list) throw fail.list;
        return [...state.events];
      },
      bumpEpoch: async (eventId: string) => {
        calls.bump.push(eventId);
        log.push(`bump ${eventId}`);
        await wait.bump?.(eventId);
        const r = results.get(eventId) ?? SAME();
        log.push(`bump-done ${eventId}`);
        if (r instanceof Error) throw r;
        return r;
      },
    },
    leader: {
      isLeader: () => {
        calls.leader += 1;
        const x = fail.leader?.();
        if (x) throw x;
        return state.leader;
      },
    },
    logger,
    signals,
    sleep,
  };
  const watch = (over: Partial<SeatEpochWatchDeps> = {}) => new SeatEpochWatch({ ...deps, ...over });
  const pendingSleeps = () => sleeps.filter((s) => !s.done);
  const logText = () => [...warns, ...infos].map((l) => `${JSON.stringify(l.obj)} ${l.msg}`).join('\n');
  return { state, results, fail, wait, log, calls, warns, infos, logger, signals, sleeps, sleep, deps, watch, pendingSleeps, logText };
}

/** start 뒤 조건이 설 때까지 돌린다. 그사이 걸린 쉬기는 하나씩 풀어 준다(첫 틱 전에 쉬는 구현도 받는다) */
async function runUntil(w: ReturnType<typeof world>, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) {
    await settle(() => ok() || w.pendingSleeps().length > 0);
    if (ok()) return;
    w.pendingSleeps()[0]?.release();
  }
}

describe('SeatEpochWatch.tick: 리더와 회차', () => {
  test('ST26_리더가 아니면 회차 목록·세대 올리기 어느 것도 부르지 않고 { skipped: not_leader }다 [S-T26] [ASVS v5.0.0-15.4.1]', async () => {
    const w = world([EV_A]);
    w.state.leader = false;
    await expect(w.watch().tick()).resolves.toEqual({ skipped: 'not_leader' });
    expect(w.calls.leader).toBeGreaterThanOrEqual(1);
    expect(w.calls.list).toBe(0);
    expect(w.calls.bump).toEqual([]);
    expect(w.calls.epochBumped).toBe(0);
  });

  test('ST26_리더 확인이 던지면 리더가 아닌 것으로 본다: 아무것도 부르지 않고 { skipped: not_leader }, 경고 한 줄(오류 이름만)이며 tick은 던지지 않는다 [S-T26] [ASVS v5.0.0-15.4.1] [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world([EV_A]);
    w.fail.leader = () => named('LeaseApiError', 'GET https://kube-apiserver/apis/coordination.k8s.io token=SECRET-L');
    await expect(w.watch().tick()).resolves.toEqual({ skipped: 'not_leader' });
    expect(w.calls.list).toBe(0);
    expect(w.calls.bump).toEqual([]);
    expect(w.warns).toHaveLength(1);
    expect(Object.values(w.warns[0]!.obj)).toContain('LeaseApiError');
    for (const s of ['SECRET-L', 'kube-apiserver']) expect(w.logText(), s).not.toContain(s);
  });

  test('ST26_회차 목록(s:ctl:events)의 회차마다 목록 차례로 bumpEpoch(회차)를 부른다. SAME은 넘기고 NOT_READY는 notReady, BUMPED는 bumped에 넣는다: { checked, bumped, notReady } [S-T26]', async () => {
    const w = world([EV_A, EV_B, EV_C, EV_D]);
    w.results.set(EV_A, SAME(1_700_000_000));
    w.results.set(EV_B, BUMPED(1_700_000_101));
    w.results.set(EV_C, NOT_READY);
    w.results.set(EV_D, BUMPED(1_700_000_201));
    await expect(w.watch().tick()).resolves.toEqual({ checked: 4, bumped: [EV_B, EV_D], notReady: [EV_C], failed: [] });
    expect(w.calls.list).toBe(1);
    expect(w.calls.bump).toEqual([EV_A, EV_B, EV_C, EV_D]);
  });

  test('ST26_회차는 하나씩 본다: 앞 회차의 bumpEpoch가 끝나기 전에 다음 회차를 부르지 않는다 [S-T26]', async () => {
    const w = world([EV_A, EV_B]);
    const gate = deferred();
    w.wait.bump = (id) => (id === EV_A ? gate.promise : Promise.resolve());
    const p = w.watch().tick();
    p.catch(() => undefined);
    await settle(() => w.calls.bump.length === 1);
    for (let i = 0; i < 10; i++) await flush();
    expect(w.calls.bump).toEqual([EV_A]);
    gate.resolve();
    await p;
    expect(w.log.filter((l) => l !== 'list')).toEqual([`bump ${EV_A}`, `bump-done ${EV_A}`, `bump ${EV_B}`, `bump-done ${EV_B}`]);
  });

  test('ST26_빈 회차 목록이면 bumpEpoch를 부르지 않고 { checked: 0, bumped: [], notReady: [], failed: [] }다', async () => {
    const w = world([]);
    await expect(w.watch().tick()).resolves.toEqual({ checked: 0, bumped: [], notReady: [], failed: [] });
    expect(w.calls.list).toBe(1);
    expect(w.calls.bump).toEqual([]);
  });

  test('ST26_멈춤 신호: tick(signal) 도중 signal이 끊기면 돌던 회차는 마치고 남은 회차는 보지 않으며 그때까지의 보고를 돌려준다 [S-T26]', async () => {
    const w = world([EV_A, EV_B, EV_C]);
    w.results.set(EV_A, BUMPED());
    const ac = new AbortController();
    w.wait.bump = async (id) => {
      if (id === EV_A) ac.abort();
    };
    await expect(w.watch().tick(ac.signal)).resolves.toEqual({ checked: 1, bumped: [EV_A], notReady: [], failed: [] });
    expect(w.calls.bump).toEqual([EV_A]);
  });
});

describe('SeatEpochWatch.tick: 로그·지표와 실패', () => {
  test('ST26_BUMPED는 회차마다 info 한 줄(kind seat-epoch-watch, 회차 ID·새 세대·올린 수)과 epochBumped(1) 한 번이다. SAME·NOT_READY는 로그·지표가 없다 [S-T26]', async () => {
    const w = world([EV_A, EV_B, EV_C]);
    w.results.set(EV_A, BUMPED(1_700_000_042));
    w.results.set(EV_B, SAME());
    w.results.set(EV_C, NOT_READY);
    await w.watch().tick();
    expect(w.calls.epochBumpedArgs).toEqual([1]);
    expect(w.infos).toHaveLength(1);
    expect(w.infos[0]!.obj).toEqual({ kind: 'seat-epoch-watch', eventId: EV_A, epoch: 1_700_000_042, bumps: 1 });
    expect(w.warns).toEqual([]);
  });

  test('ST26_회차 목록을 읽지 못하면(saleEvents가 던짐) 경고 한 줄(오류 이름만) 뒤 { skipped: store_failed }이고 bumpEpoch를 부르지 않는다 [S-T26] [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world([EV_A]);
    w.fail.list = named('SeatStoreUnavailable', 'connect ECONNREFUSED redis://user:SECRET-R@seat-redis:6379');
    await expect(w.watch().tick()).resolves.toEqual({ skipped: 'store_failed' });
    expect(w.calls.bump).toEqual([]);
    expect(w.warns).toHaveLength(1);
    expect(w.warns[0]!.obj).toMatchObject({ kind: 'seat-epoch-watch' });
    expect(Object.values(w.warns[0]!.obj)).toContain('SeatStoreUnavailable');
    for (const s of ['SECRET-R', 'redis://', 'ECONNREFUSED']) expect(w.logText(), s).not.toContain(s);
  });

  test('ST26_리뷰 고침 M1_ 한 회차의 세대 올리기가 던져도(그 샤드가 내려감) 남은 회차를 본다: 목록 [X(던짐), Y(BUMPED)]면 Y가 bumped에, X가 failed에 든다. tick은 던지지 않는다 [S-T26] [ASVS v5.0.0-16.5.2]', async () => {
    const w = world([EV_A, EV_B]);
    w.results.set(EV_A, named('SeatStoreUnavailable', 'redis://user:SECRET-A@seat-redis'));
    w.results.set(EV_B, BUMPED(1_700_000_101));
    await expect(w.watch().tick()).resolves.toEqual({ checked: 2, bumped: [EV_B], notReady: [], failed: [EV_A] });
    expect(w.calls.bump).toEqual([EV_A, EV_B]);
    expect(w.calls.epochBumped).toBe(1);
    expect(w.infos).toHaveLength(1);
    expect(w.infos[0]!.obj).toMatchObject({ kind: 'seat-epoch-watch', eventId: EV_B, epoch: 1_700_000_101 });
  });

  test('ST26_리뷰 고침 M1_ 세대 올리기 실패는 틱마다 경고 한 줄로 묶는다(실패 수, 첫 회차 ID, 오류 이름, 좌석 Lua 오류 코드). 오류 글·키 이름·주소는 싣지 않고, 앞뒤 회차의 결과는 그대로다 [S-T26] [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world([EV_A, EV_B, EV_C, EV_D]);
    w.results.set(EV_A, BUMPED());
    w.results.set(EV_B, new Error('ERR user_script:9: PEAKET_CORRUPT_KEY s:{event:0190f3a1-7c2e-7a00-8000-0000000000e2}:epoch'));
    w.results.set(EV_C, named('SeatStoreUnavailable', 'redis://user:SECRET-C@seat-redis'));
    w.results.set(EV_D, NOT_READY);
    await expect(w.watch().tick()).resolves.toEqual({ checked: 4, bumped: [EV_A], notReady: [EV_D], failed: [EV_B, EV_C] });
    expect(w.calls.bump).toEqual([EV_A, EV_B, EV_C, EV_D]);
    // 회차마다 경고가 쏟아지지 않는다(틱마다 한 줄)
    expect(w.warns).toHaveLength(1);
    expect(w.warns[0]!.obj).toEqual({ kind: 'seat-epoch-watch', failed: 2, eventId: EV_B, err: 'Error', code: 'CORRUPT_KEY' });
    for (const s of ['SECRET-C', 'redis://', 's:{event', 'user_script']) expect(w.logText(), s).not.toContain(s);
  });

  test('ST26_리뷰 고침 M1_ 첫 실패가 일시 장애(SeatStoreUnavailable)면 경고 줄에 좌석 Lua 오류 코드가 없다(일시 장애는 Lua 오류로 세지 않는다, seatLuaErrorOf) [S-T26] [ASVS v5.0.0-16.5.2]', async () => {
    const w = world([EV_A, EV_B]);
    w.results.set(EV_A, new SeatStoreUnavailable(new Error('connect ECONNREFUSED redis://user:SECRET-U@seat-redis')));
    w.results.set(EV_B, new SeatStoreUnavailable(new Error('down')));
    await expect(w.watch().tick()).resolves.toEqual({ checked: 2, bumped: [], notReady: [], failed: [EV_A, EV_B] });
    expect(w.warns).toHaveLength(1);
    expect(w.warns[0]!.obj).toEqual({ kind: 'seat-epoch-watch', failed: 2, eventId: EV_A, err: 'SeatStoreUnavailable' });
    for (const s of ['SECRET-U', 'redis://', 'ECONNREFUSED']) expect(w.logText(), s).not.toContain(s);
  });

  test('ST26_로거·지표가 없어도(선택 deps), logger.info가 없어도, 로거·지표가 던져도 보고는 그대로이고 tick은 던지지 않는다 [S-T26] [ASVS v5.0.0-16.5.2]', async () => {
    const w = world([EV_A, EV_B]);
    w.results.set(EV_A, BUMPED());
    const want = { checked: 2, bumped: [EV_A], notReady: [], failed: [] };
    const { logger: _l, signals: _s, ...bare } = w.deps;
    await expect(new SeatEpochWatch(bare).tick()).resolves.toEqual(want);
    await expect(w.watch({ logger: { warn: w.logger.warn } }).tick()).resolves.toEqual(want);
    const throwing = {
      logger: {
        warn: () => {
          throw new Error('log down');
        },
        info: () => {
          throw new Error('log down');
        },
      },
      signals: {
        epochBumped: () => {
          throw new Error('metrics down');
        },
      },
    };
    await expect(w.watch(throwing).tick()).resolves.toEqual(want);
    // 실패 경로(경고)에서 로거가 던져도 보고는 그대로다
    w.results.set(EV_B, new Error('down'));
    await expect(w.watch(throwing).tick()).resolves.toEqual({ checked: 2, bumped: [EV_A], notReady: [], failed: [EV_B] });
  });
});

describe('SeatEpochWatch: 쓰는 Lua가 올린 것도 센다(세대 키 bumps의 차이, PRF-168 리뷰 고침 중간 1, docs/observability.md seat_epoch_bumps_total)', () => {
  test('ST26_리뷰 고침 중간 1_ 쓰는 Lua가 올려 bumps가 지난번보다 커진 회차(결과는 SAME)는 그 차이만큼 epochBumped(n)과 info 한 줄(회차 ID·새 세대·올린 수)이다. bumped에는 넣지 않고(감시가 올린 것이 아니다), 같으면 다시 세지 않는다 [S-T26]', async () => {
    const w = world([EV_A, EV_B]);
    const watch = w.watch();
    w.results.set(EV_A, SAME(1_700_000_000, 0));
    w.results.set(EV_B, SAME(1_700_000_000, 4));
    await expect(watch.tick()).resolves.toEqual({ checked: 2, bumped: [], notReady: [], failed: [] });
    expect(w.calls.epochBumpedArgs).toEqual([]);

    // A는 홀드 Lua가 두 번 올렸다(장애 조치 두 번), B는 그대로
    w.results.set(EV_A, SAME(1_700_000_002, 2));
    await expect(watch.tick()).resolves.toEqual({ checked: 2, bumped: [], notReady: [], failed: [] });
    expect(w.calls.epochBumpedArgs).toEqual([2]);
    expect(w.infos.map((l) => l.obj)).toEqual([{ kind: 'seat-epoch-watch', eventId: EV_A, epoch: 1_700_000_002, bumps: 2 }]);

    await watch.tick();
    expect(w.calls.epochBumpedArgs).toEqual([2]);
    expect(w.infos).toHaveLength(1);
  });

  test('ST26_리뷰 고침 중간 1_ 처음 보는 회차는 BUMPED면 1로 세고 기준을 잡고, SAME이면 기준만 잡는다(앞서 다른 리더가 센 것을 다시 세지 않는다). 감시가 올린 BUMPED는 지난 기준과의 차이를 센다 [S-T26]', async () => {
    const w = world([EV_A, EV_B]);
    const watch = w.watch();
    w.results.set(EV_A, BUMPED(1_700_000_010, 5));
    w.results.set(EV_B, SAME(1_700_000_000, 7));
    await expect(watch.tick()).resolves.toEqual({ checked: 2, bumped: [EV_A], notReady: [], failed: [] });
    expect(w.calls.epochBumpedArgs).toEqual([1]);
    expect(w.infos.map((l) => l.obj)).toEqual([{ kind: 'seat-epoch-watch', eventId: EV_A, epoch: 1_700_000_010, bumps: 1 }]);

    // A: 감시가 다시 올림(5 → 6, 1), B: 쓰는 Lua가 두 번(7 → 9, 2)
    w.results.set(EV_A, BUMPED(1_700_000_011, 6));
    w.results.set(EV_B, SAME(1_700_000_002, 9));
    await watch.tick();
    expect(w.calls.epochBumpedArgs).toEqual([1, 1, 2]);
    expect(w.infos.slice(1).map((l) => l.obj)).toEqual([
      { kind: 'seat-epoch-watch', eventId: EV_A, epoch: 1_700_000_011, bumps: 1 },
      { kind: 'seat-epoch-watch', eventId: EV_B, epoch: 1_700_000_002, bumps: 2 },
    ]);
  });

  test('ST26_리뷰 고침 중간 1_ 리더가 바뀐 뒤에는 기준만 잡는다: 리더가 아닌 틱은 기억을 비우고, 다시 리더가 된 첫 확인(또는 새 프로세스)은 그사이 오른 bumps를 세지 않으며 그 뒤 오른 것만 센다 [S-T26] [ASVS v5.0.0-15.4.1]', async () => {
    const w = world([EV_A]);
    const watch = w.watch();
    w.results.set(EV_A, SAME(1_700_000_000, 0));
    await watch.tick();
    // 리더를 잃은 동안 다른 리더(와 쓰는 Lua)가 세 번 올렸다. 그 리더가 이미 셌다
    w.state.leader = false;
    await expect(watch.tick()).resolves.toEqual({ skipped: 'not_leader' });
    w.results.set(EV_A, SAME(1_700_000_003, 3));
    w.state.leader = true;
    await watch.tick();
    expect(w.calls.epochBumpedArgs).toEqual([]);
    w.results.set(EV_A, SAME(1_700_000_004, 4));
    await watch.tick();
    expect(w.calls.epochBumpedArgs).toEqual([1]);

    // 새 프로세스(새 감시)의 첫 확인도 기준만 잡는다
    const fresh = w.watch();
    w.results.set(EV_A, SAME(1_700_000_005, 5));
    await fresh.tick();
    expect(w.calls.epochBumpedArgs).toEqual([1]);
  });

  test('ST26_리뷰 고침 중간 1_ 회차 목록에서 빠진 회차·NOT_READY 회차는 기억에서 지운다(다시 나타나면 처음 보는 회차). bumps가 지난번보다 작으면(전체 유실 뒤 세대 키를 다시 씀) 기준을 다시 잡는다. 실패한 회차의 기준은 그대로다 [S-T26]', async () => {
    const w = world([EV_A, EV_B]);
    const watch = w.watch();
    w.results.set(EV_A, SAME(1_700_000_000, 1));
    w.results.set(EV_B, SAME(1_700_000_000, 2));
    await watch.tick();
    // A가 목록에서 빠졌다가 bumps 3으로 돌아온다 → 처음 보는 회차(세지 않음). B는 NOT_READY 뒤 bumps 0(다시 만든 세대 키)
    w.state.events = [EV_B];
    w.results.set(EV_B, NOT_READY);
    await watch.tick();
    w.state.events = [EV_A, EV_B];
    w.results.set(EV_A, SAME(1_700_000_001, 3));
    w.results.set(EV_B, SAME(1_700_000_009, 0));
    await watch.tick();
    expect(w.calls.epochBumpedArgs).toEqual([]);
    w.results.set(EV_B, SAME(1_700_000_010, 1));
    await watch.tick();
    expect(w.calls.epochBumpedArgs).toEqual([1]);

    // 지난번(3)보다 작은 bumps(1): 세대 키를 다시 썼다. 감시가 올렸으면(BUMPED) 1, 아니면 기준만
    w.results.set(EV_A, BUMPED(1_700_000_020, 1));
    await watch.tick();
    expect(w.calls.epochBumpedArgs).toEqual([1, 1]);
    w.results.set(EV_A, SAME(1_700_000_020, 2));
    await watch.tick();
    expect(w.calls.epochBumpedArgs).toEqual([1, 1, 1]);

    // 실패한 회차는 기준을 지우지 않는다(다음 틱에 차이를 센다)
    w.results.set(EV_A, new Error('down'));
    await watch.tick();
    w.results.set(EV_A, SAME(1_700_000_021, 4));
    await watch.tick();
    expect(w.calls.epochBumpedArgs).toEqual([1, 1, 1, 2]);
  });
});

describe('SeatEpochWatch와 MemorySeatStore(세대 올리기 Lua의 쌍둥이, 승격 흉내)', () => {
  test('ST26_리뷰 고침 중간 1_ 승격 흉내(setNodeId) 뒤 홀드가 그 자리에서 올리면 감시는 올리지 않지만(bumped 없음) 그 한 번을 센다(epochBumped(1)) [S-T26]', async () => {
    const store = new MemorySeatStore(fakeClock({ now: NOW }));
    const keepUntilMs = NOW + 2 * DAY;
    await store.openSale({ eventId: EV_A, seatCount: 4, keepUntilMs });
    const counted: number[] = [];
    const infos: object[] = [];
    const watch = new SeatEpochWatch({
      store,
      leader: { isLeader: () => true },
      signals: { epochBumped: (n: number) => void counted.push(n) },
      logger: { warn: () => undefined, info: (o) => void infos.push(o) },
    });
    await expect(watch.tick()).resolves.toEqual({ checked: 1, bumped: [], notReady: [], failed: [] });
    store.setNodeId(PROMOTED);
    const seat = { seatId: 'A01', index: 0, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 0, tierId: 'R' };
    const r = await store.hold({
      eventId: EV_A,
      accountId: '0190f3a1-7c2e-7a00-8000-0000000000a1',
      purchaseSessionId: 'ps-a',
      holdId: '0190f3a1-7c2e-7a00-8000-0000000000f1',
      idempotencyKey: '9a1f0c3e-4b2d-4c8e-9f00-000000000001',
      fingerprint: 'a'.repeat(64),
      seats: [seat],
      limit: 4,
      keepUntilMs,
    });
    expect(r.kind).toBe('OK');
    expect(store.db.event(EV_A).epoch).toMatchObject({ epoch: NOW_SEC + 1, node: PROMOTED, bumps: 1 });
    await expect(watch.tick()).resolves.toEqual({ checked: 1, bumped: [], notReady: [], failed: [] });
    expect(counted).toEqual([1]);
    expect(infos).toEqual([{ kind: 'seat-epoch-watch', eventId: EV_A, epoch: NOW_SEC + 1, bumps: 1 }]);
  });

  test('ST26_장애 조치가 없으면 오르지 않고, 승격 흉내(setNodeId) 뒤 첫 틱이 회차 목록의 회차를 한 번씩 BUMPED로 올리며(epoch + 1, node = 새 표지) 다음 틱은 다시 오르지 않는다. 세대 키가 없는 회차는 notReady, 회차 목록 빼기가 뺀 회차는 보지 않는다 [S-T26] [ASVS v5.0.0-15.4.2]', async () => {
    const store = new MemorySeatStore(fakeClock({ now: NOW }));
    const keepUntilMs = NOW + 2 * DAY;
    for (const e of [EV_A, EV_B, EV_C]) await store.openSale({ eventId: e, seatCount: 4, keepUntilMs });
    // C: 회차 목록 빼기가 뺀 회차(세대 키는 남아 있다). D: 전체 유실 뒤 다시 만들기 전(목록에만 있고 세대 키가 없다)
    store.db.ctlEvents.delete(EV_C);
    store.db.ctlEvents.add(EV_D);
    const bumps = { n: 0 };
    const watch = new SeatEpochWatch({ store, leader: { isLeader: () => true }, signals: { epochBumped: (n: number) => void (bumps.n += n) } });

    await expect(watch.tick()).resolves.toEqual({ checked: 3, bumped: [], notReady: [EV_D], failed: [] });
    expect(bumps.n).toBe(0);

    store.setNodeId(PROMOTED);
    await expect(watch.tick()).resolves.toEqual({ checked: 3, bumped: [EV_A, EV_B], notReady: [EV_D], failed: [] });
    // chk = 마지막으로 표지를 견준 초(판매 열기·세대 올리기가 지금 초로 둔다, ADR-0210), bumps = 올린 누적 수(리뷰 고침 중간 1)
    for (const e of [EV_A, EV_B]) expect(store.db.event(e).epoch, e).toEqual({ epoch: NOW_SEC + 1, node: PROMOTED, gen: 1, chk: NOW_SEC, bumps: 1 });
    expect(store.db.event(EV_C).epoch).toEqual({ epoch: NOW_SEC, node: 'standalone', gen: 1, chk: NOW_SEC });
    expect(store.db.peek(EV_D)?.epoch).toBeUndefined();
    expect(bumps.n).toBe(2);

    await expect(watch.tick()).resolves.toEqual({ checked: 3, bumped: [], notReady: [EV_D], failed: [] });
    expect(bumps.n).toBe(2);
  });
});

describe('SeatEpochWatch.start·stop', () => {
  test('ST26_틱 사이에는 tickMs(기본 EPOCH_WATCH_TICK_MS = 1초 [가정]) 쉬고, deps.tickMs로 바꾼다. 쉬기는 멈춤 신호(AbortSignal)를 받는다. 이름은 seat-epoch-watch이다', async () => {
    expect(EPOCH_WATCH_TICK_MS).toBe(1_000);
    const w = world([EV_A]);
    const r = w.watch();
    expect(r.name).toBe('seat-epoch-watch');
    r.start();
    await runUntil(w, () => w.calls.list >= 3);
    await r.stop();
    expect(w.calls.list).toBeGreaterThanOrEqual(3);
    expect(w.sleeps.slice(0, 2).map((s) => s.ms)).toEqual([EPOCH_WATCH_TICK_MS, EPOCH_WATCH_TICK_MS]);
    expect(w.sleeps.every((s) => s.signal instanceof AbortSignal)).toBe(true);

    const w2 = world([EV_A]);
    const r2 = w2.watch({ tickMs: 50 });
    r2.start();
    await runUntil(w2, () => w2.calls.list >= 2);
    await r2.stop();
    expect(w2.sleeps[0]!.ms).toBe(50);
  });

  test('ST26_반복은 틱마다 리더를 다시 본다: 리더가 아닌 동안은 회차 목록을 읽지 않고 tickMs씩 쉬며, 리더가 되면 다음 틱에 세대를 올린다 [S-T26] [ASVS v5.0.0-15.4.1]', async () => {
    const w = world([EV_A]);
    w.results.set(EV_A, BUMPED());
    w.state.leader = false;
    const r = w.watch({ tickMs: 50 });
    r.start();
    for (let i = 0; i < 3; i++) {
      await settle(() => w.pendingSleeps().length > 0);
      w.pendingSleeps()[0]?.release();
    }
    await settle(() => w.pendingSleeps().length > 0);
    expect(w.calls.list).toBe(0);
    expect(w.calls.leader).toBeGreaterThanOrEqual(3);
    expect(new Set(w.sleeps.map((s) => s.ms))).toEqual(new Set([50]));
    w.state.leader = true;
    await runUntil(w, () => w.calls.bump.length >= 1);
    await r.stop();
    expect(w.calls.bump[0]).toBe(EV_A);
    expect(w.calls.epochBumped).toBeGreaterThanOrEqual(1);
  });

  test('ST26_stop은 돌던 틱을 기다리고(돌던 회차는 마친다) 남은 회차는 보지 않는다. 그 뒤로 틱이 없다 [S-T26] [ASVS v5.0.0-16.5.2]', async () => {
    const w = world([EV_A, EV_B]);
    const gate = deferred();
    w.wait.bump = (id) => (id === EV_A ? gate.promise : Promise.resolve());
    const r = w.watch();
    r.start();
    await runUntil(w, () => w.calls.bump.length >= 1);
    let stopped = false;
    const p = r.stop().then(() => void (stopped = true));
    for (let i = 0; i < 10; i++) await flush();
    expect(stopped).toBe(false);
    gate.resolve();
    await p;
    expect(stopped).toBe(true);
    expect(w.log).toContain(`bump-done ${EV_A}`);
    expect(w.calls.bump).toEqual([EV_A]);
    for (let i = 0; i < 20; i++) {
      for (const s of w.pendingSleeps()) s.release();
      await flush();
    }
    expect(w.calls.list).toBe(1);
  });

  test('ST26_stop은 쉬는 중이면 쉬기를 끊고(signal을 끊는다) 바로 끝난다. 그 뒤로 틱이 없다', async () => {
    const w = world([EV_A]);
    const r = w.watch();
    r.start();
    await runUntil(w, () => w.calls.list >= 1 && w.pendingSleeps().length >= 1);
    const ticks = w.calls.list;
    await r.stop();
    expect(w.sleeps.every((s) => s.done)).toBe(true);
    expect(w.sleeps.at(-1)!.signal.aborted).toBe(true);
    for (let i = 0; i < 20; i++) await flush();
    expect(w.calls.list).toBe(ticks);
  });

  test('ST26_start를 두 번 불러도 반복은 하나다(돌던 틱이 끝나지 않은 동안 두 번째 틱이 없다). stop은 켜지 않았어도, 두 번 불러도 된다', async () => {
    const idle = world([]);
    const r0 = idle.watch();
    await r0.stop();
    await r0.stop();
    expect(idle.calls.list).toBe(0);

    const w = world([EV_A]);
    const gate = deferred();
    w.wait.list = () => gate.promise;
    const r = w.watch();
    r.start();
    r.start();
    await runUntil(w, () => w.calls.list >= 1);
    for (let i = 0; i < 5; i++) {
      for (const s of w.pendingSleeps()) s.release();
      await flush();
    }
    expect(w.calls.list).toBe(1);
    gate.resolve();
    await r.stop();
    await r.stop();
  });

  test('ST26_반복은 리더 확인이 던져도 끝나지 않는다: 그 틱은 리더가 아닌 것으로 보고 tickMs 쉰 뒤 이어 돌아 다음 틱에 세대를 올린다 [S-T26] [ASVS v5.0.0-16.5.2]', async () => {
    const w = world([EV_A]);
    w.results.set(EV_A, BUMPED());
    let first = true;
    w.fail.leader = () => {
      if (!first) return undefined;
      first = false;
      return named('UnexpectedError', 'boom');
    };
    const r = w.watch({ tickMs: 50 });
    r.start();
    await runUntil(w, () => w.calls.bump.length >= 1);
    await r.stop();
    expect(w.calls.bump[0]).toBe(EV_A);
    expect(w.sleeps[0]!.ms).toBe(50);
    expect(w.warns.length).toBeGreaterThanOrEqual(1);
  });

  test('ST26_반복은 쉬기가 던져도 끝나지 않는다(바꿔 끼운 쉬기의 오류를 감싸고 이어 돈다) [S-T26] [ASVS v5.0.0-16.5.2]', async () => {
    const w = world([EV_A]);
    let first = true;
    const sleep = (ms: number, signal: AbortSignal) => {
      if (first) {
        first = false;
        return Promise.reject(new Error('timer down'));
      }
      return w.sleep(ms, signal);
    };
    const r = w.watch({ sleep });
    r.start();
    await runUntil(w, () => w.calls.list >= 2);
    await r.stop();
    expect(w.calls.list).toBeGreaterThanOrEqual(2);
  });
});
