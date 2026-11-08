// 리더 루프의 순서(docs/features/queue-admission.md §5, ADR-0056 결정 3, ADR-0182): 리더가 되면 진행 중인 회차마다 세대부터 올리고,
// 리더 상태를 읽은 뒤 전진한다. FENCED를 받으면 그 세대로는 더 쓰지 않는다. 로비·묶음 닫기와 게시를 필요할 때 부른다.
// 저장소(Lua)의 뜻은 test-int/leader-store.int.test.ts가 실제 Valkey로 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { AdmissionLeader } from '../src/modules/leader/application/admission-leader.js';
import type { ArrivalCloseResult, CloseInput, Control, ControlInputsReader, EventPlan, LeaderStore, Rb05Result, TickInput, TickResult } from '../src/modules/leader/domain/ports.js';
import { ALL_JOURNEYS, type EventInputs, MEMORY_FIELDS, type Reading } from '../src/modules/leader/domain/aimd.js';
import type { ControlEvent } from '../src/modules/leader/application/leader-metrics.js';
import { BatchMembersChanged } from '../src/modules/batch/application/publish-batch-results.js';

const T0 = Date.UTC(2026, 10, 3, 3, 0, 0);
const DAY = 86_400_000;
const OK: TickResult = { kind: 'OK', serving: 0, advanced: 0, slots: 0, soon: 0, inFlight: 0, waiting: 0, dropped: 0, lobbyMarked: 1, batchMarked: 1, batchPublished: 1, repair: 0, ratio: 1, saleState: 'ON_SALE' };

function world(o: { ids?: string[]; reader?: ControlInputsReader; plan?: Partial<EventPlan>; tick?: Partial<TickResult> | TickResult; bump?: 'OK' | 'FENCED'; close?: 'OK' | 'NONE' | 'FENCED' | 'RB05' | 'EARLY'; arrival?: ArrivalCloseResult; ctl?: Control } = {}) {
  const clock = fakeClock({ now: T0 });
  const calls: string[] = [];
  const ticks: TickInput[] = [];
  const closes: CloseInput[] = [];
  const plan: EventPlan = { opensAtMs: T0 - 10_000, startsAtMs: T0 + 3 * DAY, lobbyShuffle: false, openBatch: true, ...o.plan };
  const state = {
    gen: undefined as number | undefined,
    bump: o.bump ?? 'OK',
    tick: { ...OK, ...o.tick } as TickResult,
    close: o.close ?? 'OK',
    arrival: o.arrival ?? ({ kind: 'NONE', slots: 0, returned: 0 } as ArrivalCloseResult),
    rb05: { kind: 'DONE' } as Rb05Result,
    confirm: 'CONFIRMED' as 'CONFIRMED' | 'WAITING' | 'NONE',
  };
  const store: LeaderStore = {
    activeEvents: async () => {
      calls.push('events');
      return o.ids ?? ['e1'];
    },
    schedule: async () => plan,
    control: async () => {
      calls.push('control');
      return o.ctl ?? { paused: false };
    },
    platformControl: async () => ({ autoStopped: false }),
    bump: async (e, gen) => {
      calls.push(`bump:${e}:${gen}`);
      return state.bump;
    },
    tick: async (i) => {
      calls.push(`tick:${i.eventId}:${i.gen}`);
      ticks.push(i);
      return state.tick;
    },
    close: async (i) => {
      calls.push(`close:${i.eventId}`);
      closes.push(i);
      return state.close;
    },
    rb05: async (i) => {
      calls.push(`rb05:${i.eventId}`);
      return state.rb05;
    },
    confirmRb05: async (i) => {
      calls.push(`confirm:${i.eventId}`);
      return state.confirm;
    },
    closeArrivalSlots: async (i) => {
      calls.push(`arrival:${i.eventId}:${i.gen}`);
      return state.arrival;
    },
  };
  const published: string[] = [];
  const publish = { run: async (i: { eventId: string }) => (published.push(i.eventId), { status: 'PUBLISHED' }) };
  const elector = { generation: () => state.gen };
  const seen: string[] = [];
  const controlEvents: ({ e: string } & ControlEvent)[] = [];
  const metrics = {
    event: () => undefined,
    control: (e: string, r: ControlEvent) => void controlEvents.push({ e, ...r }),
    openGaps: (n: number) => void seen.push(`gaps:${n}`),
    loop: () => undefined,
    leader: () => undefined,
    fenced: () => undefined,
    leaseFailure: () => undefined,
    publish: (status: string) => void seen.push(`publish:${status}`),
    forget: (e: string) => void seen.push(`forget:${e}`),
  };
  const warned: string[] = [];
  const logger = { warn: (_o: unknown, msg: string) => void warned.push(msg), error: (_o: unknown, msg: string) => void warned.push(msg), info: () => undefined };
  const leader = new AdmissionLeader(store, publish, elector, clock, logger as never, metrics as never, o.reader);
  return { clock, calls, ticks, closes, state, leader, published, publish, seen, store, warned, controlEvents };
}

