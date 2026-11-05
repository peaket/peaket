// 서비스 소비자의 키 단위 동시 처리와 보류(openspec 변경 add-maintenance-control-and-consumers 결정 5·6, ADR-0142 결정 1·2).
// Kafka 없이 파티션 하나의 처리기를 바깥(받기·커밋할 위치·보류 포트)에서 본다. 실제 Kafka는 kafka.int.test.ts, 보류 표는 held-events.int.test.ts.
import { Registry } from '@prometheus-io/client';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  KEYED_CONSUMER_DEFAULTS,
  KeyedConsumerMetrics,
  KeyedPartition,
  PauseGate,
  ProblemError,
  errorSummary,
  TransientError,
  isTransientError,
  type ConsumedMessage,
  type HeldEventInput,
  type HeldEventStore,
} from '../src/index.js';

interface Ev {
  order: string;
  n: number;
}

const msg = (offset: number, order: string, n = offset): ConsumedMessage => ({
  topic: 'trade.payments',
  partition: 0,
  offset: BigInt(offset),
  key: 'E1',
  value: Buffer.from(JSON.stringify({ order, n })),
  headers: {},
  timestamp: 0,
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(o: {
  handle?: (e: Ev, m: ConsumedMessage) => Promise<void>;
  initiallyHeld?: string[];
  isHeld?: (key: string) => boolean;
  maxKeys?: number;
  /** 보류 행 넣기가 처음 몇 번 연결 오류를 낸다 */
  holdFailures?: number;
  maxBuffered?: number;
  eventKeyOf?: (e: Ev) => string | undefined;
  /** 기본은 쉬지 않고 적기만 한다 */
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const handled: string[] = [];
  const held: HeldEventInput[] = [];
  const sleeps: number[] = [];
  const pauses: string[] = [];
  let holdCalls = 0;
  const store: HeldEventStore = {
    heldKeys: async () => new Set(o.initiallyHeld ?? []),
    isHeld: async (_topic, key) => (o.isHeld ? o.isHeld(key) : held.some((h) => h.businessKey === key)),
    hold: async (e) => {
      if ((o.holdFailures ?? 0) > holdCalls++) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
      held.push(e);
    },
    // 그 키가 아직 보류 중일 때만 넣는다(다시 처리와 겨루지 않게 한 문장, 코드 리뷰 2026-11-01)
    holdIfHeld: async (e) => {
      const still = o.isHeld ? o.isHeld(e.businessKey) : held.some((h) => h.businessKey === e.businessKey);
      if (still) held.push(e);
      return still;
    },
  };
  const p = new KeyedPartition<Ev>({
    topic: 'trade.payments',
    partition: 0,
    held: store,
    handler: {
      decode: (m) => JSON.parse(m.value!.toString('utf8')) as Ev,
      keyOf: (e) => e.order,
      eventKeyOf: o.eventKeyOf ?? ((e) => `ek-${e.n}`),
      handle: async (e, m) => {
        await o.handle?.(e, m);
        handled.push(`${e.order}${e.n}`);
      },
    },
    maxKeys: o.maxKeys,
    maxBuffered: o.maxBuffered,
    sleep: async (ms) => {
      sleeps.push(ms);
      await o.sleep?.(ms);
    },
    onPause: () => pauses.push('pause'),
    // 다시 시작할 때 이어 읽을 위치(받은 가장 큰 오프셋 + 1)를 함께 받는다
    onResume: (next) => pauses.push(`resume:${next}`),
  });
  return { p, handled, held, sleeps, pauses };
}

describe('ADR0142 결정1 키 단위 동시 처리', () => {
  test('ST_T18_같은키는받은순서대로_다른키는동시에_커밋위치는끝나지않은가장작은오프셋이다', async () => {
    const slow = gate();
    const h = harness({ handle: async (e) => (e.order === 'A' && e.n === 10 ? slow.opened : undefined) });
    await h.p.init();
    await h.p.push(msg(10, 'A'));
    await h.p.push(msg(11, 'B'));
    await h.p.push(msg(12, 'A'));
    await h.p.push(msg(13, 'C'));
    await tick();
    // A10이 오래 걸려도 B·C는 끝나고, A12는 A10 뒤에 기다린다
    expect(h.handled).toEqual(['B11', 'C13']);
    expect(h.p.committable()).toBe(10n);
    slow.open();
    await h.p.drain();
    expect(h.handled).toEqual(['B11', 'C13', 'A10', 'A12']);
    expect(h.p.committable()).toBe(14n);
  });

  test('ST_T18_처리중인키가한도면_새키는자리가날때까지받지않고_있는키는바로받는다 [ASVS v5.0.0-15.2.2]', async () => {
    expect(KEYED_CONSUMER_DEFAULTS.maxKeysPerPartition).toBe(32);
    const gates = new Map<string, ReturnType<typeof gate>>();
    const h = harness({
      maxKeys: 3,
      handle: async (e) => {
        if (!gates.has(e.order)) gates.set(e.order, gate());
        await gates.get(e.order)!.opened;
      },
    });
    await h.p.init();
    for (const [i, k] of ['A', 'B', 'C'].entries()) await h.p.push(msg(i, k));
    let accepted = false;
    const pushD = h.p.push(msg(3, 'D')).then(() => (accepted = true));
    await h.p.push(msg(4, 'A')); // 이미 처리 중인 키는 자리 없이 줄에 선다
    await tick();
    expect(accepted).toBe(false);
    expect(h.p.inflightKeys).toBe(3);
    gates.get('B')!.open();
    await pushD;
    expect(accepted).toBe(true);
    for (const k of ['A', 'C', 'D']) {
      await tick();
      gates.get(k)?.open();
    }
    await tick();
    gates.get('A')!.open();
    await h.p.drain();
    expect(h.handled.sort()).toEqual(['A0', 'A4', 'B1', 'C2', 'D3']);
  });

  test('ST_T18_넘기기전에는_처리중인키를마친뒤의위치를준다', async () => {
    const slow = gate();
    const h = harness({ handle: async () => slow.opened });
    await h.p.init();
    await h.p.push(msg(5, 'A'));
    let drained = false;
    const d = h.p.drain().then(() => (drained = true));
    await tick();
    expect(drained).toBe(false);
    slow.open();
    await d;
    expect(h.p.committable()).toBe(6n);
  });

  test('아무것도 받지 않았으면 커밋할 위치가 없다', async () => {
    const h = harness();
    await h.p.init();
    expect(h.p.committable()).toBeUndefined();
  });
});

describe('ADR0142 결정2 보류와 일시 실패', () => {
  test('ST_T19_같은결과일실패를5회겪은사건은보류하고_같은키뒤사건도보류하며_다른키는계속한다', async () => {
    let calls = 0;
    const h = harness({
      handle: async (e) => {
        if (e.order === 'A') {
          calls += 1;
          throw new Error('상태 전이 불가');
        }
      },
    });
    await h.p.init();
    await h.p.push(msg(0, 'A'));
    await h.p.push(msg(1, 'B'));
    await h.p.push(msg(2, 'A'));
    await h.p.push(msg(3, 'A'));
    await h.p.push(msg(4, 'C'));
    await h.p.drain();
    expect(calls).toBe(5); // 뒤 사건 둘은 처리기에 가지 않는다
    expect(h.sleeps).toEqual([200, 400, 800, 1600]);
    expect(h.handled).toEqual(['B1', 'C4']);
    expect(h.held.map((x) => [x.offset, x.businessKey, x.eventKey])).toEqual([
      [0n, 'A', 'ek-0'],
      [2n, 'A', 'ek-2'],
      [3n, 'A', 'ek-3'],
    ]);
    expect(h.held[0]!.error).toContain('상태 전이 불가');
    expect(h.held[0]!.value?.toString()).toContain('"order":"A"');
    expect(h.p.committable()).toBe(5n);
    expect(h.pauses).toEqual([]);
  });

  test('ST_T19_저장소연결실패는_보류하지않고_파티션을멈춰_늘려가며다시한다 [ASVS v5.0.0-16.5.2]', async () => {
    let calls = 0;
    const h = harness({
      handle: async (e) => {
        if (e.order !== 'A') return;
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        if (calls === 2) throw Object.assign(new Error('terminating connection'), { code: '57P01' });
        if (calls === 3) throw new TransientError('풀 대기 초과');
      },
    });
    await h.p.init();
    await h.p.push(msg(0, 'A'));
    await h.p.drain();
    expect(h.held).toEqual([]);
    expect(h.handled).toEqual(['A0']);
    expect(h.sleeps).toEqual([200, 400, 800]);
    expect(h.pauses).toEqual(['pause', 'resume:1']);
  });

  test('일시 실패 판정: 연결 오류·PostgreSQL 연결·취소·잠금 대기·직렬화 실패는 일시, 나머지는 아니다', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', '08006', '57P01', '57014', '55P03', '53300', '40001', '40P01'])
      expect(isTransientError(Object.assign(new Error(code), { code }))).toBe(true);
    expect(isTransientError(new TransientError('x'))).toBe(true);
    expect(isTransientError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toBe(true);
    for (const code of ['23505', '22P02', undefined]) expect(isTransientError(Object.assign(new Error('x'), { code }))).toBe(false);
    expect(isTransientError(new TypeError('x'))).toBe(false);
  });

  test('일시 실패 늘려 쉬기는 30초에서 멈춘다', async () => {
    let calls = 0;
    const h = harness({
      handle: async () => {
        calls += 1;
        if (calls <= 10) throw new TransientError('DB 없음');
      },
    });
    await h.p.init();
    await h.p.push(msg(0, 'A'));
    await h.p.drain();
    expect(h.sleeps.slice(0, 3)).toEqual([200, 400, 800]);
    expect(Math.max(...h.sleeps)).toBe(30_000);
    expect(h.handled).toEqual(['A0']);
  });

  test('ST_T19_파티션을받을때보류중인키를읽어두고_보류중이면처리하지않고넣으며_풀렸으면처리한다', async () => {
    let stillHeld = true;
    const h = harness({ initiallyHeld: ['A'], isHeld: () => stillHeld });
    await h.p.init();
    await h.p.push(msg(7, 'A'));
    await h.p.drain();
    expect(h.handled).toEqual([]);
    expect(h.held.map((x) => x.offset)).toEqual([7n]);
    stillHeld = false; // 다시 처리(RB-11)로 풀렸다
    await h.p.push(msg(8, 'A'));
    await h.p.drain();
    expect(h.handled).toEqual(['A8']);
  });

  test('ST_T19_값을읽지못한사건은_Kafka키로5회해본뒤보류한다', async () => {
    const h = harness();
    await h.p.init();
    await h.p.push({ ...msg(0, 'A'), value: Buffer.from('{깨진') });
    await h.p.drain();
    // 업무 키를 모르면 Kafka 키 그대로 보류한다(같은 Kafka 키를 업무 키로 쓰는 소비자의 뒤 사건도 함께 보류된다)
    expect(h.held.map((x) => [x.businessKey, x.eventKey, x.key])).toEqual([['E1', null, 'E1']]);
    expect(h.sleeps).toEqual([200, 400, 800, 1600]);
  });

  test('보류 행을 넣다가 일시 실패하면 넣을 때까지 다시 한다(그 전에는 위치를 넘기지 않는다)', async () => {
    const h = harness({ handle: async () => Promise.reject(new Error('검증 실패')), holdFailures: 2 });
    await h.p.init();
    await h.p.push(msg(0, 'A'));
    await h.p.drain();
    expect(h.held.map((x) => x.offset)).toEqual([0n]);
    expect(h.sleeps).toEqual([200, 400, 800, 1600, 200, 400]);
    expect(h.p.committable()).toBe(1n);
  });
});

describe('코드 리뷰 2026-11-01 재현', () => {
  test('ST_T18_받은사건상한에걸린push는_앞사건이끝나면커밋주기를기다리지않고받힌다 [ASVS v5.0.0-15.2.2]', async () => {
    const h = harness({ maxBuffered: 3 });
    await h.p.init();
    for (let i = 0; i < 3; i += 1) await h.p.push(msg(i, 'A'));
    let accepted = false;
    const fourth = h.p.push(msg(3, 'A')).then(() => (accepted = true));
    await Promise.race([fourth, new Promise((r) => setTimeout(r, 200))]);
    expect(accepted).toBe(true);
    await h.p.drain();
    expect(h.handled).toEqual(['A0', 'A1', 'A2', 'A3']);
  });

  test('ST_T19_일시실패로멈춘동안에는_새키도자리없이바로받는다(가져오기 멈춤을 거는 동안 받기가 막히지 않게)', async () => {
    let open = false;
    const h = harness({
      maxKeys: 1,
      handle: async (e) => {
        if (e.order === 'A' && !open) throw new TransientError('DB 없음');
      },
      sleep: () => new Promise((r) => setTimeout(r, 2)),
    });
    await h.p.init();
    await h.p.push(msg(0, 'A'));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.p.paused).toBe(true);
    let accepted = false;
    const b = h.p.push(msg(1, 'B')).then(() => (accepted = true));
    await Promise.race([b, new Promise((r) => setTimeout(r, 100))]);
    expect(accepted).toBe(true);
    open = true;
    await h.p.drain();
    expect(h.handled.sort()).toEqual(['A0', 'B1']);
    expect(h.pauses).toEqual(['pause', 'resume:2']);
  });

  test('ST_T19_eventKey를꺼내다던져도_보류하고_처리가멈추지않는다', async () => {
    const h = harness({
      handle: async () => Promise.reject(new Error('검증 실패')),
      eventKeyOf: () => {
        throw new Error('eventKey 칸 없음');
      },
    });
    await h.p.init();
    await h.p.push(msg(0, 'A'));
    await h.p.drain();
    expect(h.held.map((x) => [x.offset, x.eventKey])).toEqual([[0n, null]]);
    expect(h.p.committable()).toBe(1n);
  });

  test('ST_T19_보류행에는Kafka키와레코드시각도남긴다(다시 처리 때 그대로 넘긴다)', async () => {
    const h = harness({ handle: async () => Promise.reject(new Error('x')) });
    await h.p.init();
    await h.p.push({ ...msg(4, 'A'), timestamp: 1_700_000_000_000 });
    await h.p.drain();
    expect(h.held[0]).toMatchObject({ key: 'E1', timestamp: 1_700_000_000_000 });
  });
});

describe('코드 리뷰 2026-11-01 둘째 재현', () => {
  test('ST_T18_다시시작위치는받은가장큰오프셋다음이고_다시배달된사건은버린다', async () => {
    let open = false;
    const h = harness({
      handle: async (e) => {
        if (e.order === 'A' && !open) throw new TransientError('DB 없음');
      },
      sleep: () => new Promise((r) => setTimeout(r, 2)),
    });
    await h.p.init();
    await h.p.push(msg(5, 'A'));
    await new Promise((r) => setTimeout(r, 10));
    await h.p.push(msg(6, 'B'));
    open = true;
    await h.p.drain();
    expect(h.pauses).toEqual(['pause', 'resume:7']);
    // 다시 시작하며 같은 사건이 다시 오면 버린다(한 번만 처리하고 커밋 위치가 멈추지 않는다)
    await h.p.push(msg(6, 'B'));
    await h.p.push(msg(7, 'C'));
    await h.p.drain();
    expect(h.handled.sort()).toEqual(['A5', 'B6', 'C7']);
    expect(h.p.committable()).toBe(8n);
  });

  test('ST_T16_레지스트리에닿지못해읽지못하면_받지않고일시실패를던진다(실행기가 멈추고 그 사건부터 다시 받는다) [ASVS v5.0.0-16.5.2]', async () => {
    const h = harness();
    await h.p.init();
    const bad = { ...msg(3, 'A'), value: null };
    const p = new KeyedPartition<Ev>({
      topic: 'trade.payments',
      partition: 0,
      held: { heldKeys: async () => new Set(), isHeld: async () => false, hold: async () => {}, holdIfHeld: async () => false },
      handler: {
        decode: () => {
          throw new TransientError('스키마 레지스트리 시간 초과');
        },
        keyOf: () => 'A',
        handle: async () => {},
      },
    });
    await p.init();
    await expect(p.push(bad)).rejects.toThrow('스키마 레지스트리');
    expect(p.committable()).toBeUndefined();
    expect(p.inflightKeys).toBe(0);
  });

  test('ST_T19_연결끊김메시지와풀대기초과는_코드가없어도일시실패다', () => {
    for (const m of ['Connection terminated unexpectedly', 'Client has encountered a connection error and is not queryable', 'Connection terminated due to connection timeout', 'Query read timeout', 'timeout exceeded when trying to connect'])
      expect(isTransientError(new Error(m)), m).toBe(true);
    expect(isTransientError(new ProblemError({ type: 'server-busy', status: 429, title: '바쁨' }))).toBe(true);
    expect(isTransientError(new ProblemError({ type: 'authz-unavailable', status: 503, title: '판정 못 함' }))).toBe(true);
    expect(isTransientError(new ProblemError({ type: 'not-found', status: 404, title: '없음' }))).toBe(false);
    expect(isTransientError(new DrizzleQueryError('select 1', [], new Error('Connection terminated unexpectedly')))).toBe(true);
  });

  test('[ASVS v5.0.0-16.2.5]_오류요약은Drizzle쿼리의매개변수값을남기지않는다', () => {
    const e = new DrizzleQueryError('insert into payment (phone) values ($1)', ['010-1234-5678'], Object.assign(new Error('dup'), { code: '23505' }));
    const s = errorSummary(e);
    expect(s).not.toContain('010-1234-5678');
    expect(s).toContain('insert into payment (phone) values ($1)');
    expect(s).toContain('23505');
  });

  test('같은 지표 저장소로 소비자 지표를 두 번 만들어도 실패하지 않는다', () => {
    const r = new Registry();
    const a = KeyedConsumerMetrics.for(r, 'svc');
    expect(KeyedConsumerMetrics.for(r, 'svc')).toBe(a);
  });
});

describe('코드 리뷰 2026-11-01 셋째 재현', () => {
  test('ST_T19_멈춤이유가둘이면_둘다풀려야다시시작하고_그때이어읽을위치로맞춘다', () => {
    const calls: string[] = [];
    let next: bigint | undefined = 7n;
    const g = new PauseGate({ pause: () => calls.push('pause'), resume: (n) => calls.push(`resume:${n}`), next: () => next });
    g.hold('backoff');
    g.hold('lanes');
    g.hold('backoff');
    expect(calls).toEqual(['pause']);
    g.release('backoff');
    expect(calls).toEqual(['pause']);
    next = 9n;
    g.release('lanes');
    expect(calls).toEqual(['pause', 'resume:9']);
    g.release('lanes');
    expect(calls).toEqual(['pause', 'resume:9']);
    // 넘긴 파티션의 문은 닫혀 더는 멈추거나 열지 않는다
    g.close();
    g.hold('backoff');
    g.release('backoff');
    expect(calls).toEqual(['pause', 'resume:9']);
  });

  test('ST_T19_겹친보류키읽기는_먼저끝난결과만쓴다(늦게 끝난 옛 목록이 새 보류 키를 지우지 않게)', async () => {
    const answers: ((keys: Set<string>) => void)[] = [];
    let handled = false;
    const p = new KeyedPartition<Ev>({
      topic: 'trade.payments',
      partition: 0,
      held: {
        heldKeys: () => new Promise((r) => answers.push(r)),
        isHeld: async () => false,
        hold: async () => {},
        holdIfHeld: async () => true,
      },
      handler: { decode: (m) => JSON.parse(m.value!.toString('utf8')) as Ev, keyOf: (e) => e.order, handle: async () => void (handled = true) },
    });
    const first = p.init();
    const second = p.init();
    answers[1]!(new Set(['K']));
    await second;
    answers[0]!(new Set());
    await first;
    expect(p.initialized).toBe(true);
    // K는 보류 중이라 처리하지 않고 넣는다(holdIfHeld true)
    await p.push(msg(0, 'K'));
    await p.drain();
    expect(handled).toBe(false);
  });

  test('ST_T18_넘기며버린파티션은_다시시도를멈추고_멈춤·다시시작을부르지않으며_끝나지않은위치를넘겨커밋하지않는다', async () => {
    const h = harness({
      handle: async (e) => {
        if (e.order === 'A') throw new TransientError('DB 없음');
      },
      sleep: () => new Promise((r) => setTimeout(r, 2)),
    });
    await h.p.init();
    await h.p.push(msg(0, 'B'));
    await h.p.push(msg(1, 'A'));
    await new Promise((r) => setTimeout(r, 15));
    expect(h.pauses).toEqual(['pause']);
    h.p.abandon();
    await h.p.drain();
    expect(h.handled).toEqual(['B0']);
    expect(h.p.committable()).toBe(1n);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.pauses).toEqual(['pause']);
  });

  test('이어 읽을 위치는 받기로 한 가장 큰 오프셋 + 1이다', async () => {
    const h = harness();
    await h.p.init();
    expect(h.p.nextOffset).toBeUndefined();
    await h.p.push(msg(4, 'A'));
    expect(h.p.nextOffset).toBe(5n);
    await h.p.drain();
  });
});

describe('코드 리뷰 2026-11-01 넷째 재현', () => {
  test('ST_T18_버린파티션에서자리를기다리던받기는_깨어나돌아온다(종료가 매달리지 않게)', async () => {
    const h = harness({
      maxBuffered: 2,
      handle: async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('잘못된 행');
      },
      sleep: () => new Promise((r) => setTimeout(r, 5)),
    });
    await h.p.init();
    await h.p.push(msg(0, 'K'));
    await h.p.push(msg(1, 'K'));
    let third = false;
    void h.p.push(msg(2, 'J')).then(() => (third = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(third).toBe(false);
    h.p.abandon();
    await h.p.drain();
    await new Promise((r) => setTimeout(r, 100));
    expect({ third, lanes: h.p.inflightKeys }).toEqual({ third: true, lanes: 0 });
    // 버린 파티션은 아무것도 끝난 것으로 치지 않는다
    expect(h.p.committable()).toBe(0n);
  });
});
