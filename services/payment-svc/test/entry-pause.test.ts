// 새 결제 일시 정지 읽기(docs/features/payment.md §2 '새 결제 일시 정지 읽기의 첫 구현'·§9, ADR-0085·0105, P-T43, BUILD_ORDER PRF-201).
// 정지 판단 표, 회차별 판단, 입력 검사, 파드 캐시, 조회 쓰임새, 지표를 본다. 실제 PostgreSQL과 gRPC까지 잇는 것은 test-int/payment-new-pause.int.test.ts가 본다.
import { fakeClock, PlatformMetrics } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PromPaymentCheckoutSignals } from '../src/modules/payment/adapters/prom-payment-checkout-signals.js';
import { CachedEntryPauseReader, ENTRY_PAUSE_CACHE_READ_BUDGET_MS, ENTRY_PAUSE_CACHE_TTL_MS, ENTRY_PAUSE_MAX_STALE_MS } from '../src/modules/payment/application/entry-pause-cache.js';
import { GetNewPaymentPause } from '../src/modules/payment/application/get-new-payment-pause.js';
import { PaymentDeadlineError, PaymentInputError } from '../src/modules/payment/domain/confirm-command.js';
import { type EntryPauseRow, type EntryPauses, eventPausedSinceMs, GET_NEW_PAYMENT_PAUSE_MAX_EVENTS, isEntryPaused, parseGetPauseEventIds, PaymentNewPausedError } from '../src/modules/payment/domain/entry-pause.js';
import { PAY_METHODS, type PayMethod, type PgName } from '../src/modules/payment/domain/payment-gateway.js';
import { basePgOf, type PgChannel, type PgChannelTable, type PgSelectionState } from '../src/modules/payment/domain/pg-selection.js';
import type { CallBudget, EntryPauseReader } from '../src/modules/payment/domain/ports.js';

const ON: PgChannel = { active: true, payMethods: new Set<PayMethod>(PAY_METHODS) };
const OFF: PgChannel = { active: false, payMethods: new Set<PayMethod>(PAY_METHODS) };
const CHANNELS: PgChannelTable = new Map<PgName, PgChannel>([
  ['TOSS', ON],
  ['PORTONE', ON],
]);
const DEFAULTS = { primary: 'TOSS', fallback: 'PORTONE' } as const;
const NOW = Date.parse('2026-11-09T03:00:00.000Z');
const EVENT_A = '11111111-1111-7111-8111-111111111111';
const EVENT_B = '22222222-2222-7222-8222-222222222222';

const row = (o: Partial<EntryPauseRow> = {}): EntryPauseRow => ({ pg: 'TOSS', stage: 'PROBING', reason: 'PG_FAILURE', sinceMs: NOW, version: 1, ...o });
const pausesOf = (...rows: EntryPauseRow[]): EntryPauses => new Map(rows.map((r) => [r.pg, r]));

describe('isEntryPaused: 정지 판단 표', () => {
  test.each<[string, EntryPauseRow | undefined, boolean]>([
    ['행이 없으면 열림', undefined, false],
    ['OPEN은 열림', row({ stage: 'OPEN' }), false],
    ['확인 호출은 정지', row({ stage: 'PROBING' }), true],
    ['시험 재개도 정지', row({ stage: 'TRIAL' }), true],
    ['채널 상한으로 멈춘 행도 정지', row({ reason: 'CHANNEL_WAIT' }), true],
  ])('P-T43_%s', (_name, input, want) => {
    expect(isEntryPaused(input)).toBe(want);
  });
});

describe('basePgOf: 회차가 쓸 결제사', () => {
  test.each<[string, PgSelectionState, PgName]>([
    ['전환·지정이 없으면 플랫폼 기본', {}, 'TOSS'],
    ['회차 지정이 앞선다', { assignment: { primary: 'PORTONE' } }, 'PORTONE'],
    ['전환이 켜지면 전환 대상이다', { platformSwitch: { scope: 'PLATFORM', active: true, toPg: 'PORTONE', version: 1, changedAtMs: NOW } }, 'PORTONE'],
    ['전환이 꺼져 있으면 기준이다', { platformSwitch: { scope: 'PLATFORM', active: false, toPg: 'PORTONE', version: 1, changedAtMs: NOW } }, 'TOSS'],
  ])('P-T43_%s', (_name, state, want) => {
    expect(basePgOf({ ...state, defaults: DEFAULTS })).toBe(want);
  });
});

