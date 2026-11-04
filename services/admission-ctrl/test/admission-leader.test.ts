// 리더 루프의 순서(docs/features/queue-admission.md §5, ADR-0056 결정 3, ADR-0182): 리더가 되면 진행 중인 회차마다 세대부터 올리고,
// 리더 상태를 읽은 뒤 전진한다. FENCED를 받으면 그 세대로는 더 쓰지 않는다. 로비·묶음 닫기와 게시를 필요할 때 부른다.
// 저장소(Lua)의 뜻은 test-int/leader-store.int.test.ts가 실제 Valkey로 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { AdmissionLeader } from '../src/modules/leader/application/admission-leader.js';
import type { CloseInput, EventPlan, LeaderStore, Rb05Result, TickInput, TickResult } from '../src/modules/leader/domain/ports.js';
import { BatchMembersChanged } from '../src/modules/batch/application/publish-batch-results.js';

const T0 = Date.UTC(2026, 10, 3, 3, 0, 0);
const DAY = 86_400_000;
const OK: TickResult = { kind: 'OK', serving: 0, advanced: 0, slots: 0, soon: 0, inFlight: 0, dropped: 0, lobbyMarked: 1, batchMarked: 1, batchPublished: 1, repair: 0, ratio: 1, saleState: 'ON_SALE' };

function world(o: { plan?: Partial<EventPlan>; tick?: Partial<TickResult> | TickResult; bump?: 'OK' | 'FENCED'; close?: 'OK' | 'NONE' | 'FENCED' | 'RB05' | 'EARLY'; ctl?: { target?: number; paused: boolean } } = {}) {
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
    rb05: { kind: 'DONE' } as Rb05Result,
    confirm: 'CONFIRMED' as 'CONFIRMED' | 'WAITING' | 'NONE',
  };
  const store: LeaderStore = {
    activeEvents: async () => {
      calls.push('events');
      return ['e1'];
    },
    schedule: async () => plan,
    control: async () => {
      calls.push('control');
      return o.ctl ?? { paused: false };
    },
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
  };
  const published: string[] = [];
  const publish = { run: async (i: { eventId: string }) => (published.push(i.eventId), { status: 'PUBLISHED' }) };
  const elector = { generation: () => state.gen };
  const seen: string[] = [];
  const metrics = {
    event: () => undefined,
    loop: () => undefined,
    leader: () => undefined,
    fenced: () => undefined,
    leaseFailure: () => undefined,
    publish: (status: string) => void seen.push(`publish:${status}`),
    forget: (e: string) => void seen.push(`forget:${e}`),
  };
  const warned: string[] = [];
  const logger = { warn: (_o: unknown, msg: string) => void warned.push(msg), error: (_o: unknown, msg: string) => void warned.push(msg), info: () => undefined };
  const leader = new AdmissionLeader(store, publish, elector, clock, logger as never, metrics as never);
  return { clock, calls, ticks, closes, state, leader, published, publish, seen, store, warned };
}

describe('교체 순서', () => {
  test('[Q-T30] 리더가되면_진행중인회차마다세대부터올리고_리더상태를읽은뒤전진한다_세대는한번만올린다', async () => {
    const w = world();
    w.state.gen = 3;
    await w.leader.tick();
    await w.leader.tick();
    // RB-05 확인은 회차마다 1초에 한 번이라 두 번째 주기에는 없다
    expect(w.calls.filter((c) => c !== 'events')).toEqual(['bump:e1:3', 'control', 'tick:e1:3', 'rb05:e1', 'control', 'tick:e1:3']);
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
    const a = world({ ctl: { target: 800, paused: false } });
    a.state.gen = 1;
    await a.leader.tick();
    expect(a.ticks[0]).toMatchObject({ target: 800, maxAdvance: 200, ratioFloor: 0.2, saleStateFallback: 'ON_SALE', windowMs: 5_000, openBatch: true, closeAtMs: T0 - 10_000 + 2_000 });
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
