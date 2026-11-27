// COV2-06(W7-audit): core-svc Kafka 구독의 설정·그룹·보류 감싸기·시작 파일 조립.
// 정본: docs/streaming.md §2.6 'core-svc 소비자'(그룹 peaket.core-svc.<환경>, 탈퇴 토픽 하나), docs/features/identity.md §8 '후기 익명화'
// (운영 환경에서 브로커 설정이 없으면 시작하지 않는다), docs/security/data-classification.md '탈퇴 사건의 pid 사본'(보류 기록에도 pid를 남기지 않는다).
// 시작 파일(main.ts) 조립은 원문 대조로 본다(약한 검사다. 실제 동작은 test-int/review-withdrawn-consumer.int.test.ts가 본다).
// I-T83 ⑤(W8-audit2a, 소유자 결정 2026-11-16 OPEN[44], ADR-0278): 소비자와 함께 탈퇴 후기 다시 정리 반복을 켜고, 멈출 때 반복을 먼저 멈춘다(docs/streaming.md §2.6).
// 처리기는 익명화(anonymizeAccount) 대신 파기(purgeWithdrawn)를 부른다(docs/features/identity.md §8 '후기 파기').
import type { Database, HeldEventInput, HeldEventStore } from '@peaket/platform';
import { PlatformConfigError, PlatformMetrics } from '@peaket/platform';
import { runKeyedConsumer } from '@peaket/platform/stream-worker';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { CORE_GROUP, CORE_TOPICS, CoreEventsHandler, kafkaConsumersFromEnv, pidFreeHeldEventStore } from '../src/consumers/index.js';
import { startCoreConsumers } from '../src/consumers/start.js';
import { ReviewAccountWithdrawnHandler } from '../src/modules/review/index.js';

// 네이티브 Kafka 모듈 없이 startCoreConsumers가 runKeyedConsumer에 넘기는 값만 본다(웨이브 끝 리뷰 K2). 이 파일에만 둔다
vi.mock('@peaket/platform/stream-worker', () => ({
  runKeyedConsumer: vi.fn(() => ({ started: Promise.resolve(), stop: async () => undefined })),
}));

/** main.ts 원문 */
const mainText = (): string => readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');

/** open 자리의 여는 괄호와 짝인 닫는 괄호 자리 */
function matchingClose(text: string, open: number, pair: [string, string] = ['{', '}']): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === pair[0]) depth += 1;
    else if (text[i] === pair[1]) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** startCoreConsumers({ … }) 인자 객체 글과 그 database 칸의 이름 */
function consumerArgs(main: string): { args: string; db: string | undefined } {
  const call = main.indexOf('startCoreConsumers({');
  if (call < 0) return { args: '', db: undefined };
  const open = main.indexOf('{', call);
  const args = main.slice(open, matchingClose(main, open) + 1);
  const m = /[{,]\s*database\s*(?::\s*([A-Za-z_$][\w$]*))?\s*[,}]/.exec(args);
  return { args, db: m ? (m[1] ?? 'database') : undefined };
}

const TOPIC = 'identity.accounts-withdrawn';
const A = '0190f3a1-7c2e-7a00-8000-00000000a001';
const EVENT_KEY = '0190f3a1-7c2e-7a00-8000-0000000e0001';
const PID = 'pidAAAAcurrent_0123';
const OLD_PID = 'pidAAAAprevious_456';
const WITHDRAWN_AT = '2026-11-16T02:00:00.000Z';

const full = (o: Record<string, unknown> = {}) => ({ eventKey: EVENT_KEY, accountId: A, pids: [PID, OLD_PID], withdrawnAt: WITHDRAWN_AT, purgeBy: '2026-11-21T02:00:00.000Z', ...o });

const input = (value: Buffer | null, topic = TOPIC): HeldEventInput => ({
  topic,
  partition: 2,
  offset: 41n,
  eventKey: EVENT_KEY,
  businessKey: A,
  error: 'Error: 탈퇴 사건을 읽지 못했다',
  key: A,
  value,
  headers: { 'content-type': 'application/json' },
  timestamp: Date.parse('2026-11-16T03:00:00.000Z'),
});

