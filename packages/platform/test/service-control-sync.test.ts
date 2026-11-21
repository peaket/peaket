// 서비스의 종료 세션 목록 소비 도우미와 빠뜨림 막기(docs/features/identity.md §3 '서비스에 잇기'·§12 I-T3 ②, ADR-0333 결정 2·3,
// BUILD_ORDER HOT-401 묶음 BAT-059). 브로커 주소 규칙(local·ci만 끈다, 틀린 조각은 몇 번째만), 파드 이름, 꺼진 설정의 경고 한 줄,
// local·ci 밖에서 신원 처리기가 있는데 소비 없이 듣기 시작하면 시작하지 않는 것을 본다. 켜진 소비(실제 Kafka)는 test-int/control-sync.int.test.ts.
import 'reflect-metadata';
import { hostname } from 'node:os';
import { Controller, Get, Module, type Type } from '@nestjs/common';
import { afterEach, describe, expect, test } from 'vitest';
import { PlatformConfigError, Roles, createService, fakeClock, type AdminAuthz, type AdminAuthzPort, type PlatformService } from '../src/index.js';
import { controlSyncConfigFromEnv, startServiceControlSync } from '../src/stream-worker.js';
import { collector } from './fixture.js';

const SERVICE = 'sync-svc';
const LOG_KEY = Buffer.alloc(32, 5).toString('base64');
const OFF_ENVS = ['local', 'ci'];
const ON_ENVS = ['demo', 'staging', 'prod'];

@Controller('v1/open')
class OpenController {
  @Get('ping')
  @Roles(['public'])
  ping() {
    return { ok: true };
  }
}

@Controller('v1/fan')
class FanController {
  @Get('me')
  @Roles(['fan'])
  me() {
    return { ok: true };
  }
}

/** 공개와 신원 역할을 함께 허용한 처리기: 신원 머리(X-Session-Id)를 받으면 종료 세션 목록이 막아야 한다(ADR-0333 결정 1·3) */
@Controller('v1/mixed')
class MixedController {
  @Get('feed')
  @Roles(['public', 'fan'])
  feed() {
    return { ok: true };
  }
}

@Controller('v1/ops')
class OpsController {
  @Get('board')
  @Roles(['operator', 'commander'])
  board() {
    return { ok: true };
  }
}

/** 관리 역할 처리기가 있으면 createService가 요구하는 identity 조회 포트(이 시험은 요청을 보내지 않는다) */
class NoIdentity implements AdminAuthzPort {
  async getAdminAuthz(_q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    return { valid: false, role: '' };
  }
}

function moduleOf(...controllers: Type<unknown>[]) {
  @Module({ controllers })
  class M {}
  return M;
}

const started: PlatformService[] = [];
afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

async function boot(env: Record<string, string>, ...controllers: Type<unknown>[]) {
  const logs = collector();
  const svc = await createService({
    name: SERVICE,
    module: moduleOf(...controllers),
    env: { PEAKET_LOG_SAMPLE_ONE_IN: '1', PEAKET_LOG_PSEUDONYM_KEY: LOG_KEY, PORT: '0', PEAKET_MANAGEMENT_PORT: '0', ...env },
    clock: fakeClock(),
    logDestination: logs.stream,
    adminAuthz: new NoIdentity(),
  });
  started.push(svc);
  return { svc, logs };
}

describe('I-T3 ② 브로커 주소 규칙(controlSyncConfigFromEnv)', () => {
  test('I-T3 ②-1 local·ci 밖(demo·staging·prod)이나 PEAKET_ENV가 없으면 브로커 주소가 없거나 빈칸뿐일 때 시작에 실패하고, local·ci만 꺼진 설정과 경고 글을 준다', () => {
    for (const env of [...ON_ENVS, undefined]) {
      for (const brokers of [undefined, '', '   ']) {
        expect(() => controlSyncConfigFromEnv(SERVICE, { PEAKET_ENV: env, PEAKET_KAFKA_BROKERS: brokers }), `${env}/${JSON.stringify(brokers)}`).toThrow(PlatformConfigError);
      }
    }
    for (const env of OFF_ENVS) {
      for (const brokers of [undefined, '', '   ']) {
        const cfg = controlSyncConfigFromEnv(SERVICE, { PEAKET_ENV: env, PEAKET_KAFKA_BROKERS: brokers });
        expect(cfg.enabled, `${env}/${JSON.stringify(brokers)}`).toBe(false);
        expect(cfg.enabled === false && cfg.warning).toMatch(/PEAKET_KAFKA_BROKERS/);
      }
    }
  });

  test('I-T3 ②-2 틀린 조각은 몇 번째인지만 알리고 그 조각의 원문은 싣지 않는다', () => {
    const cases: [string, number, string][] = [
      ['kafka-1:9092,user:pw-secret@kafka-2:9092', 2, 'pw-secret'],
      ['kafka-1:9092, kafka-2:9092 ,kafka-3', 3, 'kafka-3'],
      ['https://kafka-1:9092', 1, 'https://'],
    ];
    for (const [brokers, nth, secret] of cases) {
      let err: unknown;
      try {
        controlSyncConfigFromEnv(SERVICE, { PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: brokers });
      } catch (e) {
        err = e;
      }
      expect(err, brokers).toBeInstanceOf(PlatformConfigError);
      expect((err as Error).message, brokers).toContain(`${nth}번째`);
      expect((err as Error).message, brokers).not.toContain(secret);
    }
  });

  test('I-T3 ②-3 켜진 설정은 쉼표로 나눈 브로커와 환경을 주고, 파드 이름은 PEAKET_POD → HOSTNAME → 호스트 이름 차례에 64자까지다', () => {
    const base = { PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: ' kafka-1:9092 , kafka-2:19092 ' };
    expect(controlSyncConfigFromEnv(SERVICE, { ...base, PEAKET_POD: 'queue-svc-7d9f-abcde', HOSTNAME: 'host-x' })).toEqual({ enabled: true, brokers: ['kafka-1:9092', 'kafka-2:19092'], env: 'ci', pod: 'queue-svc-7d9f-abcde' });
    expect(controlSyncConfigFromEnv(SERVICE, { ...base, HOSTNAME: 'host-x' })).toMatchObject({ pod: 'host-x' });
    expect(controlSyncConfigFromEnv(SERVICE, { ...base })).toMatchObject({ pod: hostname().slice(0, 64) });
    const long = `p${'x'.repeat(70)}`;
    expect(controlSyncConfigFromEnv(SERVICE, { ...base, PEAKET_POD: long })).toMatchObject({ pod: long.slice(0, 64) });
  });
});