describe('교체 순서', () => {
  test('[Q-T30] 리더가되면_진행중인회차마다세대부터올리고_리더상태를읽은뒤전진한다_세대는한번만올린다', async () => {
    const w = world();
    w.state.gen = 3;
    await w.leader.tick();
    await w.leader.tick();
    // RB-05 확인은 회차마다 1초에 한 번이라 두 번째 주기에는 없다
    expect(w.calls.filter((c) => c !== 'events')).toEqual(['bump:e1:3', 'control', 'tick:e1:3', 'rb05:e1', 'arrival:e1:3', 'control', 'tick:e1:3', 'arrival:e1:3']);
  });

  test('[Q-T30] FENCED를받으면_그세대로는더쓰지않고_새세대가오면세대부터다시올린다', async () => {
    const w = world({ bump: 'FENCED' });
    w.state.gen = 1;
    await w.leader.tick();
    await w.leader.tick();
    expect(w.calls.filter((c) => c.startsWith('bump') || c.startsWith('tick'))).toEqual(['bump:e1:1']);
    // 전진에서 FENCED를 받아도 같다
    w.state.bump = 'OK';
    w.state.gen = 2;
    w.state.tick = { kind: 'FENCED' };
    await w.leader.tick();
    await w.leader.tick();
    expect(w.calls.filter((c) => c.startsWith('bump') || c.startsWith('tick'))).toEqual(['bump:e1:1', 'bump:e1:2', 'tick:e1:2']);
  });

  test('리더가아니면_아무것도부르지않는다', async () => {
    const w = world();
    await w.leader.tick();
    expect(w.calls).toEqual([]);
  });

  test('오픈1분전부터는세대만올리고_판매종료뒤에는아무것도하지않는다', async () => {
    const early = world({ plan: { opensAtMs: T0 + 30_000 } });
    early.state.gen = 1;
    await early.leader.tick();
    expect(early.calls.filter((c) => c !== 'events')).toEqual(['bump:e1:1']);
    const far = world({ plan: { opensAtMs: T0 + 120_000 } });
    far.state.gen = 1;
    await far.leader.tick();
    expect(far.calls.filter((c) => c !== 'events')).toEqual([]);
    const ended = world({ plan: { startsAtMs: T0 + DAY - 1 } });
    ended.state.gen = 1;
    await ended.leader.tick();
    expect(ended.calls.filter((c) => c !== 'events')).toEqual([]);
  });
});

describe('전진 입력', () => {
  test('운영자목표가있으면그것을_없으면5000을쓰고_입장일시정지면전진하지않는다', async () => {
    const a = world({ ctl: { target: 1_800, paused: false } });
    a.state.gen = 1;
    await a.leader.tick();
    expect(a.ticks[0]).toMatchObject({ target: 1_800, maxAdvance: 200, ratioFloor: 0.2, saleStateFallback: 'ON_SALE', windowMs: 5_000, openBatch: true, closeAtMs: T0 - 10_000 + 2_000 });
    const b = world({ ctl: { paused: true } });
    b.state.gen = 1;
    await b.leader.tick();
    expect(b.ticks[0]).toMatchObject({ target: 5_000, maxAdvance: 0 });
  });
});