describe('eventPausedSinceMs: 회차별 판단', () => {
  const input = (o: { pauses?: EntryPauses; channels?: PgChannelTable; state?: PgSelectionState } = {}) => ({ ...o.state, defaults: DEFAULTS, channels: o.channels ?? CHANNELS, pauses: o.pauses ?? pausesOf() });

  test('P-T43_회차의 결제사가 정지면 행의 시작 시각이다', () => {
    expect(eventPausedSinceMs(input({ pauses: pausesOf(row({ sinceMs: NOW + 5 })) }))).toBe(NOW + 5);
  });

  test('P-T43_시험 재개 동안에도 그 회차를 돌려준다(ADR-0105)', () => {
    expect(eventPausedSinceMs(input({ pauses: pausesOf(row({ stage: 'TRIAL' })) }))).toBe(NOW);
  });

  test('P-T43_다른 결제사의 정지는 이 회차와 상관없다', () => {
    expect(eventPausedSinceMs(input({ pauses: pausesOf(row({ pg: 'PORTONE' })) }))).toBeUndefined();
  });

  test('P-T43_전환으로 옮겨 간 결제사로 판단한다', () => {
    const state: PgSelectionState = { platformSwitch: { scope: 'PLATFORM', active: true, toPg: 'PORTONE', version: 1, changedAtMs: NOW } };
    expect(eventPausedSinceMs(input({ state, pauses: pausesOf(row()) }))).toBeUndefined();
    expect(eventPausedSinceMs(input({ state, pauses: pausesOf(row({ pg: 'PORTONE', sinceMs: NOW + 9 })) }))).toBe(NOW + 9);
  });

  test('P-T43_OPEN 행과 행 없음은 열림이다', () => {
    expect(eventPausedSinceMs(input({ pauses: pausesOf(row({ stage: 'OPEN' })) }))).toBeUndefined();
    expect(eventPausedSinceMs(input())).toBeUndefined();
  });

  test.each<[string, PgChannelTable]>([
    ['채널이 없다', new Map([['PORTONE', ON]])],
    ['채널이 비활성이다', new Map([['TOSS', OFF]])],
  ])('P-T43_%s면 정지이고 paused_since는 0이다 [ASVS v5.0.0-16.5.3]', (_name, channels) => {
    expect(eventPausedSinceMs(input({ channels }))).toBe(0);
  });

  test('P-T43_채널 비활성이 정지 행보다 앞선다(시작 시각은 0)', () => {
    expect(eventPausedSinceMs(input({ channels: new Map([['TOSS', OFF]]), pauses: pausesOf(row()) }))).toBe(0);
  });
});

describe('parseGetPauseEventIds', () => {
  test('P-T43_소문자 UUID를 차례대로 돌려준다', () => {
    expect(parseGetPauseEventIds([EVENT_A, EVENT_B])).toEqual([EVENT_A, EVENT_B]);
  });

  test.each<[string, readonly string[]]>([
    ['없음', []],
    ['대문자', ['AAAAAAAA-1111-7111-8111-111111111111']],
    ['UUID가 아님', ['x']],
    ['상한 넘김', Array.from({ length: GET_NEW_PAYMENT_PAUSE_MAX_EVENTS + 1 }, () => EVENT_A)],
  ])('P-T43_%s는 입력 오류다 [ASVS v5.0.0-2.2.1]', (_name, ids) => {
    expect(() => parseGetPauseEventIds(ids)).toThrow(PaymentInputError);
  });

  test('P-T43_상한 200개까지 받는다 [ASVS v5.0.0-2.2.1]', () => {
    expect(GET_NEW_PAYMENT_PAUSE_MAX_EVENTS).toBe(200);
    expect(parseGetPauseEventIds(Array.from({ length: 200 }, () => EVENT_A))).toHaveLength(200);
  });
});

describe('PaymentNewPausedError', () => {
  test('P-T43_코드는 FAILED_PRECONDITION이고 글은 new-payment-paused다', () => {
    expect(new PaymentNewPausedError()).toMatchObject({ code: 'FAILED_PRECONDITION', message: 'new-payment-paused' });
  });
});

