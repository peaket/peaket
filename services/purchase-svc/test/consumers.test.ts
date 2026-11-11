// purchase-svc API 파드의 Kafka 소비자 설정(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 프로세스 둘·소비자 그룹,
// docs/streaming.md §2.6, docs/security/asvs/seat-hold.md 13.1.1·13.2.2). 소비자 그룹 이름과 환경 값 읽기(kafkaConsumersFromEnv)만 본다.
// 실제 Kafka로 두 소비자를 거는 것(startPurchaseConsumers)은 test-int/consumers.int.test.ts가 본다.
// 여기서는 플랫폼 runKeyedConsumer를 대역으로 바꿔(vi.mock) 무엇을 넘기는지와 멈춤(하나가 던져도 다른 하나는 멈춘다)만 본다(변이 검토 PRF-164).
// 결제 결과 반영 조립(paymentResultApply, 리뷰 고침)은 booking의 DrizzlePaymentResults만 메모리 가짜(ResultFakes)로 바꿔(vi.mock) 본다. 나머지는 실제 클래스다.
// 발권 실행기 깨우기(onApproved, PRF-170 변이 검토)는 조립이 넘긴 것을 꽂는지와, 운영 main.ts가 그 자리에 kick을 넘기는지(소스 글)를 본다.
import { readFileSync } from 'node:fs';
import { type Database, fakeClock } from '@peaket/platform';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  consumerDatabaseOptions,
  HOLD_LEDGER_GROUP,
  kafkaConsumersFromEnv,
  ORDER_SAGA_GROUP,
  paymentConsumerDatabaseOptions,
  paymentResultApply,
  type PurchaseConsumersOptions,
  startPurchaseConsumers,
} from '../src/consumers.js';
import { type DrizzleOrderStore, PaymentResultHandler, type PaymentResultReads, type PaymentResultWrites } from '../src/modules/booking/index.js';
import { DrizzleSeatSales, type SeatHoldLedger, SeatHoldLedgerHandler } from '../src/modules/inventory/index.js';
import { APPLY_NOW, ORDER_ID, paymentEvent, ResultFakes } from './payment-result-cases.js';

/** runKeyedConsumer 대역이 받은 인자와 멈춤 호출(그룹 이름 차례), 그룹마다 바꿔 끼우는 stop */
const runs = vi.hoisted(() => ({
  calls: [] as { service: string; groupId: string; topics: string[]; clientId: string; handler: unknown }[],
  stops: [] as string[],
  stopImpl: new Map<string, () => Promise<void>>(),
}));
/** DrizzlePaymentResults 가짜가 넘겨받은 생성자 인자와, 읽기·쓰기를 보낼 메모리 가짜(시험마다 바꾼다) */
const results = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  fake: undefined as undefined | { reads: PaymentResultReads; writes: PaymentResultWrites },
}));
vi.mock('../src/modules/booking/index.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  class FakeDrizzlePaymentResults implements PaymentResultReads, PaymentResultWrites {
    constructor(o: Record<string, unknown>) {
      results.options.push(o);
    }
    read: PaymentResultReads['read'] = (id) => results.fake!.reads.read(id);
    approve: PaymentResultWrites['approve'] = (i) => results.fake!.writes.approve(i);
    fail: PaymentResultWrites['fail'] = (i) => results.fake!.writes.fail(i);
    reverse: PaymentResultWrites['reverse'] = (i) => results.fake!.writes.reverse(i);
    holdIssue: PaymentResultWrites['holdIssue'] = (i) => results.fake!.writes.holdIssue(i);
    mark: PaymentResultWrites['mark'] = (i) => results.fake!.writes.mark(i);
  }
  return { ...real, DrizzlePaymentResults: FakeDrizzlePaymentResults };
});
vi.mock('@peaket/platform/stream-worker', () => ({
  runKeyedConsumer: (o: { service: string; groupId: string; topics: string[]; clientId: string; handler: unknown }) => {
    runs.calls.push(o);
    return {
      started: Promise.resolve(),
      stop: async () => {
        runs.stops.push(o.groupId);
        await runs.stopImpl.get(o.groupId)?.();
      },
    };
  },
}));

const SERVICE = 'purchase-svc';
const BROKERS = 'kafka-0:9092, kafka-1.peaket.svc:9094';

