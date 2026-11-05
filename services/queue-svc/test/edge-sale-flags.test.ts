// 엣지 매진 표시 켜고 끄기(docs/features/queue-admission.md §4 '엣지 매진 표시와 좌석 수 칸의 첫 구현', docs/infra.md §4.1 '엣지 매진 응답', ADR-0219, Q-T63).
// 실제 KeyValueStore 어댑터는 HOT-012(OPEN[24] 대기)라, 포트의 시험 대역(MemoryEdgeSaleFlags)과 메모리 판매 상태 저장소로 본다.
// 판매 상태 Lua가 돌려주는 notice의 지금 판으로 되돌리는 사례(Q-T63 ③)는 test/sale-state-cases.ts에서 실제 Valkey로도 돈다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { saleEndOf } from '../src/modules/entry/domain/queue.js';
import {
  ApplySaleChange,
  EDGE_FLAG_RESYNC_BATCH,
  EDGE_FLAG_RESYNC_MS,
  EdgeFlagsUnavailable,
  edgeFlagEntry,
  edgeSyncPausedFromEnv,
  EventSaleChangedHandler,
  MemoryEdgeSaleFlags,
  MemorySaleStates,
  SALE_STATE_FALLBACK_TTL_MS,
  type SaleChange,
} from '../src/modules/sale/index.js';
import { saleEvent } from './sale-state-cases.js';
import { newEvent, openSchedule } from './support.js';

const NOW = Date.UTC(2026, 10, 6, 1, 0, 0);

async function world(o: { withSchedule?: boolean; edgeDeadlineMs?: number; breaker?: 'default' } = {}) {
  const switches = { paused: false };
  const clock = fakeClock({ now: NOW });
  const states = new MemorySaleStates();
  const schedules = new MemoryEventSchedules();
  const edge = new MemoryEdgeSaleFlags();
  const eventId = newEvent();
  const schedule = openSchedule(NOW);
  if (o.withSchedule !== false) await schedules.set(eventId, schedule);
  const warnings: { obj: object; msg?: string }[] = [];
  const failed: number[] = [];
  const unsynced: Record<'on' | 'off', number> = { on: 0, off: 0 };
  const ahead = { n: 0 };
  const apply = new ApplySaleChange(states, schedules, clock, {
    edge,
    logger: { warn: (obj, msg) => void warnings.push({ obj, ...(msg ? { msg } : {}) }) },
    signals: { failed: () => void failed.push(1), unsynced: (want, n) => void (unsynced[want] = n), ahead: (n) => void (ahead.n = n) },
    paused: () => switches.paused,
    // 차단기는 그것을 보는 사례에서만 운영 값으로 둔다(다른 사례의 실패 셈이 차단기를 열지 않게)
    ...(o.breaker === 'default' ? {} : { breaker: { minCalls: 1_000 } }),
    ...(o.edgeDeadlineMs !== undefined ? { edgeDeadlineMs: o.edgeDeadlineMs } : {}),
  });
  return { clock, states, schedules, edge, eventId, schedule, apply, warnings, failed, unsynced, ahead, switches };
}