describe('CachedEntryPauseReader', () => {
  const setup = (first: EntryPauses | Error = pausesOf()) => {
    const clock = fakeClock({ now: NOW });
    const answers: (EntryPauses | Error | Promise<EntryPauses>)[] = [first];
    const budgets: (CallBudget | undefined)[] = [];
    let failed = 0;
    const reader: EntryPauseReader = {
      read: async (budget) => {
        budgets.push(budget);
        const next = answers.length > 1 ? answers.shift()! : answers[0]!;
        if (next instanceof Error) throw next;
        return next;
      },
    };
    const cache = new CachedEntryPauseReader({ reader, clock, signals: { entryPauseReadFailed: () => void failed++ } });
    return { cache, clock, answers, budgets, failedCount: () => failed };
  };

  test('P-T43_1초 안에는 다시 읽지 않고 1초가 지나면 새 값을 읽는다', async () => {
    const s = setup(pausesOf());
    s.answers.push(pausesOf(row()));
    expect((await s.cache.read()).size).toBe(0);
    s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS - 1);
    expect((await s.cache.read()).size).toBe(0);
    expect(s.budgets).toHaveLength(1);
    s.clock.advance(1);
    expect((await s.cache.read()).get('TOSS')?.stage).toBe('PROBING');
    expect(s.budgets).toHaveLength(2);
  });

  test('P-T43_수명은 1초이고 저장소 읽기는 호출의 시한이 아니라 고정 150ms다', async () => {
    expect(ENTRY_PAUSE_CACHE_TTL_MS).toBe(1_000);
    expect(ENTRY_PAUSE_CACHE_READ_BUDGET_MS).toBe(150);
    const s = setup();
    await s.cache.read({ remainingMs: 5_000 });
    expect(s.budgets).toEqual([{ remainingMs: ENTRY_PAUSE_CACHE_READ_BUDGET_MS }]);
  });

  test('P-T43_겹친 호출은 읽기 하나를 함께 기다린다', async () => {
    const s = setup();
    let release = (_v: EntryPauses): void => {};
    s.answers[0] = new Promise<EntryPauses>((r) => {
      release = r;
    });
    const [a, b] = [s.cache.read(), s.cache.read()];
    release(pausesOf(row()));
    expect((await a).size).toBe(1);
    expect((await b).size).toBe(1);
    expect(s.budgets).toHaveLength(1);
  });

  test('P-T43_벽시계가 멈춰도 단조 시계로 수명을 잰다', async () => {
    const s = setup();
    s.answers.push(pausesOf(row()));
    await s.cache.read();
    s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);
    await s.cache.read();
    expect(s.budgets).toHaveLength(2);
  });

  test('P-T43_읽기가 실패하면 마지막 값을 쓰고 지표를 올리며 1초 안에는 다시 읽지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const s = setup(pausesOf(row()));
    s.answers.push(new Error('연결 끊김'));
    s.answers.push(pausesOf());
    await s.cache.read();
    s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);
    expect((await s.cache.read()).size).toBe(1);
    expect(s.failedCount()).toBe(1);
    await s.cache.read();
    expect(s.budgets).toHaveLength(2);
    s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);
    expect((await s.cache.read()).size).toBe(0);
  });

  test('P-T43_한 번도 읽지 못했으면 값을 지어내지 않고 던지며 다음 호출이 곧바로 다시 읽는다 [ASVS v5.0.0-16.5.3]', async () => {
    const boom = new Error('처음부터 실패');
    const s = setup(boom);
    s.answers.push(pausesOf(row()));
    await expect(s.cache.read()).rejects.toBe(boom);
    expect(s.failedCount()).toBe(1);
    expect((await s.cache.read()).size).toBe(1);
    expect(s.budgets).toHaveLength(2);
  });

  test('P-T43_시한 안에 읽기가 끝나지 않으면 마지막 값을 쓴다 [ASVS v5.0.0-16.5.2]', async () => {
    const s = setup(pausesOf(row()));
    await s.cache.read();
    s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);
    s.answers[0] = new Promise<EntryPauses>(() => {});
    expect((await s.cache.read({ remainingMs: 5 })).size).toBe(1);
  });

  test('P-T43_한 번도 읽지 못했는데 시한이 끝나면 PaymentDeadlineError다 [ASVS v5.0.0-16.5.3]', async () => {
    const s = setup(new Promise<EntryPauses>(() => {}) as unknown as Error);
    s.answers[0] = new Promise<EntryPauses>(() => {});
    await expect(s.cache.read({ remainingMs: 5 })).rejects.toBeInstanceOf(PaymentDeadlineError);
  });

  test('P-T43_리뷰 고침 L5: 읽기가 실패해도 마지막 값은 10초까지만 쓰고 넘으면 조회를 실패시키며, 다시 읽으면 나이를 새로 잰다 [ASVS v5.0.0-16.5.3]', async () => {
    const boom = new Error('연결 끊김');
    const s = setup(pausesOf(row()));
    s.answers.push(boom);
    await s.cache.read();
    expect(ENTRY_PAUSE_MAX_STALE_MS).toBe(10_000);
    s.clock.advance(ENTRY_PAUSE_MAX_STALE_MS);
    expect((await s.cache.read()).size).toBe(1);
    s.clock.advance(1);
    await expect(s.cache.read()).rejects.toBe(boom);
    s.answers[0] = pausesOf();
    expect((await s.cache.read()).size).toBe(0);
    s.answers[0] = boom;
    s.clock.advance(ENTRY_PAUSE_MAX_STALE_MS);
    expect((await s.cache.read()).size).toBe(0);
  });

  test('P-T43_리뷰 고침 L5: 이 호출의 시한이 끝나도 10초가 넘은 값은 쓰지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const s = setup(pausesOf(row()));
    await s.cache.read();
    s.clock.advance(ENTRY_PAUSE_MAX_STALE_MS + 1);
    s.answers[0] = new Promise<EntryPauses>(() => {});
    await expect(s.cache.read({ remainingMs: 5 })).rejects.toBeInstanceOf(PaymentDeadlineError);
  });

  test('P-T43_무효화하면 수명 안이어도 다시 읽고 다음 호출이 새 값을 받는다', async () => {
    const s = setup(pausesOf());
    s.answers.push(pausesOf(row()));
    await s.cache.read();
    s.cache.invalidate();
    expect((await s.cache.read()).size).toBe(1);
    expect(s.budgets).toHaveLength(2);
  });

  test('P-T43_읽는 도중 무효화하면 뒤에 오는 호출은 앞 읽기를 기다리지 않는다', async () => {
    const s = setup();
    let release = (_v: EntryPauses): void => {};
    s.answers[0] = new Promise<EntryPauses>((r) => {
      release = r;
    });
    s.answers.push(pausesOf(row()));
    const first = s.cache.read();
    s.cache.invalidate();
    expect((await s.cache.read()).size).toBe(1);
    release(pausesOf());
    expect((await first).size).toBe(0);
  });
});

