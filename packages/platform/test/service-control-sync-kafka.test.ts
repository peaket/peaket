// 서비스 시작 파일이 실제로 타는 도우미 경로(startServiceControlSync → kafkaBroadcastSource → startControlSync)를 닿지 않는 브로커로 띄워
// 본다(docs/features/identity.md §3 '서비스에 잇기'·§12 I-T3 ②·I-T48 ③, ADR-0333 결정 2, ADR-0103 결정 2, BUILD_ORDER HOT-401 묶음
// BAT-059 검증 '시험 담당에게 넘길 시험' X4·X7).
// - X4: local·ci 밖에서 도우미가 만드는 읽기 연결에 운영 인증(MSK IAM)을 싣는가. 연결 설정을 만드는 함수(kafka-config.js)를 진짜 그대로
//   부르며 받은 값만 기록한다(통과 감시). MSK 서명 도구(제3자 SDK)는 STS에 나가지 않게 시험 토큰을 준다(허용 목록 '클라우드 SDK')
// - X7: 시간 옵션 없이 부른 도우미의 준비 한도가 정본 30초인가. 단언 값은 상수(CONTROL_SYNC_DEFAULTS)를 가져오지 않고 정본 값을 적는다
// 켜진 소비의 실제 Kafka 왕복은 test-int/control-sync.int.test.ts, 서비스 시작 파일의 /ready 503은 queue-svc·purchase-svc 통합 시험이 본다.
import 'reflect-metadata';
import { Controller, Get, Module, type Type } from '@nestjs/common';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { generateAuthTokenFromRole } from 'aws-msk-iam-sasl-signer-js';
import { Roles, createService, fakeClock, type PlatformService } from '../src/index.js';
import { kafkaAdminConfig, kafkaConsumerConfig } from '../src/kafka-config.js';
import { startServiceControlSync, type ServiceControlSync } from '../src/stream-worker.js';
import { collector, sample } from './fixture.js';

vi.mock(import('../src/kafka-config.js'), async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, kafkaAdminConfig: vi.fn(real.kafkaAdminConfig), kafkaConsumerConfig: vi.fn(real.kafkaConsumerConfig) };
});
vi.mock(import('aws-msk-iam-sasl-signer-js'), async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, generateAuthTokenFromRole: vi.fn<typeof real.generateAuthTokenFromRole>(async () => ({ token: 'test-msk-token', expiryTime: Date.parse('2099-01-01T00:00:00Z') })) };
});

/** 정본(ADR-0103 결정 2, identity.md §12 I-T48 ③, devops.md D-T29 ④): Kafka에 닿지 못해도 30초 [가정] 뒤 준비 상태로 간다 */
const DEGRADE_MS = 30_000;
const SERVICE = 'sync-svc';
/** 듣는 곳이 없는 주소(연결 거부). 도우미는 이 주소로 실제 클라이언트를 만든다 */
const UNREACHABLE = '127.0.0.1:1';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/sync-svc-msk';

@Controller('v1/fan')
class FanController {
  @Get('me')
  @Roles(['fan'])
  me() {
    return { ok: true };
  }
}

function moduleOf(...controllers: Type<unknown>[]) {
  @Module({ controllers })
  class M {}
  return M;
}

/** 닫기 한도: 도우미의 close()는 닿지 않는 브로커에 걸린 관리 요청이 클라이언트 안의 시간 한도(요청마다 5초 [가정], 두 토픽)로 끝나기를
 * 기다린 뒤 연결을 닫는다. 그 기다림이 기본 훅 한도(10초)에 걸려 몰릴 때 실패했으므로 이 파일의 닫기 훅만 넉넉히 둔다(BAT-059) */
const CLOSE_HOOK_MS = 30_000;
const services: PlatformService[] = [];
const syncs: ServiceControlSync[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (syncs.length) await syncs.pop()!.close();
  while (services.length) await services.pop()!.close();
  vi.mocked(kafkaAdminConfig).mockClear();
  vi.mocked(kafkaConsumerConfig).mockClear();
  vi.mocked(generateAuthTokenFromRole).mockClear();
}, CLOSE_HOOK_MS);

async function boot(env: Record<string, string>) {
  const svc = await createService({
    name: SERVICE,
    module: moduleOf(FanController),
    env: { PEAKET_LOG_SAMPLE_ONE_IN: '1', PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 5).toString('base64'), PORT: '0', PEAKET_MANAGEMENT_PORT: '0', ...env },
    clock: fakeClock(),
    logDestination: collector().stream,
  });
  services.push(svc);
  return svc;
}

