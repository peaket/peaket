// 다시 만들기 반복(SeatRebuildLoop, BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 다시 만들기 반복,
// '다시 만들기(RB-06)의 첫 구현', ADR-0121, docs/security/asvs/seat-hold.md 16.5.2). 릴레이 프로세스의 Lease 리더가 5초 [가정]마다 판매 회차 목록을 보고,
// 판매 종료 + 1시간 [가정] 전인 회차 가운데 세대 키가 없는 회차를 차례로 SeatRebuilder로 다시 만든다.
// 회차 목록·판매를 연 기록(marks)·세대 키 확인·다시 만들기·리더 확인·로그는 시험 안의 메모리 대역이고, 시각은 가짜 시계, 쉬기는 deps.sleep을 바꿔 끼워 손으로 푼다(고정 sleep 없음).
// 기록 대역은 기본으로 모든 회차에 기록이 있다(state.unopened에 넣은 회차만 없다, PRF-164 리뷰 고침 M3).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  KEEP_AFTER_SALE_END_MS,
  REBUILD_LOOK_AFTER_SALE_END_MS,
  REBUILD_LOOP_TICK_MS,
  RETIRE_AFTER_SALE_END_MS,
  type RebuildReport,
  type SaleEvent,
  SeatRebuildLoop,
  type SeatRebuildLoopDeps,
} from '../src/modules/inventory/index.js';

const NOW = Date.parse('2026-11-05T03:00:00.000Z');
const HOUR = 3_600_000;
const EV_A = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const EV_B = '0190f3a1-7c2e-7a00-8000-0000000000e2';
const EV_C = '0190f3a1-7c2e-7a00-8000-0000000000e3';