describe('닫기와 게시', () => {
  test('오픈이지났는데로비표시가없거나_구간끝이지났는데묶음표시가없으면닫고_RB05면RB-05를부른다', async () => {
    const w = world({ plan: { lobbyShuffle: true }, tick: { lobbyMarked: 0, batchMarked: 0 }, close: 'RB05' });
    w.state.gen = 1;
    await w.leader.tick();
    expect(w.calls.filter((c) => c.startsWith('close') || c.startsWith('rb05'))).toEqual(['close:e1', 'rb05:e1']);
    expect(w.closes[0]).toMatchObject({ opensAtMs: T0 - 10_000, closeAtMs: T0 - 8_000, lobbyShuffle: true, openBatch: true });
    // 표시가 다 섰으면 닫지 않는다
    const done = world();
    done.state.gen = 1;
    await done.leader.tick();
    expect(done.calls.some((c) => c.startsWith('close'))).toBe(false);
  });

  test('장애전환뒤_진입이오지않아도_리더가회차마다1초에한번RB-05를부른다(조용한회차에서잃은번호의대기자가멈추지않게, ADR-0184)', async () => {
    const w = world();
    w.state.gen = 1;
    await w.leader.tick();
    await w.leader.tick();
    expect(w.calls.filter((c) => c.startsWith('rb05'))).toEqual(['rb05:e1']);
    w.clock.advance(1_000);
    await w.leader.tick();
    expect(w.calls.filter((c) => c.startsWith('rb05'))).toEqual(['rb05:e1', 'rb05:e1']);
    // 닫기가 RB05를 돌려줘 이번 주기에 이미 불렀으면 다시 부르지 않는다
    const c = world({ tick: { batchMarked: 0 }, close: 'RB05' });
    c.state.gen = 1;
    await c.leader.tick();
    expect(c.calls.filter((x) => x.startsWith('rb05'))).toEqual(['rb05:e1']);
  });

  test('[Q-T16] 리더는_주기마다도착시각칸닫기를부르고_FENCED면그세대를멈춘다', async () => {
    const w = world();
    w.state.gen = 1;
    await w.leader.tick();
    expect(w.calls.filter((c) => c.startsWith('arrival'))).toEqual(['arrival:e1:1']);
    const fenced = world({ arrival: { kind: 'FENCED', slots: 0, returned: 0 } });
    fenced.state.gen = 1;
    await fenced.leader.tick();
    fenced.calls.length = 0;
    fenced.clock.advance(1_000);
    await fenced.leader.tick();
    expect(fenced.calls.filter((c) => c.startsWith('tick'))).toEqual([]);
  });

  test('[Q-T13] RB05가건너뛰었거나_확인전이면_이어서복제를확인하고_확인이안되면회차마다10초에한번경고한다(ADR-0186)', async () => {
    const w = world();
    w.state.gen = 1;
    // 세대 키가 같고 확인할 것도 없으면 확인하지 않는다
    await w.leader.tick();
    expect(w.calls.filter((c) => c.startsWith('confirm'))).toEqual([]);
    // 건너뛰었으면 이어서 확인한다
    w.state.rb05 = { kind: 'SKIPPED', start: 2, end: 11, gen: 2 };
    w.clock.advance(1_000);
    await w.leader.tick();
    expect(w.calls.filter((c) => c.startsWith('rb05') || c.startsWith('confirm')).slice(-2)).toEqual(['rb05:e1', 'confirm:e1']);
    // 복제본이 받지 못해 확인이 안 되면 경고하고, 다음 1초에 다시 확인한다
    w.state.rb05 = { kind: 'PENDING' };
    w.state.confirm = 'WAITING';
    w.clock.advance(1_000);
    await w.leader.tick();
    w.clock.advance(1_000);
    await w.leader.tick();
    expect(w.calls.filter((c) => c.startsWith('confirm')).length).toBe(3);
    expect(w.warned.filter((m) => m.includes('RB-05 복제 확인 대기')).length).toBe(1);
  });

  test('복제확인이끝나기전에는_다음주기에새확인을띄우지않고(회차마다하나)_멈출때진행중인확인을기다린다(ADR-0186)', async () => {
    const w = world();
    w.state.gen = 1;
    w.state.rb05 = { kind: 'SKIPPED', start: 2, end: 11, gen: 2 };
    let release!: () => void;
    let confirms = 0;
    w.store.confirmRb05 = () => (confirms++, new Promise<'CONFIRMED'>((r) => (release = () => r('CONFIRMED'))));
    await w.leader.tick();
    w.state.rb05 = { kind: 'PENDING' };
    w.clock.advance(1_000);
    await w.leader.tick();
    expect(confirms).toBe(1);
    let stopped = false;
    const stopping = w.leader.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  test('복제확인대기경고와_확인실패오류는_10초제한을나눠쓰지않아서로를가리지않는다(ADR-0186)', async () => {
    const w = world();
    w.state.gen = 1;
    w.state.rb05 = { kind: 'PENDING' };
    w.state.confirm = 'WAITING';
    await w.leader.tick();
    await new Promise((r) => setTimeout(r, 0));
    w.store.confirmRb05 = async () => Promise.reject(new Error('WAIT 실패'));
    w.clock.advance(1_000);
    await w.leader.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.warned.filter((m) => m.includes('RB-05 복제 확인 대기')).length).toBe(1);
    expect(w.warned.filter((m) => m.includes('RB-05 복제 확인 실패')).length).toBe(1);
  });

  test('구간끝전에는묶음을닫지않는다', async () => {
    const w = world({ plan: { opensAtMs: T0 - 500 }, tick: { batchMarked: 0 } });
    w.state.gen = 1;
    await w.leader.tick();
    expect(w.calls.some((c) => c.startsWith('close'))).toBe(false);
  });

  test('묶음이닫혔고게시전이거나다시쓰기표시가있으면게시를부르고_게시뒤에는부르지않는다', async () => {
    const before = world({ tick: { batchPublished: 0 } });
    before.state.gen = 1;
    await before.leader.tick();
    expect(before.published).toEqual(['e1']);
    const repair = world({ tick: { batchPublished: 1, repair: 1 } });
    repair.state.gen = 1;
    await repair.leader.tick();
    expect(repair.published).toEqual(['e1']);
    const after = world();
    after.state.gen = 1;
    await after.leader.tick();
    expect(after.published).toEqual([]);
  });

  test('게시뒤참가자가바뀌었으면_그회차의게시를멈추고다시부르지않는다', async () => {
    const w = world({ tick: { batchPublished: 1, repair: 1 } });
    let n = 0;
    w.publish.run = async () => {
      n++;
      throw new BatchMembersChanged('e1', 1);
    };
    w.state.gen = 1;
    await w.leader.tick();
    await w.leader.tick();
    expect(n).toBe(1);
  });
});

describe('게시는 루프를 막지 않는다', () => {
  test('게시는뒤에서돌아_주기가게시를기다리지않고_도는동안같은회차의게시를다시시작하지않는다', async () => {
    const w = world({ tick: { batchPublished: 0 } });
    let release!: () => void;
    let started = 0;
    w.publish.run = () => {
      started++;
      return new Promise((r) => (release = () => r({ status: 'PUBLISHED' })));
    };
    w.state.gen = 1;
    await w.leader.tick();
    await w.leader.tick();
    expect(started).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    await w.leader.tick();
    expect(started).toBe(2);
    expect(w.seen.filter((x) => x.startsWith('publish'))).toEqual(['publish:PUBLISHED']);
  });

  test('전진뒤리더세대가바뀌었으면_게시를시작하지않는다', async () => {
    const w = world({ tick: { batchPublished: 0 } });
    const tick = w.store.tick;
    w.store.tick = async (i) => {
      const r = await tick(i);
      w.state.gen = 2;
      return r;
    };
    w.state.gen = 1;
    await w.leader.tick();
    expect(w.published).toEqual([]);
  });

  test('게시결과를상태별로센다_복제본을기다리는중도센다', async () => {
    const w = world({ tick: { batchPublished: 0 } });
    w.publish.run = async () => ({ status: 'WAITING_REPLICA' });
    w.state.gen = 1;
    await w.leader.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.seen).toContain('publish:WAITING_REPLICA');
  });
});