describe('I-T3 ② 도우미와 빠뜨림 막기(ADR-0333 결정 2·3)', () => {
  test('I-T3 ②-4 꺼진 설정(ci, 브로커 없음)이면 도우미가 경고 한 줄({dep:kafka, kind:control-sync})만 남기고 undefined를 주며 시작 표시를 켜지 않는다', async () => {
    const { svc, logs } = await boot({ PEAKET_ENV: 'ci' }, FanController);
    expect(startServiceControlSync(svc, { PEAKET_ENV: 'ci' })).toBeUndefined();
    const warned = logs.lines.filter((l) => l.dep === 'kafka' && l.kind === 'control-sync');
    expect(warned).toHaveLength(1);
    expect(String(warned[0]!.msg)).toMatch(/PEAKET_KAFKA_BROKERS/);
    expect(svc.controlSync.started).toBe(false);
  });

  test('I-T3 ②-5 local·ci 밖에서 브로커 주소가 없으면 도우미가 PlatformConfigError로 시작을 막는다', async () => {
    for (const env of ON_ENVS) {
      const { svc } = await boot({ PEAKET_ENV: env }, OpenController);
      expect(() => startServiceControlSync(svc, { PEAKET_ENV: env }), env).toThrow(PlatformConfigError);
      expect(svc.controlSync.started, env).toBe(false);
    }
  });

  test('I-T3 ②-6 local·ci 밖에서 신원 역할(팬·운영) 처리기가 있는데 소비 없이 듣기 시작하면 PlatformConfigError로 듣지 않는다', async () => {
    for (const env of ON_ENVS) {
      for (const c of [FanController, OpsController]) {
        const { svc } = await boot({ PEAKET_ENV: env }, OpenController, c);
        await expect(svc.listen('127.0.0.1'), `${env}/${c.name}`).rejects.toThrow(PlatformConfigError);
        expect(svc.http.server.listening, `${env}/${c.name}`).toBe(false);
        expect(svc.management.server.listening, `${env}/${c.name}`).toBe(false);
      }
    }
  });

  test("I-T3 ②-12 공개와 신원 역할을 함께 허용한 처리기(@Roles(['public', 'fan']))만 있어도 신원 처리기로 보아, local·ci 밖에서 소비 없이 듣기 시작하면 PlatformConfigError로 듣지 않는다", async () => {
    for (const env of ON_ENVS) {
      const { svc } = await boot({ PEAKET_ENV: env }, MixedController);
      const listening = svc.listen('127.0.0.1');
      await expect(listening, env).rejects.toThrow(PlatformConfigError);
      // 막은 까닭에 그 처리기 이름이 실린다(신원 처리기로 셌다는 뜻)
      await expect(listening, env).rejects.toThrow(/MixedController\.feed/);
      expect(svc.http.server.listening, env).toBe(false);
      expect(svc.management.server.listening, env).toBe(false);
    }
  });

  test('I-T3 ②-7 공개 처리기만 있으면 local·ci 밖에서도 소비 없이 듣고, local·ci는 신원 처리기가 있어도 소비 없이 듣는다', async () => {
    // real-time: listen이 빠뜨림 막기를 지나 실제로 듣는지는 포트를 열어야 보인다(빈 포트 0, 127.0.0.1) BAT-059
    for (const env of ON_ENVS) {
      const { svc } = await boot({ PEAKET_ENV: env }, OpenController);
      await svc.listen('127.0.0.1');
      expect(svc.http.server.listening, env).toBe(true);
    }
    for (const env of OFF_ENVS) {
      const { svc } = await boot({ PEAKET_ENV: env }, FanController, OpsController);
      await svc.listen('127.0.0.1');
      expect(svc.http.server.listening, env).toBe(true);
    }
  });
});