describe('GetNewPaymentPause 쓰임새', () => {
  const setup = (o: { pauses?: EntryPauses; states?: Record<string, PgSelectionState>; channels?: PgChannelTable } = {}) => {
    const reads: string[] = [];
    const uc = new GetNewPaymentPause({
      selection: {
        readMany: async (eventIds) => {
          reads.push(...eventIds);
          return new Map(eventIds.map((eventId) => [eventId, o.states?.[eventId] ?? {}]));
        },
      },
      pauses: { read: async () => o.pauses ?? pausesOf() },
      channels: o.channels ?? CHANNELS,
      defaults: DEFAULTS,
    });
    return { uc, reads };
  };

  test('P-T43_일시 정지 중인 회차만 요청 차례대로 돌려주고 열린 회차는 빠진다', async () => {
    const s = setup({ pauses: pausesOf(row({ sinceMs: NOW + 1 })), states: { [EVENT_B]: { assignment: { primary: 'PORTONE' } } } });
    expect(await s.uc.execute([EVENT_A, EVENT_B])).toEqual([{ eventId: EVENT_A, pausedSinceMs: NOW + 1 }]);
  });

  test('P-T43_정지가 없으면 빈 목록이다', async () => {
    const s = setup();
    expect(await s.uc.execute([EVENT_A])).toEqual([]);
  });

  test('P-T43_시험 재개 동안 그 회차를 계속 돌려준다', async () => {
    const s = setup({ pauses: pausesOf(row({ stage: 'TRIAL' })) });
    expect(await s.uc.execute([EVENT_A])).toEqual([{ eventId: EVENT_A, pausedSinceMs: NOW }]);
  });

  test('P-T43_채널이 비활성이면 paused_since 0으로 돌려준다 [ASVS v5.0.0-16.5.3]', async () => {
    const s = setup({ channels: new Map([['TOSS', OFF]]) });
    expect(await s.uc.execute([EVENT_A])).toEqual([{ eventId: EVENT_A, pausedSinceMs: 0 }]);
  });

  test('P-T43_입력이 틀리면 읽지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = setup();
    await expect(s.uc.execute([])).rejects.toBeInstanceOf(PaymentInputError);
    expect(s.reads).toEqual([]);
  });

});