/** 받은 넣기를 모으는 안쪽 보류 저장소 */
function recordingInner(): HeldEventStore & { got: { op: string; e: HeldEventInput }[] } {
  const got: { op: string; e: HeldEventInput }[] = [];
  return {
    got,
    heldKeys: async () => new Set([A]),
    isHeld: async (_t, k) => k === A,
    hold: async (e) => {
      got.push({ op: 'hold', e });
    },
    holdIfHeld: async (e) => {
      got.push({ op: 'holdIfHeld', e });
      return true;
    },
  };
}

const json = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8');

describe('COV2-06 보류 기록의 pid 빼기', () => {
  test('COV2-06 ⑥ 보류 기록에는 pid를 뺀 값만 넣는다', async () => {
    const inner = recordingInner();
    const store = pidFreeHeldEventStore(inner);

    await store.hold(input(json(full())));
    expect(await store.holdIfHeld(input(json(full())))).toBe(true);
    expect(inner.got.map((g) => g.op)).toEqual(['hold', 'holdIfHeld']);
    for (const { e } of inner.got) {
      expect(JSON.parse(e.value!.toString('utf8'))).toStrictEqual({ eventKey: EVENT_KEY, accountId: A, withdrawnAt: WITHDRAWN_AT });
      const bytes = e.value!.toString('utf8');
      for (const secret of [PID, OLD_PID, 'pids', 'purgeBy']) expect(bytes).not.toContain(secret);
      // 값 밖의 칸은 그대로 넘긴다
      const { value: _v, ...rest } = e;
      const { value: _w, ...expected } = input(null);
      expect(rest).toEqual(expected);
    }

    // 읽지 못한 값은 값 없이(null) 넣는다: JSON이 아님, 값 없음, pid는 있고 accountId가 틀림
    inner.got.length = 0;
    await store.hold(input(Buffer.from('{not json', 'utf8')));
    await store.hold(input(null));
    await store.holdIfHeld(input(json(full({ accountId: 'not-a-uuid' }))));
    expect(inner.got.map((g) => g.e.value)).toEqual([null, null, null]);

    // 다른 토픽 값은 바이트 그대로
    inner.got.length = 0;
    const other = json({ orderId: 'o-1', pids: ['keep-as-is'] });
    await store.hold(input(other, 'trade.orders'));
    expect(inner.got[0]!.e.value).toEqual(other);
    expect(inner.got[0]!.e.topic).toBe('trade.orders');

    // 읽기는 안쪽 저장소의 것을 그대로 준다
    expect(await store.heldKeys(TOPIC, 2)).toEqual(new Set([A]));
    expect(await store.isHeld(TOPIC, A)).toBe(true);
    expect(await store.isHeld(TOPIC, 'other')).toBe(false);
  });
});

