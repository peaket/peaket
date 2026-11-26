// F-06-4 ops 시작 조립 시험(시험 담당 lane2-freeze-F-06-4-reviewfix, 시험 리뷰 TR-16 반영).
// ① restrictionPortsFromEnv(env): staging·prod는 네 주소가 없으면 그 이름을 말하며 던지고, local·ci·demo는 칸이 빈다.
// ② main.ts를 실제로 읽어 띄우고(바깥 연결만 가짜) 그 포트가 AppModule.register의 restrictions로 넘어가는지 본다.
// 정본: 계획 §3·§4.4·§6, docs/architecture.md §8.6 4 '시작 조립'.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  register: undefined as undefined | { restrictions?: Record<string, unknown>; background?: unknown },
  order: [] as string[],
}));

vi.mock('@peaket/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@peaket/platform')>();
  return {
    ...actual,
    assertInternalGrpcToken: () => undefined,
    createDatabase: () => ({ db: { execute: async () => ({ rows: [{ member: true, other: false, privileged: false, owner: false }] }) }, pool: {}, transaction: async () => undefined, close: async () => undefined }),
    createHotRedis: async () => ({ command: async () => null, close: async () => undefined }),
    createService: async () => {
      seen.order.push('createService');
      return {
        metrics: { registry: { registerMetric: () => undefined, metrics: async () => '' } },
        app: {
          get: () => ({
            configure: () => undefined,
            tick: async () => undefined,
            start: () => undefined,
            stop: async () => undefined,
            runOnce: async () => undefined,
          }),
        },
        logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
        listen: async () => { seen.order.push('listen'); },
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

const ADDRESSES = { queue: '127.0.0.1:51051', purchase: '127.0.0.1:51052', coreGrpc: '127.0.0.1:51053', coreHttp: 'http://127.0.0.1:51054' };

const envOf = (o: { env?: string; queue?: boolean; purchase?: boolean; coreGrpc?: boolean; coreHttp?: boolean } = {}): Record<string, string> => {
  const env: Record<string, string> = { PEAKET_ENV: o.env ?? 'ci' };
  if (o.queue !== false) env.PEAKET_QUEUE_GRPC_URL = ADDRESSES.queue;
  if (o.purchase !== false) env.PEAKET_PURCHASE_GRPC_URL = ADDRESSES.purchase;
  if (o.coreGrpc !== false) env.PEAKET_CORE_GRPC_URL = ADDRESSES.coreGrpc;
  if (o.coreHttp !== false) env.PEAKET_CORE_HTTP_URL = ADDRESSES.coreHttp;
  env.PEAKET_INTERNAL_GRPC_TOKEN = 'restriction-internal-grpc-token-0000';
  env.PEAKET_INTERNAL_TOKEN = 'restriction-internal-http-token-0000';
  return env;
};

describe('TR-16 restrictionPortsFromEnv', () => {
  test('TR-16 staging·prod에서 네 주소가 없으면 그 변수 이름을 말하며 던진다', async () => {
    const w = await wiring();
    for (const envName of ['staging', 'prod']) {
      const all = envOf({ env: envName });
      for (const [key, name] of [
        ['PEAKET_QUEUE_GRPC_URL', 'queue'],
        ['PEAKET_PURCHASE_GRPC_URL', 'purchase'],
        ['PEAKET_CORE_GRPC_URL', 'coreGrpc'],
        ['PEAKET_CORE_HTTP_URL', 'coreHttp'],
      ] as const) {
        const { [key]: _gone, ...rest } = all;
        expect(() => w.restrictionPortsFromEnv(rest), `${envName}:${name}`).toThrow(new RegExp(key));
      }
    }
  });

  test('TR-16 local·ci·demo는 주소가 없어도 던지지 않고 그 칸이 비며, 다 있으면 사본·소명·조사관·알림·보류 포트와 close가 선다', async () => {
    const w = await wiring();
    for (const envName of ['local', 'ci', 'demo']) {
      const none = w.restrictionPortsFromEnv({ PEAKET_ENV: envName });
      expect([envName, none.copies, none.appeals, none.fraudCases, none.notifier, none.holds]).toEqual([envName, undefined, undefined, undefined, undefined, undefined]);
      none.close();
      const all = w.restrictionPortsFromEnv(envOf({ env: envName }));
      try {
        expect([typeof all.copies?.queue, typeof all.copies?.purchase, typeof all.copies?.view, typeof all.appeals?.read, typeof all.appeals?.result, typeof all.fraudCases?.investigatorOf, typeof all.notifier?.send, typeof all.holds?.set, typeof all.close]).toEqual(['function', 'function', 'function', 'function', 'function', 'function', 'function', 'function', 'function']);
      } finally {
        all.close();
      }
    }
  });
});

interface Wiring {
  restrictionPortsFromEnv(env: Record<string, string>): {
    copies?: { queue: (...a: unknown[]) => unknown; purchase: (...a: unknown[]) => unknown; view: (...a: unknown[]) => unknown };
    appeals?: { read: (...a: unknown[]) => unknown; result: (...a: unknown[]) => unknown };
    fraudCases?: { investigatorOf: (...a: unknown[]) => unknown };
    notifier?: { send: (...a: unknown[]) => unknown };
    holds?: { set: (...a: unknown[]) => unknown };
    close(): void;
  };
}
async function wiring(): Promise<Wiring> {
  const spec = '../src/restriction-wiring.js';
  try {
    return (await import(/* @vite-ignore */ spec)) as Wiring;
  } catch (err) {
    if (err instanceof Error && /Cannot find module|Failed to load url|ERR_MODULE_NOT_FOUND|Does the file exist/i.test(err.message)) throw new Error('src/restriction-wiring.ts가 없다(계획 §3)');
    throw err;
  }
}

async function bootMain(env: Record<string, string>): Promise<void> {
  for (const k of Object.keys(process.env)) if (/^PEAKET_/.test(k)) vi.stubEnv(k, '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
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

const BOOT_TIMEOUT_MS = 60_000;
let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'f064-holidays-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mainEnv = (): Record<string, string> => {
  const holidays = join(dir, 'holidays.json');
  writeFileSync(holidays, JSON.stringify({ holidays: ['2026-11-25'] }), 'utf8');
  return {
    ...envOf({ env: 'ci' }),
    PEAKET_ENV: 'ci',
    PEAKET_HOLIDAY_CALENDAR_FILE: holidays,
    PEAKET_IDENTITY_JWKS_URL: 'https://identity.internal/jwks.json',
    PEAKET_REAUTH_REDIS_URL: 'redis://127.0.0.1:1',
    PEAKET_TENANT_REDIS_URL: 'redis://127.0.0.1:2',
    PEAKET_DATABASE_URL: 'postgres://ops_app@db.internal:5432/ops',
    PEAKET_PARTNER_DATABASE_URL: 'postgres://ops_partner@db.internal:5432/ops',
    PEAKET_IDENTITY_GRPC_URL: '127.0.0.1:59999',
    PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 5).toString('base64'),
  };
};

describe('TR-16 main.ts 조립', () => {
  test('TR-16 ci에서 네 주소를 주면 main.ts가 restrictions를 AppModule.register에 넘기고 배경 작업을 끄지 않는다', { timeout: BOOT_TIMEOUT_MS }, async () => {
    await bootMain(mainEnv());
    expect(seen.order).toEqual(['createService', 'listen']);
    const r = seen.register?.restrictions as Record<string, Record<string, unknown> | undefined> | undefined;
    expect([typeof r?.copies?.queue, typeof r?.copies?.purchase, typeof r?.copies?.view, typeof r?.appeals?.read, typeof r?.fraudCases?.investigatorOf, typeof r?.notifier?.send, typeof r?.holds?.set]).toEqual(['function', 'function', 'function', 'function', 'function', 'function', 'function']);
    expect(seen.register?.background).not.toBe(false);
  });

  test('IR-02 main.ts가 10분 정비·다시 보내기 작업(RestrictionMaintenanceJob)을 시작하고 종료 때 멈춘다', () => {
    const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/RestrictionMaintenanceJob/);
    expect(main).toMatch(/restrictionMaintenance\.start\(\)/);
    expect(main).toMatch(/restrictionMaintenance\.stop\(\)/);
  });
});