describe('끝난 회차', () => {
  test('목록에서빠진회차는_메모리상태와회차이름표지표를지운다', async () => {
    const w = world();
    w.state.gen = 1;
    await w.leader.tick();
    w.store.activeEvents = async () => [];
    w.clock.advance(1_001);
    await w.leader.tick();
    expect(w.seen).toContain('forget:e1');
  });
});

describe('종료와 게시 실패', () => {
  test('멈출때_뒤에서도는게시가끝나기를기다린다', async () => {
    const w = world({ tick: { batchPublished: 0 } });
    let release!: () => void;
    let done = false;
    w.publish.run = () =>
      new Promise((r) =>
        (release = () => {
          done = true;
          r({ status: 'PUBLISHED' });
        }),
      );
    w.state.gen = 1;
    await w.leader.tick();
    let stopped = false;
    const stopping = w.leader.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect([done, stopped]).toEqual([false, false]);
    release();
    await stopping;
    expect([done, stopped]).toEqual([true, true]);
  });

  test('게시가예외로끝나면_ERROR로센다', async () => {
    const w = world({ tick: { batchPublished: 0 } });
    w.publish.run = async () => Promise.reject(new Error('파일을 못 씀'));
    w.state.gen = 1;
    await w.leader.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.seen).toContain('publish:ERROR');
  });

  test('목록에서빠졌다가다시온회차는_세대부터다시올린다', async () => {
    const w = world();
    w.state.gen = 1;
    await w.leader.tick();
    const list = w.store.activeEvents;
    w.store.activeEvents = async () => [];
    w.clock.advance(1_001);
    await w.leader.tick();
    w.store.activeEvents = list;
    w.clock.advance(1_001);
    await w.leader.tick();
    expect(w.calls.filter((c) => c.startsWith('bump'))).toEqual(['bump:e1:1', 'bump:e1:1']);
  });
});