describe('COV2-06 Kafka 소비자 설정', () => {
  test('COV2-06 ⑦ PEAKET_KAFKA_BROKERS가 없으면 local·ci만 소비자 없이 뜨고 그 밖의 환경은 시작하지 않는다', () => {
    for (const env of ['local', 'ci']) {
      for (const brokers of [undefined, '', '   ']) {
        const cfg = kafkaConsumersFromEnv({ PEAKET_ENV: env, ...(brokers === undefined ? {} : { PEAKET_KAFKA_BROKERS: brokers }) });
        expect(cfg.enabled, `${env}·${JSON.stringify(brokers ?? null)}`).toBe(false);
        expect(cfg).toMatchObject({ enabled: false, warning: expect.any(String) });
      }
    }
    // 허용 목록 밖의 환경마다(PEAKET_ENV 없음 포함) 시작하지 않는다
    for (const env of ['prod', 'staging', 'demo', undefined]) {
      for (const brokers of [undefined, '', '   ']) {
        const e = { ...(env === undefined ? {} : { PEAKET_ENV: env }), ...(brokers === undefined ? {} : { PEAKET_KAFKA_BROKERS: brokers }) };
        expect(() => kafkaConsumersFromEnv(e), JSON.stringify(e)).toThrow(PlatformConfigError);
      }
    }
    // 틀린 조각은 몇 번째인지만 알리고 값은 싣지 않는다
    const bad = (() => {
      try {
        kafkaConsumersFromEnv({ PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: 'b1:9092,bad host' });
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(bad).toBeInstanceOf(PlatformConfigError);
    expect((bad as Error).message).toContain('2번째');
    expect((bad as Error).message).not.toContain('bad host');

    const prod = kafkaConsumersFromEnv({
      PEAKET_ENV: 'prod',
      PEAKET_KAFKA_BROKERS: 'b1:9092, b2:9092',
      PEAKET_KAFKA_AUTH: 'msk-iam',
      PEAKET_KAFKA_MSK_ROLE_ARN: 'arn:aws:iam::123456789012:role/core-svc-consumer',
      AWS_REGION: 'ap-northeast-2',
    });
    expect(prod).toMatchObject({ enabled: true, brokers: ['b1:9092', 'b2:9092'], env: 'prod' });
    expect(prod.enabled && prod.auth?.mechanism).toBe('msk-iam');
  });

  test('COV2-06 ⑧ 소비자 그룹은 peaket.core-svc.<환경>이고 탈퇴·회차 판매 상태 두 토픽을 읽는다', () => {
    expect(CORE_GROUP('prod')).toBe('peaket.core-svc.prod');
    expect(CORE_GROUP('staging')).toBe('peaket.core-svc.staging');
    // F-07-12 RV-02: 같은 그룹 하나가 identity.accounts-withdrawn과 trade.seats(EventSaleChanged)를 읽는다
    expect([...CORE_TOPICS]).toEqual(['identity.accounts-withdrawn', 'trade.seats']);
    const handler = new CoreEventsHandler({ accountsWithdrawn: { decode: async () => ({}), keyOf: () => 'k', handle: async () => undefined }, saleChanged: { decode: async () => ({}), keyOf: () => 'k', handle: async () => undefined } });
    expect(handler).toBeInstanceOf(CoreEventsHandler);
  });
});

describe('COV2-06 시작 파일 조립', () => {
  test('COV2-06 ⑩ main.ts는 시작 전에 Kafka 설정을 읽고 듣기 뒤에 후기 탈퇴 소비자를 켠다', () => {
    const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
    const at = (needle: string | RegExp): number => {
      const i = typeof needle === 'string' ? main.indexOf(needle) : main.search(needle);
      expect(i, String(needle)).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('kafkaConsumersFromEnv(')).toBeLessThan(at('createService('));
    const listen = at('service.listen()');
    expect(at('startCoreConsumers(')).toBeGreaterThan(listen);
    expect(at('new ReviewAccountWithdrawnHandler(')).toBeGreaterThan(listen);

    // SIGTERM에서는 startCoreConsumers가 돌려준 소비자를 서비스 닫기보다 먼저 멈춘다
    const name = /(?:(?:const|let)\s+)?(\w+)\s*(?::[^=;]+)?=(?!=)[^;]*?startCoreConsumers\(/.exec(main)?.[1];
    expect(name, '소비자를 담는 이름').toBeDefined();
    const sigterm = main.slice(at("process.once('SIGTERM'"));
    const stop = sigterm.search(new RegExp(`${name}\\??\\.stop\\(`));
    expect(stop, `${name}.stop()`).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(sigterm.search(/service\s*\.close\(/));
  });

  test('COV2-06 ⑩ R5 main.ts는 후기 탈퇴 소비자에 core_app으로 확인한 DB를 넘긴다', () => {
    // 리뷰 R5: core_partner(후기 표 권한 없음) 같은 다른 DB를 넘기는 틀린 조립을 잡는다. ⑫는 자기 DB를 따로 만들어 이것을 보지 못한다
    const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
    const call = main.indexOf('startCoreConsumers({');
    expect(call, 'startCoreConsumers({').toBeGreaterThanOrEqual(0);
    // 균형 괄호로 인자 객체를 잘라 낸다
    const open = main.indexOf('{', call);
    let depth = 0;
    let close = -1;
    for (let i = open; i < main.length; i += 1) {
      if (main[i] === '{') depth += 1;
      else if (main[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    expect(close, '인자 객체의 끝').toBeGreaterThan(open);
    const args = main.slice(open, close + 1);
    // 맨 위 칸 database(줄임 꼴 `database,` 또는 `database: 이름`)
    const m = /[{,]\s*database\s*(?::\s*([A-Za-z_$][\w$]*))?\s*[,}]/.exec(args);
    expect(m, 'startCoreConsumers 인자의 database 칸').not.toBeNull();
    const db = m![1] ?? 'database';
    const role = (r: string): RegExp => new RegExp(String.raw`assertDatabaseRole\(\s*${db}\s*,\s*'${r}'`);
    expect(main).toMatch(role('core_app'));
    for (const other of ['core_partner', 'core_ops']) expect(main).not.toMatch(role(other));
  });

  test('COV2-06 K2 소비자는 따로 둔 core_app 풀과 파티션 1·키 2로 돈다', async () => {
    // 웨이브 끝 리뷰 K2(docs/streaming.md §2.6 'core-svc 소비자': 따로 둔 풀 최대 2, 파티션 1·키 2). 값은 정본 숫자로 적는다
    const executed: unknown[] = [];
    const pool = {
      db: {
        execute: async (q: unknown) => {
          executed.push(q);
          return { rows: [] };
        },
      },
      transaction: async () => {
        throw new Error('이 시험에서는 부르지 않는다');
      },
    } as unknown as Database;
    const handler = new ReviewAccountWithdrawnHandler({ purgeWithdrawn: async () => ({ purged: 0 }) });
    vi.mocked(runKeyedConsumer).mockClear();
    const registry = new PlatformMetrics('core-svc').registry;
    // I-T83 ⑤: 다시 정리 반복은 받은 유스케이스를 쓴다(이 시험에서는 아무것도 하지 않는 대역)
    const recheck = { runWithdrawalRechecks: async () => ({ accounts: 0, purged: 0 }), oldestOverdueRecheckMs: async () => 0 };
    const run = startCoreConsumers({ env: 'ci', brokers: ['127.0.0.1:9092'], clientId: 'core-svc-ci-test', database: pool, handler, registry, recheck });
    expect(vi.mocked(runKeyedConsumer)).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(runKeyedConsumer).mock.calls[0]![0];
    expect(opts).toMatchObject({ service: 'core-svc', groupId: 'peaket.core-svc.ci', topics: ['identity.accounts-withdrawn', 'trade.seats'], maxKeys: 2, partitionsConcurrently: 1 });
    expect(opts.handler).toBe(handler);
    // 검증 3단계 P04: 받은 지표 저장소를 그대로 넘긴다(넘기지 않으면 소비자 지표·보류 수가 main.ts의 /metrics에 실리지 않는다)
    expect(opts.registry).toBe(registry);
    // 보류 저장소와 보류 수 세기가 받은 풀을 쓴다
    await opts.held.isHeld('identity.accounts-withdrawn', 'k');
    expect(executed).toHaveLength(1);
    await opts.heldCounts!();
    expect(executed).toHaveLength(2);
    await run.stop();

    // main.ts: 소비자 풀은 따로(최대 2) 만들고 core_app으로 확인하며, API의 database는 소비자에 넘기지 않고, 종료 때 닫는다
    const main = mainText();
    const { db } = consumerArgs(main);
    expect(db, 'startCoreConsumers 인자의 database 칸').toBeDefined();
    expect(db).not.toBe('database');
    const declAt = main.search(new RegExp(String.raw`(?:const|let)\s+${db}\s*=\s*createDatabase\(`));
    expect(declAt, `${db} = createDatabase(…)`).toBeGreaterThanOrEqual(0);
    const paren = main.indexOf('(', main.indexOf('createDatabase', declAt));
    const declArgs = main.slice(paren, matchingClose(main, paren, ['(', ')']) + 1);
    expect(declArgs, declArgs).toMatch(/\bmax:\s*2\b/);
    expect(main).toMatch(new RegExp(String.raw`assertDatabaseRole\(\s*${db}\s*,\s*'core_app'\s*\)`));
    const shutdown = main.slice(main.indexOf("process.once('SIGTERM'"));
    expect(shutdown).toMatch(new RegExp(String.raw`\b${db}\.close\(`));
  });

  test('COV2-06 ⑰ main.ts의 소비자 시작은 조건 없이 돈다', () => {
    // 검증 살아남음 M28: '부르는 글은 남기고 조건으로 막은 꼴'(consumers = undefined && startCoreConsumers({…}))을 잡는다
    const main = mainText();
    const call = main.indexOf('startCoreConsumers({');
    expect(call, 'startCoreConsumers({').toBeGreaterThanOrEqual(0);
    const lineStart = main.lastIndexOf('\n', call) + 1;
    const line = main.slice(lineStart, main.indexOf('\n', call));
    // 줄 전체가 '이름 = startCoreConsumers({' 대입이다(&&·?·주석·다른 식 없이)
    expect(line, line).toMatch(/^\s*(?:(?:const|let)\s+)?[A-Za-z_$][\w$]*\s*=\s*startCoreConsumers\(\{\s*$/);
    // 그 문장을 감싼 블록은 맨 위(모듈 수준)의 Kafka 설정 분기 하나다
    let depth = 0;
    let open = -1;
    for (let i = lineStart - 1; i >= 0; i -= 1) {
      if (main[i] === '}') depth += 1;
      else if (main[i] === '{') {
        if (depth === 0) {
          open = i;
          break;
        }
        depth -= 1;
      }
    }
    expect(open, '감싼 블록').toBeGreaterThanOrEqual(0);
    const before = main.slice(0, open);
    const opens = (before.match(/\{/g) ?? []).length;
    const closes = (before.match(/\}/g) ?? []).length;
    expect(opens - closes, '감싼 블록이 모듈 수준이다').toBe(0);
    const header = before.slice(before.lastIndexOf('\n') + 1);
    const cfg = /const\s+(\w+)\s*=\s*kafkaConsumersFromEnv\(/.exec(main)?.[1];
    expect(cfg, 'kafkaConsumersFromEnv 결과 이름').toBeDefined();
    const positive = new RegExp(String.raw`^\s*(?:\}\s*)?(?:else\s+)?if\s*\(\s*${cfg}\.enabled\s*\)\s*$`);
    const negativeElse = new RegExp(String.raw`if\s*\(\s*!\s*${cfg}\.enabled\s*\)[^\n]*\n\s*else\s*$`);
    expect(positive.test(header) || negativeElse.test(before), header).toBe(true);
  });

  test('COV2-06 ⑱ SIGTERM은 소비자 stop()이 끝난 뒤에 서비스와 연결을 닫는다', () => {
    // 검증 살아남음 M33: stop()을 기다리지 않는 꼴(void consumers?.stop())을 잡는다
    const main = mainText();
    const name = /(?:(?:const|let)\s+)?(\w+)\s*(?::[^=;]+)?=(?!=)[^;]*?startCoreConsumers\(/.exec(main)?.[1];
    expect(name, '소비자를 담는 이름').toBeDefined();
    const shutdown = main.slice(main.indexOf("process.once('SIGTERM'"));
    expect(shutdown).not.toMatch(new RegExp(String.raw`void\s+${name}\??\.stop\(`));
    const stop = shutdown.search(new RegExp(String.raw`await\s+${name}\??\.stop\(`));
    expect(stop, `await ${name}.stop()`).toBeGreaterThanOrEqual(0);
    const close = shutdown.search(/service\s*\.close\(/);
    expect(close).toBeGreaterThan(stop);
    // 연결 닫기는 서비스 닫기 뒤다
    const dbClose = shutdown.search(/\bdatabase\.close\(/);
    expect(dbClose).toBeGreaterThan(close);
  });

  test('COV2-06 K2 N07 소비자의 익명화·판매 상태 저장소도 소비자 전용 풀을 쓴다', () => {
    // 검증 2단계 살아남음 N07: 처리기에 넘기는 Reviews의 저장소를 API 풀(new DrizzleReviewStore(database))로 만들면 사건이 몰릴 때 익명화 UPDATE가
    // 팬·관제 HTTP 경로의 연결을 쓴다(docs/streaming.md §2.6 'core-svc 소비자': 따로 둔 풀). 보류 표만 소비자 풀로 가는 꼴을 잡는다.
    // F-07-12 RV-02: 회차 판매 상태 사본도 같은 소비자 풀(core_app)로 쓴다(opsDatabase·API database가 아니다)
    const main = mainText();
    const { args, db } = consumerArgs(main);
    expect(db, 'startCoreConsumers 인자의 database 칸').toBeDefined();
    // 처리기는 이름 붙은 Reviews를 받는다(service.app.get(Reviews) 같은 서비스 조립의 것이 아니다)
    const reviewsName = /accountsWithdrawn:\s*new\s+ReviewAccountWithdrawnHandler\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(args)?.[1];
    expect(reviewsName, '처리기에 넘기는 Reviews 이름').toBeDefined();
    const declAt = main.search(new RegExp(String.raw`(?:const|let)\s+${reviewsName}\s*=\s*new\s+Reviews\(\s*\{`));
    expect(declAt, `${reviewsName} = new Reviews({ … })`).toBeGreaterThanOrEqual(0);
    const open = main.indexOf('{', declAt);
    const deps = main.slice(open, matchingClose(main, open) + 1);
    const store = /store:\s*new\s+DrizzleReviewStore\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(deps)?.[1];
    expect(store, 'Reviews의 store: new DrizzleReviewStore(풀)').toBeDefined();
    expect(store).toBe(db);
    for (const other of ['database', 'partnerDatabase', 'opsDatabase']) expect(store).not.toBe(other);

    // EventSaleChanged 처리기의 사본 저장소도 같은 소비자 풀이다
    expect(args).toContain('new CoreEventsHandler({');
    expect(args).toMatch(/saleChanged:\s*new\s+CoreEventSaleChangedHandler\(/);
    const saleStore = /saleChanged:\s*new\s+CoreEventSaleChangedHandler\(\s*new\s+DrizzleEventSaleStateStore\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(args)?.[1];
    expect(saleStore, 'DrizzleEventSaleStateStore의 풀').toBeDefined();
    expect(saleStore).toBe(db);
    for (const other of ['database', 'partnerDatabase', 'opsDatabase']) expect(saleStore).not.toBe(other);
  });
});

describe('I-T83 다시 정리 반복의 시작과 멈춤', () => {
  /** 조건이 맞을 때까지 기다린다(실제 시간 2초까지) */
  async function until(cond: () => boolean, what: string): Promise<void> {
    const end = Date.now() + 2_000;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`기다리다 끝남: ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  test('I-T83 ⑤ 소비자를 켜면 반복도 켜지고 멈출 때 반복을 먼저 멈춘다', async () => {
    // 동작: 소비자를 켜면 받은 유스케이스로 반복이 돌고, stop()은 반복을 멈춘 뒤 소비자를 멈춘다(소비자가 멈추는 동안 반복이 돌지 않는다)
    const order: string[] = [];
    let runs = 0;
    const recheck = {
      runWithdrawalRechecks: async () => {
        runs += 1;
        order.push('recheck');
        return { accounts: 0, purged: 0 };
      },
      oldestOverdueRecheckMs: async () => 0,
    };
    const consumerStop = async () => {
      order.push('consumer-stop');
      const seen = runs;
      await new Promise((r) => setTimeout(r, 60));
      if (runs !== seen) throw new Error(`소비자를 멈추는 동안 반복이 ${runs - seen}번 더 돌았다`);
    };
    vi.mocked(runKeyedConsumer).mockClear();
    vi.mocked(runKeyedConsumer).mockImplementationOnce(() => ({ started: Promise.resolve(), stop: consumerStop }) as unknown as ReturnType<typeof runKeyedConsumer>);
    const handler = new ReviewAccountWithdrawnHandler({ purgeWithdrawn: async () => ({ purged: 0 }) });
    const pool = { db: { execute: async () => ({ rows: [] }) } } as unknown as Database;
    const run = startCoreConsumers({ env: 'ci', brokers: ['127.0.0.1:9092'], clientId: 'core-svc-ci-recheck', database: pool, handler, recheck, recheckEveryMs: 5 });
    await until(() => runs >= 2, '반복이 두 번 돈다');
    await run.stop();
    expect(order).toContain('consumer-stop');
    expect(order.lastIndexOf('recheck')).toBeLessThan(order.indexOf('consumer-stop'));
    const after = runs;
    await new Promise((r) => setTimeout(r, 40));
    expect(runs).toBe(after);

    // 원문: start.ts가 반복을 켜고, 반복 파일은 Kafka 모듈을 싣지 않으며, main.ts는 처리기와 같은 소비자 풀 Reviews를 반복에 넘긴다
    const startText = readFileSync(fileURLToPath(new URL('../src/consumers/start.ts', import.meta.url)), 'utf8');
    expect(startText).toContain('startReviewRecheckLoop(');
    const loopText = readFileSync(fileURLToPath(new URL('../src/consumers/review-recheck.ts', import.meta.url)), 'utf8');
    expect(loopText).not.toMatch(/stream-worker/);
    const { args } = consumerArgs(mainText());
    const recheckName = /[{,]\s*recheck\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(args)?.[1] ?? (/[{,]\s*recheck\s*[,}]/.test(args) ? 'recheck' : undefined);
    expect(recheckName, 'startCoreConsumers 인자의 recheck 칸').toBeDefined();
    const handlerReviews = /accountsWithdrawn:\s*new\s+ReviewAccountWithdrawnHandler\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(args)?.[1];
    expect(recheckName).toBe(handlerReviews);
  });
});