describe('엣지 매진 표시(HOT-011, ADR-0219)', () => {
  test('Q-T63①_매진판이면_엣지켬이notice의SOLD_OUT쓰기보다먼저다(POL-015의차례)', async () => {
    const w = await world();
    const order: string[] = [];
    const apply = w.states.apply.bind(w.states);
    w.states.apply = async (c: SaleChange) => {
      order.push(`notice:${c.state}`);
      return apply(c);
    };
    w.edge.onPut = (e) => order.push(`edge:${JSON.parse(e.value).soldOut}`);
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 3, available: 0 }));
    expect(order).toEqual(['edge:true', 'notice:SOLD_OUT']);
    expect(w.edge.flagOf(w.eventId)).toEqual({ soldOut: true, version: 3, expireAtMs: saleEndOf(w.schedule) });
    // 매진이 아닌 판은 notice를 먼저 쓰고 그 판으로 맞춘다
    order.length = 0;
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', previousStatus: 'SOLD_OUT', version: 4 }));
    expect(order).toEqual(['notice:ON_SALE', 'edge:false']);
  });

  test('Q-T63②_매진풀림과판매종료는끔이고_끈값도판번호와함께남긴다(지우지않는다)', async () => {
    const w = await world();
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }));
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', previousStatus: 'SOLD_OUT', version: 2 }));
    expect(w.edge.flagOf(w.eventId)).toEqual({ soldOut: false, version: 2, expireAtMs: saleEndOf(w.schedule) });
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 3 }));
    await w.apply.run(saleEvent(w.eventId, { status: 'ENDED', previousStatus: 'SOLD_OUT', version: 4 }));
    expect(w.edge.flagOf(w.eventId)).toEqual({ soldOut: false, version: 4, expireAtMs: saleEndOf(w.schedule) });
    // 일시 매진·판매 중도 끔이다
    const o = await world();
    await o.apply.run(saleEvent(o.eventId, { status: 'ALL_HELD', version: 1 }));
    expect(o.edge.flagOf(o.eventId)).toMatchObject({ soldOut: false, version: 1 });
  });

  test('Q-T63②_일정사본이없으면_엣지값의만료는지금+2일[가정]이다(notice의대체수명과같다)', async () => {
    const w = await world({ withSchedule: false });
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }));
    expect(w.edge.flagOf(w.eventId)).toEqual({ soldOut: true, version: 1, expireAtMs: NOW + SALE_STATE_FALLBACK_TTL_MS });
  });

  test('[ASVS v5.0.0-15.4.2] Q-T63③_저장된판보다작은판은엣지를바꾸지않고_같은판의다시내기는60초[가정]안에다시쓰지않으며_60초가지나면다시쓴다', async () => {
    const w = await world();
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 7 }));
    expect(w.edge.writes).toHaveLength(1);
    // 같은 판의 다시 내기(5초마다): 파드가 마지막으로 쓴 값과 같아 쓰지 않는다
    for (let i = 0; i < 5; i++) {
      w.clock.advance(5_000);
      await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 7 }));
    }
    expect(w.edge.writes).toHaveLength(1);
    // 다른 파드가 그 사이 옛 값을 덮었다(재조정 동안 겹침). 60초가 지나면 다시 써서 바로잡는다
    w.edge.overwriteForTest(w.eventId, { soldOut: false, version: 7, expireAtMs: saleEndOf(w.schedule) });
    w.clock.advance(EDGE_FLAG_RESYNC_MS);
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 7 }));
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: true, version: 7 });
  });

  test('시험대역은실제어댑터(HOT-012)처럼_저장된판보다작은판을쓰지않고NEWER_STORED를돌려주며_sale:이아닌키를받지않는다', async () => {
    const w = await world();
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 7 }));
    expect(await w.edge.put(edgeFlagEntry(w.eventId, { soldOut: false, version: 6, expireAtMs: 1 }))).toBe('NEWER_STORED');
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: true, version: 7 });
    expect(await w.edge.put(edgeFlagEntry(w.eventId, { soldOut: true, version: 7, expireAtMs: 1 }))).toBe('WRITTEN');
    await expect(w.edge.put({ key: 'kid:1', value: '{}', version: 1 })).rejects.toBeInstanceOf(RangeError);
  });

  test('[ASVS v5.0.0-16.5.2] Q-T63④_엣지쓰기가실패해도던지지않고notice는쓰며_맞추지못한회차수가남고_다음사건에서맞추면0이다', async () => {
    const w = await world();
    w.edge.failWith = new EdgeFlagsUnavailable(new Error('저장소가 답하지 않는다'));
    expect(await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }))).toEqual({ kind: 'APPLIED', soldOutLastSeq: 0 });
    expect(w.states.noticeOf(w.eventId)).toMatchObject({ saleState: 'SOLD_OUT', saleVersion: '1' });
    expect(w.edge.flagOf(w.eventId)).toBeNull();
    // 먼저 켜기와 쓴 뒤 맞추기가 모두 실패했다
    expect(w.failed.length).toBe(2);
    expect(w.unsynced).toEqual({ on: 1, off: 0 });
    // 경고에는 회차·켬끔·오류 요약만 싣는다
    expect(w.warnings.length).toBeGreaterThan(0);
    expect(w.warnings[0]!.obj).toMatchObject({ eventId: w.eventId, want: 'on' });
    // 내는 쪽이 같은 판을 다시 냈다(5초 뒤): 이번에는 맞춘다
    w.edge.failWith = null;
    w.clock.advance(5_000);
    expect(await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }))).toEqual({ kind: 'STALE' });
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: true, version: 1 });
    expect(w.unsynced).toEqual({ on: 0, off: 0 });
  });

  test('[ASVS v5.0.0-16.5.2] Q-T63④_엣지쓰기가마감(2초[가정])안에끝나지않으면실패로보고_notice는그대로쓴다', async () => {
    const w = await world({ edgeDeadlineMs: 30 });
    w.edge.hang = true;
    const started = Date.now();
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', version: 1 }));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(w.states.noticeOf(w.eventId)).toMatchObject({ saleState: 'ON_SALE' });
    expect(w.unsynced).toEqual({ on: 0, off: 1 });
  });

  test('Q-T63④_끔을맞추지못한회차는want=off로세고_그회차의만료(판매종료)가지나면셈에서뺀다', async () => {
    const w = await world();
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }));
    w.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', previousStatus: 'SOLD_OUT', version: 2 }));
    expect(w.unsynced).toEqual({ on: 0, off: 1 });
    // 판매 종료가 지난 뒤 다른 회차의 사건을 처리하면 지난 회차는 셈에서 빠진다(엣지도 지난 값을 무시한다)
    w.clock.advance(saleEndOf(w.schedule) - NOW + 1);
    w.edge.failWith = null;
    const other = newEvent();
    await w.apply.run(saleEvent(other, { status: 'ON_SALE', version: 1 }));
    expect(w.unsynced).toEqual({ on: 0, off: 0 });
  });

  test('대기열Redis일시장애로notice를못쓰면_먼저켠엣지는그대로두고던져(일시실패)다시하며_다시할때는같은값을쓰지않는다', async () => {
    const w = await world();
    w.states.failNext = new Error('notice를 쓰지 못했다');
    await expect(w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }))).rejects.toThrow('notice를 쓰지 못했다');
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: true, version: 1 });
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }));
    expect(w.edge.writes).toHaveLength(1);
    expect(w.states.noticeOf(w.eventId)).toMatchObject({ saleState: 'SOLD_OUT' });
  });

  test('Q-T63⑤_엣지에는sale:{회차ID}키만쓰고_값은soldOut·version·expireAtMs세칸의JSON이다(docs/infra.md §4.1)', async () => {
    const w = await world();
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }));
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', version: 2 }));
    expect(w.edge.writes.length).toBeGreaterThan(0);
    for (const x of w.edge.writes) {
      expect(x.key).toBe(`sale:${w.eventId}`);
      expect(Object.keys(JSON.parse(x.value)).sort()).toEqual(['expireAtMs', 'soldOut', 'version']);
      expect(Buffer.byteLength(x.key)).toBeLessThanOrEqual(512);
      expect(Buffer.byteLength(x.value)).toBeLessThanOrEqual(1024);
    }
  });

  test('[ASVS v5.0.0-16.5.2] Q-T63④_파드안다시맞추기(5초[가정])는맞추지못한회차를notice의지금판으로다시써_저장소가살아나면다음사건없이도셈이0이다(다른파드로넘어간회차포함)', async () => {
    const w = await world();
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }));
    w.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', previousStatus: 'SOLD_OUT', version: 2 }));
    expect(w.unsynced).toEqual({ on: 0, off: 1 });
    // 저장소가 아직 안 되면 다시 맞추기도 실패하고 셈이 남는다(실제로 맞지 않는다)
    await w.apply.edgeSync!.tick();
    expect(w.unsynced).toEqual({ on: 0, off: 1 });
    // 그 사이 파티션이 다른 파드로 넘어가 그 파드가 끔을 썼다. 이 파드에는 그 회차의 사건이 더 오지 않는다
    w.edge.failWith = null;
    w.edge.overwriteForTest(w.eventId, { soldOut: false, version: 2, expireAtMs: saleEndOf(w.schedule) });
    await w.apply.edgeSync!.tick();
    expect(w.unsynced).toEqual({ on: 0, off: 0 });
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: false, version: 2 });
    // 이 파드 혼자 남아 있어도 같다: 저장소가 살아나면 notice의 지금 판(끔 2)을 쓴다
    const v = await world();
    await v.apply.run(saleEvent(v.eventId, { status: 'SOLD_OUT', version: 1 }));
    v.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    await v.apply.run(saleEvent(v.eventId, { status: 'ON_SALE', previousStatus: 'SOLD_OUT', version: 2 }));
    v.edge.failWith = null;
    await v.apply.edgeSync!.tick();
    expect(v.edge.flagOf(v.eventId)).toMatchObject({ soldOut: false, version: 2 });
    expect(v.unsynced).toEqual({ on: 0, off: 0 });
  });

  test('Q-T63④_notice가사라진회차(수명이끝남)는다시맞출것이없어_셈에서뺀다', async () => {
    const w = await world();
    w.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', version: 1 }));
    expect(w.unsynced).toEqual({ on: 0, off: 1 });
    w.states.dropNoticeForTest(w.eventId);
    await w.apply.edgeSync!.tick();
    expect(w.unsynced).toEqual({ on: 0, off: 0 });
  });

  test('Q-T63③_엣지에notice보다큰판이저장돼있으면(꾸민값·잃은notice)_조용히넘기지않고앞선회차수로센다_notice가따라오면0이다', async () => {
    const w = await world();
    w.edge.overwriteForTest(w.eventId, { soldOut: true, version: 1_000_000, expireAtMs: saleEndOf(w.schedule) });
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', version: 3 }));
    // 엣지는 판매 중인 회차를 매진으로 막고 있다. 바꾸지 못하므로 따로 센다(경보, 손으로 지운다)
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: true, version: 1_000_000 });
    expect(w.ahead.n).toBe(1);
    expect(w.unsynced).toEqual({ on: 0, off: 0 });
    expect(w.warnings.some((x) => (x.obj as { stored?: string }).stored === 'newer')).toBe(true);
    // 다시 맞추기도 같은 판으로는 바꾸지 못해 셈이 남는다
    await w.apply.edgeSync!.tick();
    expect(w.ahead.n).toBe(1);
    // 운영자가 엣지 값을 지운 뒤 다시 맞추기가 notice의 판을 쓰면 0이다
    w.edge.deleteForTest(w.eventId);
    await w.apply.edgeSync!.tick();
    expect(w.ahead.n).toBe(0);
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: false, version: 3 });
  });

  test('[ASVS v5.0.0-16.5.2] Q-T63④_엣지가계속실패하면차단기가열려_다음사건은엣지를부르지않고마감없이바로notice를쓴다', async () => {
    const w = await world({ edgeDeadlineMs: 30, breaker: 'default' });
    w.edge.hang = true;
    let calls = 0;
    w.edge.onPut = () => void calls++;
    for (let v = 1; v <= 3; v++) await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', version: v }));
    expect(calls).toBe(3);
    const started = Date.now();
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 4 }));
    expect(Date.now() - started).toBeLessThan(25);
    expect(calls).toBe(3);
    expect(w.states.noticeOf(w.eventId)).toMatchObject({ saleState: 'SOLD_OUT', saleVersion: '4' });
    expect(w.unsynced).toEqual({ on: 1, off: 0 });
    w.apply.edgeSync!.stop();
  });

  test('Q-T63⑥_엣지맞추기멈춤스위치가켜지면_엣지를쓰지않고(손으로끈값을되돌리지않게)_셈도0이며_풀면다시맞춘다', async () => {
    const w = await world();
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }));
    w.switches.paused = true;
    // 운영자가 엣지 값을 손으로 껐다
    w.edge.overwriteForTest(w.eventId, { soldOut: false, version: 1, expireAtMs: saleEndOf(w.schedule) });
    w.clock.advance(EDGE_FLAG_RESYNC_MS + 1);
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }));
    await w.apply.edgeSync!.tick();
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: false });
    expect(w.unsynced).toEqual({ on: 0, off: 0 });
    w.switches.paused = false;
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 }));
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: true, version: 1 });
  });

  // 재검토(2026-11-06): 처리기와 다시 맞추기가 엇갈리는 차례, 가짜 앞선 판, 돌아가며 보기, 다시 맞출 때의 만료, 멈춤 스위치 값
  test('[ASVS v5.0.0-15.4.2] Q-T63④_다시맞추기가옛판N을쓰는동안처리기의N+1쓰기가실패하면_N쓰기가끝나도N+1을맞추지못한기록은남는다', async () => {
    const w = await world();
    w.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', version: 2 }));
    w.edge.failWith = null;
    // 다시 맞추기가 notice 2를 읽고 쓰는 중(저장소가 아직 답하지 않음)
    const g = w.edge.gate();
    const tick = w.apply.edgeSync!.tick();
    await g.entered;
    // 그 사이 처리기가 매진 판 3을 쓰다 실패한다
    w.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    await w.apply.run(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 3 }));
    w.edge.failWith = null;
    g.release();
    await tick;
    // 엣지는 끔 2에 있고 바라는 것은 켬 3이다. 맞추지 못한 기록이 남아 경보와 다음 다시 맞추기가 본다
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: false, version: 2 });
    expect(w.unsynced).toEqual({ on: 1, off: 0 });
    await w.apply.edgeSync!.tick();
    expect(w.edge.flagOf(w.eventId)).toMatchObject({ soldOut: true, version: 3 });
    expect(w.unsynced).toEqual({ on: 0, off: 0 });
  });

  test('Q-T63③_다시맞추기가notice를읽은뒤처리기가더큰판을쓰면_옛판쓰기의NEWER_STORED를앞선회차로세지않고_처리기가맞춘값도지우지않는다', async () => {
    const w = await world();
    w.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', version: 2 }));
    w.edge.failWith = null;
    const g = w.edge.gate();
    const tick = w.apply.edgeSync!.tick();
    await g.entered;
    await w.apply.run(saleEvent(w.eventId, { status: 'ALL_HELD', version: 3 }));
    g.release();
    await tick;
    expect(w.ahead.n).toBe(0);
    expect(w.unsynced).toEqual({ on: 0, off: 0 });
    expect(w.warnings.some((x) => (x.obj as { stored?: string }).stored === 'newer')).toBe(false);
    // 처리기가 맞춘 값(끔 3)은 그대로라, 같은 판의 다시 내기는 다시 쓰지 않는다
    const before = w.edge.writes.length;
    await w.apply.run(saleEvent(w.eventId, { status: 'ALL_HELD', version: 3 }));
    expect(w.edge.writes.length).toBe(before);
  });

  test('Q-T63④_다시맞추기는한번에100회차[가정]를보고본회차를뒤로보내_안풀리는회차가앞에쌓여도뒤회차가굶지않는다', async () => {
    const w = await world();
    const ids = Array.from({ length: EDGE_FLAG_RESYNC_BATCH + 1 }, () => newEvent());
    w.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    for (const id of ids) await w.apply.run(saleEvent(id, { status: 'ON_SALE', version: 1 }));
    // 첫 주기: 앞의 100회차가 또 실패한다
    await w.apply.edgeSync!.tick();
    // 둘째 주기: 저장소가 살아났다. 지난 주기에 보지 못한 마지막 회차를 이번에 본다
    w.edge.failWith = null;
    await w.apply.edgeSync!.tick();
    expect(w.edge.flagOf(ids[EDGE_FLAG_RESYNC_BATCH]!)).toMatchObject({ soldOut: false, version: 1 });
  });

  test('Q-T63④_다시맞추기는지금일정의판매종료로엣지값의만료를다시정하고_판매종료가지난회차는뺀다', async () => {
    const w = await world();
    w.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    await w.apply.run(saleEvent(w.eventId, { status: 'ON_SALE', version: 1 }));
    w.edge.failWith = null;
    // 공연이 하루 미뤄졌다(판매 종료도 하루 뒤)
    const later = { ...w.schedule, startsAtMs: w.schedule.startsAtMs + 86_400_000 };
    await w.schedules.set(w.eventId, later);
    await w.apply.edgeSync!.tick();
    expect(w.edge.flagOf(w.eventId)).toEqual({ soldOut: false, version: 1, expireAtMs: saleEndOf(later) });
    // 다른 회차: 판매 종료가 앞당겨져 이미 지났다면 쓰지 않고 뺀다
    const o = await world();
    o.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    await o.apply.run(saleEvent(o.eventId, { status: 'ON_SALE', version: 1 }));
    o.edge.failWith = null;
    await o.schedules.set(o.eventId, { ...o.schedule, startsAtMs: NOW + 24 * 3600_000 - 1 });
    await o.apply.edgeSync!.tick();
    expect(o.edge.flagOf(o.eventId)).toBeNull();
    expect(o.unsynced).toEqual({ on: 0, off: 0 });
  });

  test('Q-T63⑥_멈춤스위치환경값PEAKET_EDGE_SYNC는앞뒤공백·대소문자를무시하고_off·false·0이면멈춤_on·true·1·없음·빈칸이면켬_그밖은시작실패', () => {
    for (const v of ['off', ' OFF ', 'False', '0']) expect(edgeSyncPausedFromEnv({ PEAKET_EDGE_SYNC: v }), v).toBe(true);
    for (const v of [undefined, '', '  ', 'on', 'ON', 'true', '1']) expect(edgeSyncPausedFromEnv({ PEAKET_EDGE_SYNC: v }), String(v)).toBe(false);
    for (const v of ['of', 'disable', 'no', '2']) expect(() => edgeSyncPausedFromEnv({ PEAKET_EDGE_SYNC: v }), v).toThrow(/PEAKET_EDGE_SYNC/);
  });

  test('엣지포트가없으면(HOT-012전)_판매상태만쓰고엣지는건드리지않는다', async () => {
    const states = new MemorySaleStates();
    const apply = new ApplySaleChange(states, new MemoryEventSchedules(), fakeClock({ now: NOW }));
    expect(await apply.run(saleEvent('ev-1', { status: 'SOLD_OUT', version: 1 }))).toEqual({ kind: 'APPLIED', soldOutLastSeq: 0 });
    expect(apply.edgeSync).toBeUndefined();
  });

  test('Q-T63_처리기는엣지가실패해도_일시실패로던지지않는다(파티션의다른회차사건을막지않게)', async () => {
    const w = await world();
    w.edge.failWith = new EdgeFlagsUnavailable(new Error('잠시 안 됨'));
    const handler = new EventSaleChangedHandler(w.apply);
    const value = Buffer.from(JSON.stringify(saleEvent(w.eventId, { status: 'SOLD_OUT', version: 1 })));
    const r = handler.decode({ topic: 'trade.seats', partition: 0, offset: 1n, key: w.eventId, value, headers: {}, timestamp: 0 });
    await expect(handler.handle(r)).resolves.toBeUndefined();
  });
});