describe('판매 상태', () => {
  test('판매상태를모르는주기에는_그회차에서마지막으로본상태를넘긴다', async () => {
    const w = world({ tick: { saleState: 'ALL_HELD' } });
    w.state.gen = 1;
    await w.leader.tick();
    w.clock.advance(250);
    await w.leader.tick();
    expect(w.ticks.map((t) => t.saleStateFallback)).toEqual(['ON_SALE', 'ALL_HELD']);
  });

  test('리더세대가바뀌면_앞세대에서본판매상태를버리고처음값으로시작한다', async () => {
    const w = world({ tick: { saleState: 'ALL_HELD' } });
    w.state.gen = 1;
    await w.leader.tick();
    w.state.gen = 2;
    w.clock.advance(250);
    await w.leader.tick();
    expect(w.ticks.map((t) => t.saleStateFallback)).toEqual(['ON_SALE', 'ON_SALE']);
  });
});

describe('자동 제어(HOT-030, ADR-0226)', () => {
  const ok = (value: number, atMs: number): Reading => ({ ok: true, value, atMs });
  const healthy = (atMs: number, p99 = 0.02): EventInputs => {
    const budget = new Map<string, Reading>();
    for (const j of ALL_JOURNEYS) for (const k of ['alert', 'burn50']) budget.set(`${j}:${k}`, ok(0, atMs));
    return { latency: ok(p99, atMs), errors: ok(0, atMs), seatStore: ok(0, atMs), budget, pgCause: false };
  };
  const readerOf = (f: () => EventInputs): ControlInputsReader => ({ read: async () => ({ forEvent: f }) });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test('[Q-T42] 입력을읽기전에는판단하지않고_읽은뒤혼잡표본이면목표를줄여기억을TickInput에싣는다', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const reader: ControlInputsReader = {
      read: async () => {
        await gate;
        return { forEvent: () => healthy(T0, 9) };
      },
    };
    const w = world({ reader });
    w.state.gen = 1;
    await w.leader.tick();
    expect(w.ticks[0]).toMatchObject({ target: 5_000, fields: {} });
    release();
    await flush();
    await w.leader.tick();
    expect(w.ticks[1]).toMatchObject({ target: 2_500 });
    expect(w.ticks[1]?.fields?.aimdTarget).toBe('2500');
    expect(w.controlEvents.at(-1)).toMatchObject({ e: 'e1', target: 2_500, decreases: [expect.objectContaining({ reason: 'aimd' })] });
  });

  test('[Q-T42] [ASVS v5.0.0-16.5.2] 입력이끊기면_목표를그대로두고_입력없음을ctl에쓴다', async () => {
    const stale: EventInputs = { ...healthy(T0), latency: { ok: false, why: 'missing' } };
    const w = world({ reader: readerOf(() => stale) });
    w.state.gen = 1;
    await w.leader.tick();
    await flush();
    await w.leader.tick();
    expect(w.ticks[1]).toMatchObject({ target: 5_000 });
    expect(w.ticks[1]?.fields?.inputStale).toBe('1');
    expect(w.controlEvents.at(-1)?.staleKinds).toEqual(['downstream_latency']);
  });

  test('[Q-T42] 입력읽기가실패해도_주기는이어지고_마지막값을쓰다가_낡으면입력없음이다', async () => {
    let calls = 0;
    const reader: ControlInputsReader = {
      read: async () => {
        calls += 1;
        if (calls === 1) return { forEvent: () => healthy(T0, 9) };
        throw new Error('읽기 실패');
      },
    };
    const w = world({ reader });
    w.state.gen = 1;
    await w.leader.tick();
    await flush();
    w.clock.advance(1_100);
    await w.leader.tick();
    await flush();
    expect(w.ticks).toHaveLength(2);
    // 두 번째 주기는 첫 읽기의 혼잡 표본(1.1초 전, 아직 신선하다)을 그대로 쓴다
    expect(w.controlEvents.at(-1)?.staleKinds).toEqual([]);
    expect(w.ticks[1]?.target).toBe(2_500);
    expect(w.warned.some((m) => m.includes('제어 입력'))).toBe(true);
    w.clock.advance(31_000);
    await w.leader.tick();
    await flush();
    expect(w.controlEvents.at(-1)?.staleKinds).toContain('downstream_latency');
  });

  test('[Q-T67] 입력리더가없으면_자동제어를끄고목표는5000이고_안전범위는지킨다', async () => {
    const w = world();
    w.state.gen = 1;
    await w.leader.tick();
    expect(w.ticks[0]).toMatchObject({ target: 5_000, fields: {} });
    const low = world({ ctl: { target: 10, paused: false } });
    low.state.gen = 1;
    await low.leader.tick();
    expect(low.ticks[0]).toMatchObject({ target: 1_000 });
  });

  test('[Q-T67] [ASVS v5.0.0-2.3.2] 결제사상한은_cfg의칸으로_목표와전진속도를깎고_명령6칸이이긴다', async () => {
    const a = world({ plan: { pgKey: 'portone', pgTps: 50 }, tick: { waiting: 10 } });
    a.state.gen = 1;
    await a.leader.tick();
    expect(a.ticks[0]).toMatchObject({ target: 4_500, maxAdvance: 10 });
    const b = world({ plan: { pgKey: 'portone', pgTps: 50 }, ctl: { paused: false, pgKey: 'toss', pgTps: 300 } });
    b.state.gen = 1;
    await b.leader.tick();
    expect(b.ticks[0]).toMatchObject({ target: 5_000, maxAdvance: 60 });
  });

  test('[Q-T67] 회차둘이합산상한을넘으면_첫주기부터수요에비례해나눈다', async () => {
    const w = world({ ids: ['e1', 'e2'], tick: { waiting: 5 } });
    w.state.gen = 1;
    await w.leader.tick();
    expect(w.ticks.map((t) => t.target)).toEqual([2_500, 2_500]);
    await w.leader.tick();
    expect(w.ticks.slice(2).map((t) => t.target)).toEqual([2_500, 2_500]);
  });

  test('[Q-T67] 진행중인회차의오픈간격이가까우면_지표와로그를내고_막지는않는다_같은위반은한번만남긴다', async () => {
    const w = world({ ids: ['e1', 'e2'] });
    w.state.gen = 1;
    await w.leader.tick();
    expect(w.seen).toContain('gaps:1');
    expect(w.warned.filter((m) => m.includes('오픈 간격'))).toHaveLength(1);
    expect(w.ticks).toHaveLength(2);
    w.clock.advance(11_000);
    await w.leader.tick();
    w.clock.advance(11_000);
    await w.leader.tick();
    expect(w.warned.filter((m) => m.includes('오픈 간격'))).toHaveLength(1);
  });
});