describe('소비자 그룹 이름', () => {
  test('ST5_원장 적재는 peaket.purchase-svc-hold-ledger.<환경>, 결제 결과(주문 Saga)는 peaket.purchase-svc-order-saga.<환경>이다', () => {
    expect(HOLD_LEDGER_GROUP('prod')).toBe('peaket.purchase-svc-hold-ledger.prod');
    expect(HOLD_LEDGER_GROUP('local')).toBe('peaket.purchase-svc-hold-ledger.local');
    expect(ORDER_SAGA_GROUP('prod')).toBe('peaket.purchase-svc-order-saga.prod');
    expect(ORDER_SAGA_GROUP('staging')).toBe('peaket.purchase-svc-order-saga.staging');
  });
});

describe('startPurchaseConsumers(runKeyedConsumer 대역)', () => {
  const options = (): PurchaseConsumersOptions => ({
    env: 'prod',
    brokers: ['kafka-0:9092'],
    clientId: 'purchase-svc-prod-pod-1',
    database: {} as Database,
    ledger: {} as SeatHoldLedger,
    applyPaymentResult: { execute: vi.fn() } as unknown as PurchaseConsumersOptions['applyPaymentResult'],
  });
  beforeEach(() => {
    runs.calls.length = 0;
    runs.stops.length = 0;
    runs.stopImpl.clear();
  });

  test('ST5_소비자 둘을 건다: 원장 적재는 그룹 peaket.purchase-svc-hold-ledger.<환경>·trade.seats·SeatHoldLedgerHandler, 결제 결과는 그룹 peaket.purchase-svc-order-saga.<환경>·trade.payments·PaymentResultHandler이고 같은 clientId다', async () => {
    const c = startPurchaseConsumers(options());
    await c.started;
    // 그룹 이름은 정본 글을 따로 적는다(운영 상수를 기대 값으로 쓰지 않는다)
    const byGroup = Object.fromEntries(runs.calls.map((o) => [o.groupId, o]));
    expect(Object.keys(byGroup).sort()).toEqual(['peaket.purchase-svc-hold-ledger.prod', 'peaket.purchase-svc-order-saga.prod']);
    const ledger = byGroup['peaket.purchase-svc-hold-ledger.prod']!;
    const saga = byGroup['peaket.purchase-svc-order-saga.prod']!;
    expect(ledger.topics).toEqual(['trade.seats']);
    expect(ledger.handler).toBeInstanceOf(SeatHoldLedgerHandler);
    expect(saga.topics).toEqual(['trade.payments']);
    expect(saga.handler).toBeInstanceOf(PaymentResultHandler);
    for (const o of [ledger, saga]) expect([o.service, o.clientId]).toEqual([SERVICE, 'purchase-svc-prod-pod-1']);
    await c.stop();
  });

  test('ST5_stop: 한 소비자의 멈춤이 던져도 다른 소비자는 멈추고, 그 뒤 첫 오류를 던진다. 두 번 불러도 소비자마다 한 번만 멈춘다 [ASVS v5.0.0-16.5.2]', async () => {
    const boom = Object.assign(new Error('commit failed'), { name: 'KafkaJSError' });
    for (const failing of ['peaket.purchase-svc-hold-ledger.prod', 'peaket.purchase-svc-order-saga.prod']) {
      runs.stops.length = 0;
      runs.stopImpl.clear();
      runs.stopImpl.set(failing, () => Promise.reject(boom));
      const c = startPurchaseConsumers(options());
      await c.started;
      await expect(c.stop(), failing).rejects.toBe(boom);
      expect([...runs.stops].sort(), failing).toEqual(['peaket.purchase-svc-hold-ledger.prod', 'peaket.purchase-svc-order-saga.prod']);
      await expect(c.stop(), failing).rejects.toBe(boom);
      expect(runs.stops, failing).toHaveLength(2);
    }
  });
});

describe('API 파드 소비자의 DB 풀(리뷰 고침 M4)', () => {
  test('ST5_리뷰 고침 M4_두 소비자는 핫패스 풀과 따로 소비자 전용 일반 풀(profile general, 연결 4개 [가정], 이름 purchase-svc-consumers)을 쓴다. 주소는 받은 그대로다 [ASVS v5.0.0-16.5.2]', () => {
    const url = 'postgres://purchase_svc@pgbouncer:6432/purchase';
    expect(consumerDatabaseOptions(url)).toEqual({ url, profile: 'general', max: 4, applicationName: 'purchase-svc-consumers' });
  });
});