describe('GetNewPaymentPause 쓰임새: 회차 목록 읽기(리뷰 고침 M1)', () => {
  const setup = (o: { pauses?: EntryPauses; states?: Record<string, PgSelectionState>; fail?: Error } = {}) => {
    const calls: { ids: readonly string[]; budget: CallBudget | undefined }[] = [];
    let singleReads = 0;
    const selection = {
      read: async () => {
        singleReads += 1;
        return {};
      },
      readMany: async (ids: readonly string[], budget?: CallBudget) => {
        calls.push({ ids, budget });
        if (o.fail !== undefined) throw o.fail;
        return new Map(ids.map((id) => [id, o.states?.[id] ?? {}]));
      },
    };
    const uc = new GetNewPaymentPause({ selection, pauses: { read: async () => o.pauses ?? pausesOf() }, channels: CHANNELS, defaults: DEFAULTS });
    return { uc, calls, singleReads: () => singleReads };
  };
  const manyIds = (n: number) => Array.from({ length: n }, (_, i) => `${String(i).padStart(8, '0')}-1111-7111-8111-111111111111`);

  test('P-T43_리뷰 고침 M1: 회차 200개를 읽기 한 번으로 묻고 회차마다 읽지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const s = setup();
    const ids = manyIds(200);
    expect(await s.uc.execute(ids)).toEqual([]);
    expect(s.calls.map((c) => c.ids)).toEqual([ids]);
    expect(s.singleReads()).toBe(0);
  });

  test('P-T43_리뷰 고침 M1: 읽은 값으로 회차마다 결제사를 정한다', async () => {
    const s = setup({ pauses: pausesOf(row({ sinceMs: NOW + 1 })), states: { [EVENT_B]: { assignment: { primary: 'PORTONE' } } } });
    expect(await s.uc.execute([EVENT_A, EVENT_B])).toEqual([{ eventId: EVENT_A, pausedSinceMs: NOW + 1 }]);
    expect(s.calls).toHaveLength(1);
  });

  test('P-T43_리뷰 고침 M1: 읽기가 실패하면 호출 전체가 실패한다(일부를 열림으로 답하지 않는다) [ASVS v5.0.0-16.5.3]', async () => {
    const boom = new Error('목록 읽기 실패');
    await expect(setup({ fail: boom }).uc.execute([EVENT_A, EVENT_B])).rejects.toBe(boom);
  });

  test('P-T43_리뷰 고침 M1: 정지 행을 읽고 남은 시간이 모자라면 목록을 읽지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const s = setup();
    await expect(s.uc.execute([EVENT_A], { remainingMs: 1 })).rejects.toBeInstanceOf(PaymentDeadlineError);
    expect(s.calls).toEqual([]);
  });
});

describe('PromPaymentCheckoutSignals', () => {
  test('P-T43_정지 읽기 실패 지표와 outcome new_payment_paused를 미리 0으로 보인다', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const signals = new PromPaymentCheckoutSignals().register(metrics.registry);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/payment_checkout_prepared_total\{pg="TOSS",outcome="new_payment_paused"\} 0/);
    expect(text).toMatch(/payment_entry_pause_read_failed_total 0/);
    signals.entryPauseReadFailed();
    expect(await metrics.registry.metrics()).toMatch(/payment_entry_pause_read_failed_total 1/);
  });
});