// 실제 저장소처럼 ctl 칸을 이어 주는 가짜 저장소로, 주기를 넘어 기억이 왕복하는지 본다(리뷰 재현)
describe('칸을 잇는 저장소로 본 자동 제어(HOT-030 리뷰)', () => {
  const ok = (value: number, atMs: number): Reading => ({ ok: true, value, atMs });
  const healthy = (atMs: number, p99 = 0.02): EventInputs => {
    const budget = new Map<string, Reading>();
    for (const j of ALL_JOURNEYS) for (const k of ['alert', 'burn50']) budget.set(`${j}:${k}`, ok(0, atMs));
    return { latency: ok(p99, atMs), errors: ok(0, atMs), seatStore: ok(0, atMs), budget, pgCause: false };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  interface L {
    ids: string[];
    pg?: { pgKey: string; pgTps: number };
    tick?: (e: string) => Partial<TickResult>;
    controlThrows?: Set<string>;
    platformThrows?: boolean;
    p99?: number;
  }
  function linked(o: L) {
    const clock = fakeClock({ now: T0 });
    const ctl = new Map<string, Map<string, string>>();
    const c = (e: string) => ctl.get(e) ?? ctl.set(e, new Map()).get(e)!;
    const ticks: TickInput[] = [];
    const state = { gen: 1 as number | undefined, ids: o.ids };
    const store = {
      activeEvents: async () => state.ids,
      schedule: async () => ({ opensAtMs: T0 - 10_000, startsAtMs: T0 + 3 * DAY, lobbyShuffle: false, openBatch: false, ...(o.pg ?? {}) }),
      control: async (e: string): Promise<Control> => {
        if (o.controlThrows?.has(e)) throw new Error('샤드 오류');
        const memory: Record<string, string | null> = {};
        for (const f of MEMORY_FIELDS) memory[f] = c(e).get(f) ?? null;
        return { paused: false, operator: { value: null, untilMs: null, resumeAtMs: null }, memory };
      },
      platformControl: async () => {
        if (o.platformThrows) throw new Error('샤드 오류');
        return { autoStopped: false };
      },
      bump: async () => 'OK' as const,
      tick: async (i: TickInput) => {
        ticks.push(i);
        c(i.eventId).set('targetNow', String(i.target));
        for (const [k, v] of Object.entries(i.fields ?? {})) c(i.eventId).set(k, v);
        return { ...OK, waiting: 5, ...(o.tick?.(i.eventId) ?? {}) } as TickResult;
      },
      close: async () => 'OK' as const,
      rb05: async () => ({ kind: 'DONE' }) as Rb05Result,
      confirmRb05: async () => 'CONFIRMED' as const,
      closeArrivalSlots: async () => ({ kind: 'NONE', slots: 0, returned: 0 }) as ArrivalCloseResult,
    } satisfies LeaderStore;
    const reader: ControlInputsReader = {
      read: async () => {
        const at = Math.floor(clock.now() / 5_000) * 5_000;
        return { forEvent: () => healthy(at, o.p99) };
      },
    };
    const leader = new AdmissionLeader(store, { run: async () => ({ status: 'PUBLISHED' }) }, { generation: () => state.gen }, clock, undefined, undefined, reader);
    const runFor = async (ms: number) => {
      for (let t = 0; t < ms; t += 200) {
        clock.advance(200);
        await leader.tick();
        await new Promise((r) => setImmediate(r));
      }
    };
    return { clock, c, ticks, state, runFor, leader };
  }

  test('[Q-T42] 새회차에서3분정상입력이면_칸을처음부터쓰고6번증액한다', async () => {
    const w = linked({ ids: ['e1'] });
    await w.runFor(182_000);
    expect(w.c('e1').get('aimdTarget')).toBe('5600');
    expect(w.c('e1').get('aimdChangeAt')).toBeTruthy();
  });

  test('[Q-T67] 시작값이상한을넘으면_결제사상한감축으로센다', async () => {
    const w = linked({ ids: ['e1'], pg: { pgKey: 'p', pgTps: 50 }, p99: 0.02 });
    await w.runFor(400);
    expect(w.c('e1').get('aimdTarget')).toBe('4500');
    expect(JSON.parse(w.c('e1').get('lastDecrease')!)).toMatchObject({ reason: 'pg_cap', from: 5_000, to: 4_500 });
  });

  test('[Q-T67] 회차둘이나눈뒤한쪽이끝나면_남은회차는자기목표로돌아온다_나눈값이자기목표로굳지않는다', async () => {
    const w = linked({ ids: ['e1', 'e2'] });
    await w.runFor(2_000);
    expect(w.c('e1').get('targetNow')).toBe('2500');
    expect(w.c('e1').get('aimdTarget')).toBe('5000');
    w.state.ids = ['e1'];
    w.clock.advance(1_100);
    await w.runFor(5_000);
    expect(w.c('e1').get('targetNow')).toBe('5000');
  });

  test('[Q-T42] 다시리더가되면_옛입력사본으로입력없음이되지않고_첫읽기뒤에판단한다', async () => {
    const w = linked({ ids: ['e1'] });
    await w.runFor(2_000);
    w.state.gen = undefined;
    await w.runFor(300_000);
    w.state.gen = 2;
    await w.leader.tick();
    expect(w.c('e1').get('inputStale')).not.toBe('1');
    await flush();
    await w.runFor(12_000);
    expect(w.c('e1').get('inputStale')).toBe('0');
    expect(w.c('e1').get('aimdRecoveredAt') || null).toBeNull();
  });

  test('[Q-T67] 매진회차는_합산몫을가져가지않는다', async () => {
    const w = linked({ ids: ['soldout', 'live'], tick: (e) => (e === 'soldout' ? { saleState: 'SOLD_OUT', waiting: 100_000, slots: 0 } : { waiting: 50_000 }) });
    await w.runFor(3_000);
    expect(w.c('live').get('targetNow')).toBe('5000');
    expect(w.c('soldout').get('targetNow')).toBe('0');
  });

  test('[Q-T67] 준비가실패한회차의마지막몫은_합산에남는다', async () => {
    const fail = new Set<string>();
    const w = linked({ ids: ['e1', 'e2'], controlThrows: fail });
    await w.runFor(1_000);
    fail.add('e2');
    await w.runFor(1_000);
    expect(Number(w.c('e1').get('targetNow')) + Number(w.c('e2').get('targetNow'))).toBeLessThanOrEqual(5_000);
  });

  test('[Q-T67] 같은결제사회차다섯의_1초전진합은승인상한안이다', async () => {
    const w = linked({ ids: ['a', 'b', 'c', 'd', 'e'], pg: { pgKey: 'p', pgTps: 20 } });
    await w.runFor(1_000);
    const sum = w.ticks.reduce((x, t) => x + t.maxAdvance, 0);
    expect(sum).toBeLessThanOrEqual(20);
    expect(sum).toBeGreaterThanOrEqual(15);
  });

  test('[Q-T42] 명령11을읽지못하면_모르는동안자동판단을멈춘다', async () => {
    const w = linked({ ids: ['e1'], platformThrows: true, p99: 9 });
    await w.runFor(6_000);
    expect(w.c('e1').get('targetNow')).toBe('5000');
    expect(w.c('e1').get('lastDecrease') || null).toBeNull();
  });
});
