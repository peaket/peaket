// ops main.ts의 CS 처리함 영업일 달력 조립(F-06-2 GAT-280, R-T50 ④). 시험 담당 lane3-f062-test.
// main.ts를 실제로 읽어 띄우고(바깥 연결만 가짜로 바꿈) 공휴일 파일이 AppModule.register의 calendar로 넘어가는지,
// staging·prod에서 파일이 없거나 읽지 못하는 파일이면 시작하지 않는지 본다(event-cancellation-main-wiring.test.ts와 같은 방법).
// 정본: ADR-0364 결정 1(local·ci는 파일이 없으면 주말만 빼고, staging·prod의 ops-svc는 파일이 없거나 읽지 못하면 시작하지 않는다), transfer-refund §11 R-T50 ④.
// 모듈 가짜(vi.mock)는 파일 전체에 걸리므로 다른 시험과 섞지 않으려고 파일을 따로 둔다.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  register: undefined as undefined | { calendar?: { isBusinessDay(d: string): boolean } },
  order: [] as string[],
}));

vi.mock('@peaket/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@peaket/platform')>();
  return {
    ...actual,
    assertInternalGrpcToken: () => undefined,
    createDatabase: () => ({ db: {}, pool: {}, transaction: async () => undefined, close: async () => undefined }),
    createService: async () => {
      seen.order.push('createService');
      return {
        metrics: { registry: { registerMetric: () => undefined } },
        logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
        listen: async () => {
          seen.order.push('listen');
        },
        close: async () => undefined,
      };
    },
  };
});
vi.mock('../src/app.module.js', () => ({
  AppModule: {
    register: (o: typeof seen.register) => {
      seen.register = o;
      return {};
    },
  },
}));
vi.mock('../src/adapters/identity-admin-authz.js', () => ({
  GrpcAdminAuthz: class {
    close(): void {}
  },
}));

const dir = mkdtempSync(join(tmpdir(), 'f062-holidays-'));
const goodFile = join(dir, 'holidays.json');
writeFileSync(goodFile, JSON.stringify({ holidays: ['2026-11-25'] }), 'utf8');
const brokenFile = join(dir, 'broken.json');
writeFileSync(brokenFile, '{"holidays": [', 'utf8');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function bootMain(env: Record<string, string>): Promise<void> {
  for (const k of Object.keys(process.env)) if (/^PEAKET_/.test(k)) vi.stubEnv(k, '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('PEAKET_DATABASE_URL', 'postgres://ops_app@db.internal:5432/ops');
  vi.stubEnv('PEAKET_IDENTITY_GRPC_URL', '127.0.0.1:1');
  seen.register = undefined;
  seen.order.length = 0;
  vi.resetModules();
  const sigterm = process.listeners('SIGTERM');
  try {
    await import('../src/main.js');
  } finally {
    for (const l of process.listeners('SIGTERM')) if (!sigterm.includes(l)) process.removeListener('SIGTERM', l);
  }
}

// F-06-2 검증 1 넘김 ②(시험 담당 lane3-f062-test): main.ts를 처음 읽을 때 모듈 그래프 변환이 한 번 크게 든다(단독 약 6초, 몰릴 때 30초 넘김).
// 그 비용을 beforeAll에서 한 번 치르고(변환은 vi.resetModules 뒤에도 캐시에 남는다), 시험마다 main.ts를 한 번씩만 띄운다.
// 시험 한도는 이 파일의 시험만 60초로 둔다: 시험마다 main.ts 전체(서비스 조립 import 수십 개)를 새로 평가하는 것이라 다른 단위 시험보다 무겁다
const BOOT_TEST_TIMEOUT_MS = 60_000;
beforeAll(async () => {
  await bootMain({ PEAKET_ENV: 'ci' });
}, 120_000);

describe('R-T50 ④ main.ts 시작의 공휴일 달력', () => {
  test('R-T50 ④ ci에서 공휴일 파일을 주면 그 달력이 AppModule.register에 넘어간다', { timeout: BOOT_TEST_TIMEOUT_MS }, async () => {
    await bootMain({ PEAKET_ENV: 'ci', PEAKET_HOLIDAY_CALENDAR_FILE: goodFile });
    expect(seen.order).toEqual(['createService', 'listen']);
    expect(['2026-11-24', '2026-11-25', '2026-11-28'].map((d) => seen.register?.calendar?.isBusinessDay(d))).toEqual([true, false, false]);
  });

  test('R-T50 ④ local에서 파일이 없으면 주말만 빼는 달력으로 시작한다', { timeout: BOOT_TEST_TIMEOUT_MS }, async () => {
    await bootMain({ PEAKET_ENV: 'local' });
    expect(seen.order).toEqual(['createService', 'listen']);
    expect(['2026-11-25', '2026-11-28'].map((d) => seen.register?.calendar?.isBusinessDay(d))).toEqual([true, false]);
  });

  test('R-T50 ④ staging·prod는 공휴일 파일이 없으면 서비스를 만들기 전에 시작을 멈춘다', { timeout: BOOT_TEST_TIMEOUT_MS }, async () => {
    // 재인증 값(staging·prod 필수, reauth-wiring.ts)은 채워 달력 검사까지 가게 한다. 연결은 달력 뒤에 만든다
    const reauth = { PEAKET_IDENTITY_JWKS_URL: 'https://identity.internal/jwks.json', PEAKET_REAUTH_REDIS_URL: 'redis://127.0.0.1:1' };
    for (const env of ['staging', 'prod']) {
      await expect(bootMain({ PEAKET_ENV: env, ...reauth }), env).rejects.toThrow(/PEAKET_HOLIDAY_CALENDAR_FILE/);
      expect(seen.order, env).toEqual([]);
    }
  });

  test('R-T50 ④ 읽지 못하는 파일·꼴이 틀린 파일은 local·ci라도 시작하지 않는다', { timeout: BOOT_TEST_TIMEOUT_MS }, async () => {
    for (const env of ['ci', 'local']) {
      await expect(bootMain({ PEAKET_ENV: env, PEAKET_HOLIDAY_CALENDAR_FILE: join(dir, 'missing.json') }), `${env} 없는 파일`).rejects.toThrow(/PEAKET_HOLIDAY_CALENDAR_FILE/);
      await expect(bootMain({ PEAKET_ENV: env, PEAKET_HOLIDAY_CALENDAR_FILE: brokenFile }), `${env} 깨진 파일`).rejects.toThrow();
      expect(seen.order, env).toEqual([]);
    }
  });
});
