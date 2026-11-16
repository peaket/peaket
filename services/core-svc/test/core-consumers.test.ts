// COV2-06(W7-audit): core-svc Kafka 구독의 설정·그룹·보류 감싸기·시작 파일 조립.
// 정본: docs/streaming.md §2.6 'core-svc 소비자'(그룹 peaket.core-svc.<환경>, 탈퇴 토픽 하나), docs/features/identity.md §8 '후기 익명화'
// (운영 환경에서 브로커 설정이 없으면 시작하지 않는다), docs/security/data-classification.md '탈퇴 사건의 pid 사본'(보류 기록에도 pid를 남기지 않는다).
// 시작 파일(main.ts) 조립은 원문 대조로 본다(약한 검사다. 실제 동작은 test-int/review-withdrawn-consumer.int.test.ts가 본다).
import type { HeldEventInput, HeldEventStore } from '@peaket/platform';
import { PlatformConfigError } from '@peaket/platform';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CORE_GROUP, CORE_TOPICS, kafkaConsumersFromEnv, pidFreeHeldEventStore } from '../src/consumers/index.js';

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

  test('COV2-06 ⑧ 소비자 그룹은 peaket.core-svc.<환경>이고 탈퇴 토픽 하나만 읽는다', () => {
    expect(CORE_GROUP('prod')).toBe('peaket.core-svc.prod');
    expect(CORE_GROUP('staging')).toBe('peaket.core-svc.staging');
    expect([...CORE_TOPICS]).toEqual(['identity.accounts-withdrawn']);
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
});