const until = async (cond: () => boolean, what: string, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`기다린 조건이 오지 않았다: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('I-T3 ② 도우미가 만드는 읽기 연결의 운영 인증(ADR-0333 결정 2)', () => {
  test('I-T3 ②-13 local·ci 밖(staging, PEAKET_KAFKA_AUTH=msk-iam)에서 도우미가 만드는 Kafka 읽기 연결은 운영 인증(MSK IAM 역할·세션 이름, TLS·OAUTHBEARER)을 싣는다', async () => {
    const env = { PEAKET_ENV: 'staging', PEAKET_KAFKA_BROKERS: UNREACHABLE, PEAKET_KAFKA_AUTH: 'msk-iam', PEAKET_KAFKA_MSK_ROLE_ARN: ROLE_ARN, AWS_REGION: 'ap-northeast-2', PEAKET_POD: 'pod-x4' };
    const svc = await boot(env);
    // real-time: 도우미는 실제 Kafka 클라이언트를 만들어 닿지 않는 주소로 붙어 본다(연결 설정이 만들어지는 때를 조건으로 기다린다) BAT-059
    const h = startServiceControlSync(svc, env);
    expect(h).toBeDefined();
    syncs.push(h!);
    await until(() => vi.mocked(kafkaAdminConfig).mock.calls.length > 0, '읽기 연결 설정');
    const calls = [...vi.mocked(kafkaAdminConfig).mock.calls, ...vi.mocked(kafkaConsumerConfig).mock.calls];
    for (const [o] of calls) {
      expect(o.brokers).toEqual([UNREACHABLE]);
      expect(o.auth).toMatchObject({ mechanism: 'msk-iam', sessionName: 'sync-svc-staging' });
    }
    const made = vi.mocked(kafkaAdminConfig).mock.results[0]!;
    expect(made.type).toBe('return');
    expect(made.type === 'return' && made.value.kafkaJS).toMatchObject({ brokers: [UNREACHABLE], ssl: true, sasl: { mechanism: 'oauthbearer' } });
    // 실린 인증이 실제로 쓰인다: 클라이언트가 토큰을 그 역할·세션 이름으로 만든다
    await until(() => vi.mocked(generateAuthTokenFromRole).mock.calls.length > 0, 'MSK 토큰 만들기');
    expect(vi.mocked(generateAuthTokenFromRole).mock.calls[0]![0]).toMatchObject({ region: 'ap-northeast-2', awsRoleArn: ROLE_ARN, awsRoleSessionName: 'sync-svc-staging' });
  }, 30_000);
});

describe('I-T48 ③ 도우미 경로의 준비 한도(ADR-0103 결정 2)', () => {
  test(`I-T48 ③-4 도우미를 시간 옵션 없이 부르고 브로커가 닿지 않으면 정본 ${DEGRADE_MS}ms − 1ms까지 /ready가 503(남은 작업 sessions·settings)이고, ${DEGRADE_MS}ms에 200과 control_sync_lagging{kind="sessions"}=1이다`, async () => {
    const env = { PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: UNREACHABLE, PEAKET_POD: 'pod-x7' };
    const svc = await boot(env);
    const ready = async () => {
      const r = await svc.management.inject({ method: 'GET', url: '/ready' });
      return { status: r.statusCode, pending: [...((JSON.parse(r.payload) as { pending?: string[] }).pending ?? [])].sort() };
    };
    const lagging = async (kind: string) => sample((await svc.management.inject({ method: 'GET', url: '/metrics' })).payload, 'control_sync_lagging', { service: SERVICE, kind });
    // 준비 한도 타이머가 가짜 시계 위에서 걸리게 도우미를 부르기 전에 켠다. Date는 그대로 둔다(서비스 시계는 fakeClock)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    // real-time: 도우미는 실제 Kafka 클라이언트를 만들어 닿지 않는 주소로 붙어 본다(그 왕복의 시간 한도는 클라이언트 안에서 실제 시간으로 돈다) BAT-059
    const h = startServiceControlSync(svc, env);
    expect(h).toBeDefined();
    syncs.push(h!);

    await vi.advanceTimersByTimeAsync(DEGRADE_MS - 1);
    expect(await ready()).toEqual({ status: 503, pending: ['sessions', 'settings'] });
    expect(await lagging('sessions')).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(await ready()).toEqual({ status: 200, pending: [] });
    expect(await lagging('sessions')).toBe(1);
    expect(await lagging('settings')).toBe(1);
  }, 30_000);
});