/** 판매 중인 회차(판매 종료가 지금 + 하루) */
const onSale = (eventId: string, saleEndsAtMs = NOW + 24 * HOUR): SaleEvent => ({ eventId, saleEndsAtMs });
const REBUILT = (gen = 2): RebuildReport => ({ result: 'REBUILT', gen, sold: 3, held: 2, skipped: 1 });

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
function world(events: SaleEvent[] = []) {
  const clock = fakeClock({ now: NOW });
  /** unopened: 판매를 연 기록(seat_rebuild 행)이 없는 회차. 기본은 모두 기록이 있다 */
  const state = { leader: true, events: [...events], ready: new Set<string>(), unopened: new Set<string>() };
  /** 회차마다 rebuild가 돌려줄 값(없으면 REBUILT()) 또는 던질 오류 */
  const results = new Map<string, RebuildReport | Error>();
  const fail: { list?: Error; marks?: Error; isReady: Map<string, Error>; leader?: () => Error | undefined } = { isReady: new Map() };
  const wait: { list?: () => Promise<void>; rebuild?: (eventId: string) => Promise<void> } = {};
  const log: string[] = [];
  const calls = { leader: 0, list: 0, opened: [] as string[][], isReady: [] as string[], rebuild: [] as [string, { keepUntilMs: number }][] };
  const warns: { obj: Record<string, unknown>; msg: string }[] = [];
  const infos: { obj: Record<string, unknown>; msg: string }[] = [];
  const logger = {
    warn: (obj: object, msg: string) => void warns.push({ obj: obj as Record<string, unknown>, msg }),
    info: (obj: object, msg: string) => void infos.push({ obj: obj as Record<string, unknown>, msg }),
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
  const deps: SeatRebuildLoopDeps = {
    catalog: {
      list: async () => {
        calls.list += 1;
        log.push('list');
        await wait.list?.();
        if (fail.list) throw fail.list;
        return state.events.map((e) => ({ ...e }));
      },
    },
    marks: {
      opened: async (eventIds: readonly string[]) => {
        calls.opened.push([...eventIds]);
        log.push('opened');
        if (fail.marks) throw fail.marks;
        return new Set(eventIds.filter((e) => !state.unopened.has(e)));
      },
    },
    store: {
      isReady: async (eventId: string) => {
        calls.isReady.push(eventId);
        log.push(`isReady ${eventId}`);
        const x = fail.isReady.get(eventId);
        if (x) throw x;
        return state.ready.has(eventId);
      },
    },
    rebuilder: {
      rebuild: async (eventId: string, o: { keepUntilMs: number }) => {
        calls.rebuild.push([eventId, { ...o }]);
        log.push(`rebuild ${eventId}`);
        await wait.rebuild?.(eventId);
        const r = results.get(eventId) ?? REBUILT();
        log.push(`rebuild-done ${eventId}`);
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
    clock,
    logger,
    sleep,
  };
  const loop = (over: Partial<SeatRebuildLoopDeps> = {}) => new SeatRebuildLoop({ ...deps, ...over });
  const pendingSleeps = () => sleeps.filter((s) => !s.done);
  const logText = () => [...warns, ...infos].map((l) => `${JSON.stringify(l.obj)} ${l.msg}`).join('\n');
  return { clock, state, results, fail, wait, log, calls, warns, infos, logger, sleeps, sleep, deps, loop, pendingSleeps, logText };
}

/** start 뒤 조건이 설 때까지 돌린다. 그사이 걸린 쉬기는 하나씩 풀어 준다(첫 틱 전에 쉬는 구현도 받는다) */
async function runUntil(w: ReturnType<typeof world>, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) {
    await settle(() => ok() || w.pendingSleeps().length > 0);
    if (ok()) return;
    w.pendingSleeps()[0]?.release();
  }
}

describe('SeatRebuildLoop.tick: 리더와 회차 고르기', () => {
  test('ST26_리더가 아니면 회차 목록·세대 키 확인·다시 만들기 어느 것도 부르지 않고 { skipped: not_leader }다 [S-T26] [ASVS v5.0.0-15.4.1]', async () => {
    const w = world([onSale(EV_A)]);
    w.state.leader = false;
    await expect(w.loop().tick()).resolves.toEqual({ skipped: 'not_leader' });
    expect(w.calls.leader).toBeGreaterThanOrEqual(1);
    expect(w.calls.list).toBe(0);
    expect(w.calls.opened).toEqual([]);
    expect(w.calls.isReady).toEqual([]);
    expect(w.calls.rebuild).toEqual([]);
  });

  test('ST26_판매 종료 + 1시간(REBUILD_LOOK_AFTER_SALE_END_MS, 회차 목록 빼기와 같은 여유)이 지난 회차는 넘긴다(isReady도 부르지 않고 checked에 세지 않는다). 지금이 정확히 판매 종료 + 1시간이면 아직 본다 [S-T26]', async () => {
    expect(REBUILD_LOOK_AFTER_SALE_END_MS).toBe(HOUR);
    expect(REBUILD_LOOK_AFTER_SALE_END_MS).toBe(RETIRE_AFTER_SALE_END_MS);
    const boundary = onSale(EV_A, NOW - HOUR); // 지금 = 판매 종료 + 1시간(같으면 본다)
    const past = onSale(EV_B, NOW - HOUR - 1); // 1ms 지남
    const selling = onSale(EV_C);
    const w = world([boundary, past, selling]);
    const r = await w.loop().tick();
    expect(w.calls.opened).toEqual([[EV_A, EV_C]]);
    expect(w.calls.isReady).toEqual([EV_A, EV_C]);
    expect(w.calls.rebuild.map(([e]) => e)).toEqual([EV_A, EV_C]);
    expect(r).toEqual({ checked: 2, rebuilt: [EV_A, EV_C], busy: [], failed: [] });
    // 주입 시계를 1ms 밀면 경계 회차도 넘긴다
    w.clock.advance(1);
    w.calls.isReady.length = 0;
    await w.loop().tick();
    expect(w.calls.isReady).toEqual([EV_C]);
  });

  test('ST26_세대 키가 있으면(isReady 참) rebuild를 부르지 않는다. 없으면 rebuild(회차, { keepUntilMs: 판매 종료 + 1일 })를 부른다(KEEP_AFTER_SALE_END_MS) [S-T26]', async () => {
    const endB = NOW + 3 * HOUR;
    const w = world([onSale(EV_A), onSale(EV_B, endB)]);
    w.state.ready.add(EV_A);
    const r = await w.loop().tick();
    expect(w.calls.isReady).toEqual([EV_A, EV_B]);
    expect(w.calls.rebuild).toEqual([[EV_B, { keepUntilMs: endB + KEEP_AFTER_SALE_END_MS }]]);
    expect(KEEP_AFTER_SALE_END_MS).toBe(24 * HOUR);
    expect(r).toEqual({ checked: 2, rebuilt: [EV_B], busy: [], failed: [] });
  });

  test('ST26_회차는 목록 차례대로 하나씩 본다: 앞 회차의 rebuild가 끝나기 전에 다음 회차의 isReady를 부르지 않는다 [S-T26]', async () => {
    const w = world([onSale(EV_A), onSale(EV_B)]);
    const gate = deferred();
    w.wait.rebuild = (id) => (id === EV_A ? gate.promise : Promise.resolve());
    const p = w.loop().tick();
    p.catch(() => undefined);
    await settle(() => w.calls.rebuild.length === 1);
    for (let i = 0; i < 10; i++) await flush();
    expect(w.calls.isReady).toEqual([EV_A]);
    gate.resolve();
    await p;
    expect(w.log.filter((l) => l !== 'list' && l !== 'opened')).toEqual([`isReady ${EV_A}`, `rebuild ${EV_A}`, `rebuild-done ${EV_A}`, `isReady ${EV_B}`, `rebuild ${EV_B}`, `rebuild-done ${EV_B}`]);
  });

  test('ST26_빈 회차 목록이면 아무것도 부르지 않고 checked 0이다', async () => {
    const w = world([]);
    await expect(w.loop().tick()).resolves.toEqual({ checked: 0, rebuilt: [], busy: [], failed: [] });
    expect(w.calls.list).toBe(1);
    expect(w.calls.isReady).toEqual([]);
  });
});

describe('SeatRebuildLoop.tick: 결과와 실패', () => {
  test('ST26_BUSY는 busy에, READY는 어디에도 넣지 않고, 다음 틱에 세대 키가 여전히 없으면 그대로 다시 부른다(STALE은 SeatRebuilder가 이미 BUSY로 바꿔 준다) [S-T26]', async () => {
    const w = world([onSale(EV_A), onSale(EV_B), onSale(EV_C)]);
    w.results.set(EV_A, { result: 'BUSY' });
    w.results.set(EV_B, { result: 'READY' });
    const r = w.loop();
    expect(await r.tick()).toEqual({ checked: 3, rebuilt: [EV_C], busy: [EV_A], failed: [] });
    expect(await r.tick()).toEqual({ checked: 3, rebuilt: [EV_C], busy: [EV_A], failed: [] });
    expect(w.calls.rebuild.map(([e]) => e)).toEqual([EV_A, EV_B, EV_C, EV_A, EV_B, EV_C]);
  });

  test('ST26_REBUILT은 info 한 줄(회차 ID·gen·sold·held·skipped)이다. logger.info가 없으면 남기지 않고 던지지 않는다 [S-T26]', async () => {
    const w = world([onSale(EV_A)]);
    w.results.set(EV_A, { result: 'REBUILT', gen: 4, sold: 7, held: 5, skipped: 2 });
    await w.loop().tick();
    expect(w.infos).toHaveLength(1);
    expect(w.infos[0]!.obj).toMatchObject({ eventId: EV_A, gen: 4, sold: 7, held: 5, skipped: 2 });
    expect(w.warns).toEqual([]);
    const quiet = world([onSale(EV_A)]);
    const warnOnly = { warn: quiet.logger.warn };
    await expect(quiet.loop({ logger: warnOnly }).tick()).resolves.toEqual({ checked: 1, rebuilt: [EV_A], busy: [], failed: [] });
  });

  test('ST26_한 회차의 다시 만들기 실패(rebuild가 던짐)는 경고 한 줄(회차 ID·오류 이름만, 오류 글 없음)을 남기고 failed에 넣은 뒤 다음 회차로 간다. tick은 던지지 않는다 [S-T26] [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world([onSale(EV_A), onSale(EV_B), onSale(EV_C)]);
    w.results.set(EV_A, named('DatabaseError', 'password authentication failed SECRET-A'));
    w.results.set(EV_B, named('SeatStoreUnavailable', 'redis://user:SECRET-B@seat-redis'));
    const r = await w.loop().tick();
    expect(r).toEqual({ checked: 3, rebuilt: [EV_C], busy: [], failed: [EV_A, EV_B] });
    expect(w.calls.rebuild.map(([e]) => e)).toEqual([EV_A, EV_B, EV_C]);
    expect(w.warns).toHaveLength(2);
    const [wa, wb] = w.warns;
    expect(Object.values(wa!.obj)).toEqual(expect.arrayContaining([EV_A, 'DatabaseError']));
    expect(Object.values(wb!.obj)).toEqual(expect.arrayContaining([EV_B, 'SeatStoreUnavailable']));
    const text = w.logText();
    for (const s of ['SECRET-A', 'SECRET-B', 'redis://', 'password']) expect(text, s).not.toContain(s);
  });

  test('ST26_리뷰 고침 L5_세대 키 확인(isReady)이 던지면 좌석 Redis에 닿지 못한 것이라 경고 한 줄(회차 ID·오류 이름만) 뒤 그 틱을 끝낸다: 남은 회차는 보지 않고, 그 회차는 failed, 앞 회차의 결과는 그대로다 [S-T26] [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world([onSale(EV_A), onSale(EV_B), onSale(EV_C)]);
    w.fail.isReady.set(EV_B, named('SeatStoreUnavailable', 'redis://user:SECRET-B@seat-redis'));
    const r = await w.loop().tick();
    expect(r).toEqual({ checked: 2, rebuilt: [EV_A], busy: [], failed: [EV_B] });
    expect(w.calls.isReady).toEqual([EV_A, EV_B]);
    expect(w.calls.rebuild.map(([e]) => e)).toEqual([EV_A]);
    // 회차마다 경고가 쏟아지지 않는다(한 줄)
    expect(w.warns).toHaveLength(1);
    expect(Object.values(w.warns[0]!.obj)).toEqual(expect.arrayContaining([EV_B, 'SeatStoreUnavailable']));
    for (const s of ['SECRET-B', 'redis://']) expect(w.logText(), s).not.toContain(s);
  });

  test('ST26_로거가 없어도(선택 deps) 회차 오류를 failed로 담고 던지지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world([onSale(EV_A), onSale(EV_B), onSale(EV_C)]);
    w.results.set(EV_A, new Error('down'));
    w.fail.isReady.set(EV_C, new Error('down'));
    const { logger: _l, ...noLogger } = w.deps;
    const r = new SeatRebuildLoop(noLogger);
    await expect(r.tick()).resolves.toEqual({ checked: 3, rebuilt: [EV_B], busy: [], failed: [EV_A, EV_C] });
  });

  test('ST26_리뷰 고침 M3_판매를 연 기록(seat_rebuild 행)이 없는 회차는 세대 키가 없어도 isReady도 rebuild도 부르지 않는다(판매 열기 전의 NOT_READY 막음을 지우지 않는다). 기록은 창 안 회차를 모아 틱마다 한 번 묻는다 [S-T26] [ASVS v5.0.0-15.4.1]', async () => {
    const past = onSale(EV_C, NOW - HOUR - 1); // 판매 종료 + 1시간이 지남(기록을 묻지도 않는다)
    const w = world([onSale(EV_A), onSale(EV_B), past]);
    w.state.unopened.add(EV_B);
    const r = await w.loop().tick();
    expect(w.calls.opened).toEqual([[EV_A, EV_B]]);
    expect(w.calls.isReady).toEqual([EV_A]);
    expect(w.calls.rebuild.map(([e]) => e)).toEqual([EV_A]);
    expect(r).toEqual({ checked: 1, rebuilt: [EV_A], busy: [], failed: [] });
    // 기록을 묻는 것은 회차 목록 뒤, 세대 키 확인 앞이다
    expect(w.log.slice(0, 3)).toEqual(['list', 'opened', `isReady ${EV_A}`]);
    // 창 안 회차가 없으면 기록을 묻지 않는다
    const none = world([past]);
    await expect(none.loop().tick()).resolves.toEqual({ checked: 0, rebuilt: [], busy: [], failed: [] });
    expect(none.calls.opened).toEqual([]);
  });

  test('ST26_리뷰 고침 M3_판매를 연 기록을 읽지 못하면(marks.opened가 던짐) 경고 한 줄(오류 이름만) 뒤 그 틱을 끝낸다: { skipped: marks_failed }, isReady·rebuild 없음 [S-T26] [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world([onSale(EV_A), onSale(EV_B)]);
    w.fail.marks = named('DatabaseError', 'connect ECONNREFUSED postgres://purchase:SECRET-M@db');
    await expect(w.loop().tick()).resolves.toEqual({ skipped: 'marks_failed' });
    expect(w.calls.opened).toHaveLength(1);
    expect(w.calls.isReady).toEqual([]);
    expect(w.calls.rebuild).toEqual([]);
    expect(w.warns).toHaveLength(1);
    expect(Object.values(w.warns[0]!.obj)).toContain('DatabaseError');
    for (const s of ['SECRET-M', 'postgres://']) expect(w.logText(), s).not.toContain(s);
  });

  test('ST26_회차 목록(catalog)이 던지면 경고 한 줄(오류 이름만) 뒤 그 틱을 끝낸다: { skipped: catalog_failed }, isReady·rebuild 없음 [S-T26] [ASVS v5.0.0-16.5.2]', async () => {
    const w = world([onSale(EV_A)]);
    w.fail.list = named('SeatMapDirError', 'EACCES /etc/peaket/SECRET-DIR');
    await expect(w.loop().tick()).resolves.toEqual({ skipped: 'catalog_failed' });
    expect(w.calls.opened).toEqual([]);
    expect(w.calls.isReady).toEqual([]);
    expect(w.calls.rebuild).toEqual([]);
    expect(w.warns).toHaveLength(1);
    expect(Object.values(w.warns[0]!.obj)).toContain('SeatMapDirError');
    expect(w.logText()).not.toContain('SECRET-DIR');
  });

  test('ST26_멈춤 신호: tick(signal) 도중 signal이 끊기면 돌던 회차는 마치고 남은 회차는 보지 않으며 그때까지의 보고를 돌려준다 [S-T26]', async () => {
    const w = world([onSale(EV_A), onSale(EV_B), onSale(EV_C)]);
    const ac = new AbortController();
    w.wait.rebuild = async (id) => {
      if (id === EV_A) ac.abort();
    };
    await expect(w.loop().tick(ac.signal)).resolves.toEqual({ checked: 1, rebuilt: [EV_A], busy: [], failed: [] });
    expect(w.calls.isReady).toEqual([EV_A]);
    expect(w.calls.rebuild.map(([e]) => e)).toEqual([EV_A]);
  });
});

