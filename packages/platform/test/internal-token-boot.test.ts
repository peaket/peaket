// 내부 HTTP 공유 토큰의 시작 게이트(OPS-05·C2-03). 운영·스테이징은 토큰이 없으면 createService가 시작하지 않는다.
// 가드 단위 시험(internal-token.test.ts)과 달리, 여기서는 PEAKET_ENV가 INTERNAL_TOKEN_REQUIRED로 배선되는지까지 본다.
import { Controller, Get, Module, UseGuards, type DynamicModule } from '@nestjs/common';
import { Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { INTERNAL_TOKEN, InternalTokenGuard, Roles, createService, type PlatformService } from '../src/index.js';

@Controller('internal-token-boot')
class GuardedController {
  @Get('ping')
  @Roles(['public'])
  @UseGuards(InternalTokenGuard)
  ping(): { ok: boolean } {
    return { ok: true };
  }
}

function guardedModule(token?: string): DynamicModule {
  @Module({
    controllers: [GuardedController],
    providers: [{ provide: INTERNAL_TOKEN, useValue: token }, InternalTokenGuard],
  })
  class GuardedModule {}
  return { module: GuardedModule };
}

const sink = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

// 운영 환경의 다른 필수 값(로그 가명 키)도 채워, 이 시험이 내부 토큰 게이트만 겨루게 한다.
const LOG_KEY = Buffer.alloc(32, 1).toString('base64');

const boot = (env: Record<string, string | undefined>, token?: string) =>
  createService({
    name: 'internal-token-boot-test',
    module: guardedModule(token),
    env: { PEAKET_LOG_SAMPLE_ONE_IN: '1', PEAKET_LOG_PSEUDONYM_KEY: LOG_KEY, ...env },
    logDestination: sink,
  });

/** 시작이 거절되어야 하는 환경. 거절되지 않으면 만든 서비스를 닫고 실패한다(자원 누수 방지). */
async function expectStartupRejected(env: Record<string, string | undefined>): Promise<void> {
  const r = await boot(env).then(
    (svc): { svc: PlatformService } => ({ svc }),
    (err: Error): { err: Error } => ({ err }),
  );
  if ('svc' in r) {
    await r.svc.close().catch(() => undefined);
    throw new Error(`${env.PEAKET_ENV}에서 PEAKET_INTERNAL_TOKEN 없이 서비스가 시작됐다`);
  }
  expect(r.err.message).toMatch(/PEAKET_INTERNAL_TOKEN/);
}

describe('내부 토큰 시작 게이트 [OPS-05·C2-03]', () => {
  test('prod·staging은 토큰이 없거나 비면 시작을 막고, local·ci는 토큰 없이 시작하며, 토큰이 있으면 머리 없는 요청을 403으로 닫는다', async () => {
    for (const env of ['prod', 'staging']) {
      await expectStartupRejected({ PEAKET_ENV: env });
      await expectStartupRejected({ PEAKET_ENV: env, PEAKET_INTERNAL_TOKEN: '' });
    }
    for (const env of ['local', 'ci']) {
      const svc = await boot({ PEAKET_ENV: env });
      await svc.close();
    }
    const svc = await boot({ PEAKET_ENV: 'prod', PEAKET_INTERNAL_TOKEN: 'shared-secret' }, 'shared-secret');
    try {
      expect((await svc.http.inject({ method: 'GET', url: '/internal-token-boot/ping' })).statusCode).toBe(403);
      expect((await svc.http.inject({ method: 'GET', url: '/internal-token-boot/ping', headers: { 'x-peaket-internal-token': 'wrong-secret' } })).statusCode).toBe(403);
      expect((await svc.http.inject({ method: 'GET', url: '/internal-token-boot/ping', headers: { 'x-peaket-internal-token': 'shared-secret' } })).statusCode).toBe(200);
    } finally {
      await svc.close().catch(() => undefined);
    }
  });
});