describe('결제 결과 반영 조립(paymentResultApply, 리뷰 고침 변이 검토)', () => {
  const sessions = { end: { execute: async () => true }, store: { setPaying: async () => true } };
  /** 플랫폼(pino) 로거 자리의 대역(order-adapters.test.ts와 같은 방식) */
  const logger = { warn: () => {}, error: () => {} } as never;
  beforeEach(() => {
    results.options.length = 0;
    results.fake = undefined;
  });

  test('PT2_리뷰 고침 변이 검토_넘긴 onOrderChanged를 쓰임새에 꽂는다: FAILED 반영(T11) 뒤 Saga 깨우기와 함께 그 주문 ID로 한 번 불린다. 결과 저장소는 넘긴 DB·주문 전이 함수·시계와 그 DB의 판매 저장소로 만든다', async () => {
    const fx = new ResultFakes();
    results.fake = fx;
    const database = { tag: 'consumer-db' } as unknown as Database;
    const store = { tag: 'order-store' } as unknown as DrizzleOrderStore;
    const clock = fakeClock({ now: APPLY_NOW });
    const seen: string[] = [];
    const apply = paymentResultApply({ database, store, sessions, saga: fx.saga, logger, clock, onOrderChanged: (id) => void seen.push(id) });
    expect(await apply.execute(paymentEvent({ type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }))).toEqual({ status: 'APPLIED', transition: 'T11', write: 'FAIL' });
    expect(seen).toEqual([ORDER_ID]);
    expect(fx.failed).toHaveLength(1);
    expect(fx.kicked).toEqual([ORDER_ID]);
    expect(results.options).toHaveLength(1);
    expect(results.options[0]).toMatchObject({ database, store, clock });
    expect(results.options[0]!.sales).toBeInstanceOf(DrizzleSeatSales);
  });

  test('변이 검토 PRF-170_넘긴 onApproved(발권 실행기 kick)를 쓰임새에 꽂는다: 승인 반영(T9) 커밋 뒤 그 주문 ID로 한 번 불리고, 실패 반영(T11)에는 불리지 않는다 (ADR0106)', async () => {
    const fx = new ResultFakes();
    results.fake = fx;
    const database = { tag: 'consumer-db' } as unknown as Database;
    const store = { tag: 'order-store' } as unknown as DrizzleOrderStore;
    const clock = fakeClock({ now: APPLY_NOW });
    const kicked: string[] = [];
    const apply = paymentResultApply({ database, store, sessions, saga: fx.saga, logger, clock, onOrderChanged: () => {}, onApproved: (id) => void kicked.push(id) });
    expect(await apply.execute(paymentEvent())).toEqual({ status: 'APPLIED', transition: 'T9', write: 'APPROVE' });
    expect(fx.approved).toHaveLength(1);
    expect(kicked).toEqual([ORDER_ID]);
    // 실패 반영은 큐 행을 넣지 않는다(깨우지 않는다)
    fx.reset();
    expect(await apply.execute(paymentEvent({ type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }))).toEqual({ status: 'APPLIED', transition: 'T11', write: 'FAIL' });
    expect(kicked).toEqual([ORDER_ID]);
  });

  test('변이 검토 PRF-170_운영 main.ts는 paymentResultApply에 onApproved로 이 파드의 발권 실행기 kick을 넘긴다(선택 인자라 빠뜨려도 형 오류가 없어 글로 본다) (ADR0106)', () => {
    // 운영 조립은 start.ts에 있다(main.ts는 환경 값과 SIGTERM만 잇는다, BUILD_ORDER PRF-215)
    const main = readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8');
    // paymentResultApply({ … }) 호출 몸통(줄 주석은 뺀다: 주석으로 막은 줄이 통과하지 않게)
    const call = /paymentResultApply\(\{([\s\S]*?)\n\s*\}\);/.exec(main)?.[1]?.replace(/\/\/.*$/gm, '');
    expect(call, 'main.ts에 paymentResultApply({ … }) 호출이 있다').toBeDefined();
    expect(call).toMatch(/\bonApproved:\s*\((\w+)\)\s*=>\s*issueRunner\.kick\(\1\)/);
    // issueRunner는 같은 파드의 발권 실행기다
    expect(main).toMatch(/\bconst issueRunner = ticketRunner;/);
    expect(main).toMatch(/\bticketRunner = new TicketIssueRunner\(/);
  });

  test('PT2_리뷰 고침 변이 검토_onOrderChanged는 필수 인자다(빠뜨리면 형 오류, tsc --noEmit이 본다)', () => {
    const database = {} as Database;
    const store = {} as DrizzleOrderStore;
    const clock = fakeClock({ now: APPLY_NOW });
    const saga = { kick: () => {} };
    // 부르지 않는다: 형 검사만 본다
    const withoutWake = () =>
      // @ts-expect-error onOrderChanged가 없으면 같은 파드의 결제 결과 기다림이 곧바로 깨지지 않는다
      paymentResultApply({ database, store, sessions, saga, logger, clock });
    expect(typeof withoutWake).toBe('function');
  });
});

describe('kafkaConsumersFromEnv(API 파드의 소비자 설정)', () => {
  test('리뷰 고침 L9_브로커 주소 모양이 틀린 오류 글에는 PEAKET_KAFKA_BROKERS 원문을 싣지 않고 몇 번째 조각(쉼표로 나눈 차례)이 틀렸는지만 싣는다 [ASVS v5.0.0-16.2.5]', () => {
    const messageOf = (PEAKET_KAFKA_BROKERS: string): string => {
      try {
        kafkaConsumersFromEnv({ PEAKET_ENV: 'local', PEAKET_KAFKA_BROKERS }, SERVICE);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('던져야 한다');
    };
    const raw = 'kafka-0:9092,user:SECRET-PASS@kafka-1:9092';
    const m = messageOf(raw);
    expect(m).toContain('PEAKET_KAFKA_BROKERS');
    expect(m).toContain('2번째');
    for (const s of ['SECRET-PASS', 'user:', 'kafka-0', 'kafka-1']) expect(m, s).not.toContain(s);
    // 빈 조각도 차례에 센다(사람이 쉼표를 세는 대로)
    expect(messageOf('kafka-0:9092,,bad-SECRET')).toContain('3번째');
    expect(messageOf('kafka-0:9092,,bad-SECRET')).not.toContain('SECRET');
  });

  test('브로커 주소가 없거나 빈칸뿐이면 local·ci에서는 소비자를 켜지 않고(enabled false) 시작 로그 경고 글을 준다', () => {
    for (const PEAKET_ENV of ['local', 'ci']) {
      for (const PEAKET_KAFKA_BROKERS of [undefined, '', '   ']) {
        const c = kafkaConsumersFromEnv({ PEAKET_ENV, PEAKET_KAFKA_BROKERS }, SERVICE);
        expect(c, `${PEAKET_ENV} ${JSON.stringify(PEAKET_KAFKA_BROKERS)}`).toEqual({ enabled: false, warning: expect.any(String) });
        if (!c.enabled) expect(c.warning.length).toBeGreaterThan(0);
      }
    }
  });

  test('브로커 주소가 없으면 local·ci 밖(dev·staging·prod·값 없음)에서는 던진다(조용히 소비자 없이 뜨지 않는다, 시작 실패) [ASVS v5.0.0-13.1.1]', () => {
    // 오류 글에 빠진 값의 이름을 싣는다(플랫폼 설정 오류와 같은 방식)
    for (const PEAKET_ENV of ['dev', 'staging', 'prod', undefined, '']) {
      expect(() => kafkaConsumersFromEnv({ PEAKET_ENV }, SERVICE), String(PEAKET_ENV)).toThrow(/PEAKET_KAFKA_BROKERS|PEAKET_ENV/);
      expect(() => kafkaConsumersFromEnv({ PEAKET_ENV, PEAKET_KAFKA_BROKERS: ' ' }, SERVICE), String(PEAKET_ENV)).toThrow(/PEAKET_KAFKA_BROKERS|PEAKET_ENV/);
    }
    for (const PEAKET_ENV of ['dev', 'staging', 'prod']) expect(() => kafkaConsumersFromEnv({ PEAKET_ENV }, SERVICE), PEAKET_ENV).toThrow(/PEAKET_KAFKA_BROKERS/);
  });

  test('브로커 주소 모양이 틀리면(호스트:포트가 아닌 조각이 하나라도 있음·조각이 없음) local에서도 던진다(글에 PEAKET_KAFKA_BROKERS)', () => {
    for (const PEAKET_KAFKA_BROKERS of ['kafka-0', 'kafka-0:', ':9092', 'kafka-0:9092,kafka 1:9092', 'kafka-0:123456', 'kafka_0:9092', ' , ', 'kafka-0:9092;kafka-1:9092']) {
      expect(() => kafkaConsumersFromEnv({ PEAKET_ENV: 'local', PEAKET_KAFKA_BROKERS }, SERVICE), PEAKET_KAFKA_BROKERS).toThrow(/PEAKET_KAFKA_BROKERS/);
    }
  });

  test('브로커 주소가 있으면 쉼표로 나누고 앞뒤 빈칸·빈 조각을 뗀 목록과 환경을 준다. local·ci에서 PEAKET_KAFKA_AUTH가 없으면 평문(auth 없음)이다', () => {
    expect(kafkaConsumersFromEnv({ PEAKET_ENV: 'local', PEAKET_KAFKA_BROKERS: BROKERS }, SERVICE)).toEqual({
      enabled: true,
      brokers: ['kafka-0:9092', 'kafka-1.peaket.svc:9094'],
      auth: undefined,
      env: 'local',
    });
    expect(kafkaConsumersFromEnv({ PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: 'kafka:9092,' }, SERVICE)).toEqual({ enabled: true, brokers: ['kafka:9092'], auth: undefined, env: 'ci' });
  });

  test('브로커 주소가 있어도 PEAKET_ENV가 없으면 던진다(그룹 이름·인증을 고를 수 없다)', () => {
    expect(() => kafkaConsumersFromEnv({ PEAKET_KAFKA_BROKERS: BROKERS }, SERVICE)).toThrow(/PEAKET_ENV/);
    expect(() => kafkaConsumersFromEnv({ PEAKET_ENV: '', PEAKET_KAFKA_BROKERS: BROKERS }, SERVICE)).toThrow(/PEAKET_ENV/);
  });

  test('local·ci 밖에서는 MSK IAM 인증이 있어야 한다: PEAKET_KAFKA_AUTH가 없으면 던지고, msk-iam이면 세션 이름 purchase-svc-<환경>의 인증을 싣는다 [ASVS v5.0.0-13.2.2]', () => {
    expect(() => kafkaConsumersFromEnv({ PEAKET_ENV: 'prod', PEAKET_KAFKA_BROKERS: BROKERS }, SERVICE)).toThrow(/PEAKET_KAFKA_AUTH/);
    const c = kafkaConsumersFromEnv(
      {
        PEAKET_ENV: 'prod',
        PEAKET_KAFKA_BROKERS: BROKERS,
        PEAKET_KAFKA_AUTH: 'msk-iam',
        PEAKET_KAFKA_MSK_ROLE_ARN: 'arn:aws:iam::123456789012:role/peaket-purchase-svc-msk',
        AWS_REGION: 'ap-northeast-2',
      },
      SERVICE,
    );
    expect(c).toMatchObject({ enabled: true, brokers: ['kafka-0:9092', 'kafka-1.peaket.svc:9094'], env: 'prod' });
    if (!c.enabled) throw new Error('켜져야 한다');
    expect(c.auth).toMatchObject({ mechanism: 'msk-iam', sessionName: 'purchase-svc-prod' });
  });

  test('BAT-029_BAT031: 결제 결과 소비자 풀은 홀드 원장 풀과 따로이고 48연결이다(32키가 꽉 차 주문 APPROVED가 밀렸다)', () => {
    expect(consumerDatabaseOptions('postgres://x')).toMatchObject({ profile: 'general', max: 4, applicationName: 'purchase-svc-consumers' });
    expect(paymentConsumerDatabaseOptions('postgres://x')).toMatchObject({ profile: 'general', max: 48, applicationName: 'purchase-svc-payment-results' });
  });
});