describe('SeatRebuildLoop.start·stop', () => {
  test('ST26_틱 사이에는 tickMs(기본 REBUILD_LOOP_TICK_MS = 5초 [가정]) 쉬고, deps.tickMs로 바꾼다. 쉬기는 멈춤 신호(AbortSignal)를 받는다. 이름은 seat-rebuild-loop이다', async () => {
    expect(REBUILD_LOOP_TICK_MS).toBe(5_000);
    const w = world([onSale(EV_A)]);
    w.state.ready.add(EV_A);
    const r = w.loop();
    expect(r.name).toBe('seat-rebuild-loop');
    r.start();
    await runUntil(w, () => w.calls.list >= 3);
    await r.stop();
    expect(w.calls.list).toBeGreaterThanOrEqual(3);
    expect(w.sleeps.slice(0, 2).map((s) => s.ms)).toEqual([REBUILD_LOOP_TICK_MS, REBUILD_LOOP_TICK_MS]);
    expect(w.sleeps.every((s) => s.signal instanceof AbortSignal)).toBe(true);

    const w2 = world([onSale(EV_A)]);
    w2.state.ready.add(EV_A);
    const r2 = w2.loop({ tickMs: 50 });
    r2.start();
    await runUntil(w2, () => w2.calls.list >= 2);
    await r2.stop();
    expect(w2.sleeps[0]!.ms).toBe(50);
  });

  test('ST26_반복은 틱마다 리더를 다시 본다: 리더가 아닌 동안은 회차 목록을 읽지 않고 tickMs씩 쉬며, 리더가 되면 다음 틱에 다시 만든다 [S-T26] [ASVS v5.0.0-15.4.1]', async () => {
    const w = world([onSale(EV_A)]);
    w.state.leader = false;
    const r = w.loop({ tickMs: 50 });
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
    await runUntil(w, () => w.calls.rebuild.length >= 1);
    await r.stop();
    expect(w.calls.rebuild.map(([e]) => e)).toEqual([EV_A]);
  });

  test('ST26_stop은 돌던 틱을 기다리고(돌던 회차는 마친다) 남은 회차는 보지 않는다. 그 뒤로 틱이 없다 [S-T26] [ASVS v5.0.0-16.5.2]', async () => {
    const w = world([onSale(EV_A), onSale(EV_B)]);
    const gate = deferred();
    w.wait.rebuild = (id) => (id === EV_A ? gate.promise : Promise.resolve());
    const r = w.loop();
    r.start();
    await runUntil(w, () => w.calls.rebuild.length >= 1);
    let stopped = false;
    const p = r.stop().then(() => void (stopped = true));
    for (let i = 0; i < 10; i++) await flush();
    expect(stopped).toBe(false);
    gate.resolve();
    await p;
    expect(stopped).toBe(true);
    expect(w.log).toContain(`rebuild-done ${EV_A}`);
    expect(w.calls.isReady).toEqual([EV_A]);
    for (let i = 0; i < 20; i++) {
      for (const s of w.pendingSleeps()) s.release();
      await flush();
    }
    expect(w.calls.list).toBe(1);
  });

  test('ST26_stop은 쉬는 중이면 쉬기를 끊고(signal을 끊는다) 바로 끝난다. 그 뒤로 틱이 없다', async () => {
    const w = world([onSale(EV_A)]);
    w.state.ready.add(EV_A);
    const r = w.loop();
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
    const r0 = idle.loop();
    await r0.stop();
    await r0.stop();
    expect(idle.calls.list).toBe(0);

    const w = world([onSale(EV_A)]);
    const gate = deferred();
    w.wait.list = () => gate.promise;
    const r = w.loop();
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

  test('ST26_반복은 예상 밖 오류에 끝나지 않는다: 틱이 던져도(리더 확인이 던짐) 경고 한 줄 뒤 tickMs 쉬고 이어 돌아 다음 틱에 다시 만든다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world([onSale(EV_A)]);
    let first = true;
    w.fail.leader = () => {
      if (!first) return undefined;
      first = false;
      return named('UnexpectedError', 'boom');
    };
    const r = w.loop({ tickMs: 50 });
    r.start();
    await runUntil(w, () => w.calls.rebuild.length >= 1);
    await r.stop();
    expect(w.calls.rebuild.map(([e]) => e)).toEqual([EV_A]);
    expect(w.sleeps[0]!.ms).toBe(50);
    expect(w.warns.length).toBeGreaterThanOrEqual(1);
  });
});
