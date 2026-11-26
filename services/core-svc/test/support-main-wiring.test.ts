// F-06-4 core-svc support 시작 조립 시험(시험 담당 lane2-freeze-F-06-4-reviewfix, 시험 리뷰 TR-16 반영).
// ① supportPortsFromEnv(env): staging·prod는 ops HTTP 주소·Redis 주소가 없으면 그 이름을 말하며 던지고, local·ci·demo는 칸이 빈다.
// ② main.ts가 그 포트를 AppModule.register의 support로 넘기는지 소스로 확인한다(코어 main은 DB URL이 많아 띄우지 않는다).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

interface Wiring {
  supportPortsFromEnv(env: Record<string, string>): {
    fraudAppeals?: { send: (...a: unknown[]) => unknown };
    notifier?: { send: (...a: unknown[]) => unknown };
    views?: unknown;
    close(): void;
  };
}
async function wiring(): Promise<Wiring> {
  const spec = '../src/support-wiring.js';
  try {
    return (await import(/* @vite-ignore */ spec)) as Wiring;
  } catch (err) {
    if (err instanceof Error && /Cannot find module|Failed to load url|ERR_MODULE_NOT_FOUND|Does the file exist/i.test(err.message)) throw new Error('src/support-wiring.ts가 없다(계획 §3)');
    throw err;
  }
}

const envOf = (o: { env?: string; ops?: boolean; redis?: boolean } = {}): Record<string, string> => {
  const env: Record<string, string> = { PEAKET_ENV: o.env ?? 'ci', PEAKET_INTERNAL_TOKEN: 'support-internal-http-token-0000' };
  if (o.ops !== false) env.PEAKET_OPS_HTTP_URL = 'http://ops.internal:8080';
  if (o.redis !== false) env.PEAKET_REDIS_URL = 'redis://127.0.0.1:6379';
  return env;
};

describe('TR-16 supportPortsFromEnv', () => {
  test('TR-16 staging·prod에서 ops 주소나 Redis 주소가 없으면 그 변수 이름을 말하며 던진다', async () => {
    const w = await wiring();
    for (const envName of ['staging', 'prod']) {
      const all = envOf({ env: envName });
      const { PEAKET_OPS_HTTP_URL: _o, ...noOps } = all;
      expect(() => w.supportPortsFromEnv(noOps), envName).toThrow(/PEAKET_OPS_HTTP_URL/);
      const { PEAKET_REDIS_URL: _r, ...noRedis } = all;
      expect(() => w.supportPortsFromEnv(noRedis), envName).toThrow(/PEAKET_REDIS_URL/);
    }
  });

  test('TR-16 local·ci·demo는 주소가 없어도 던지지 않고 칸이 비며, 다 있으면 소명 입구·알림·사본 포트와 close가 선다', async () => {
    const w = await wiring();
    for (const envName of ['local', 'ci', 'demo']) {
      const none = w.supportPortsFromEnv({ PEAKET_ENV: envName });
      expect([envName, none.fraudAppeals, none.notifier, none.views]).toEqual([envName, undefined, undefined, undefined]);
      none.close();
      const all = w.supportPortsFromEnv(envOf({ env: envName }));
      try {
        expect([typeof all.fraudAppeals?.send, typeof all.notifier?.send, typeof all.views, typeof all.close]).toEqual(['function', 'function', 'object', 'function']);
      } finally {
        all.close();
      }
    }
  });
});

describe('TR-16 main.ts 조립', () => {
  test('TR-16 main.ts가 supportPortsFromEnv를 읽어 support로 넘긴다', () => {
    const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/supportPortsFromEnv\s*\(/);
    expect(main).toMatch(/support:\s*supportPorts/);
    expect(main).toMatch(/PEAKET_OPS_HTTP_URL|supportPortsFromEnv/);
  });

  test('IR-03 main.ts가 FRAUD_CASE 소명 보내기 작업(AppealDispatchJob)을 시작하고 종료 때 멈춘다', () => {
    const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/AppealDispatchJob/);
    expect(main).toMatch(/appealDispatch\.start\(\)/);
    expect(main).toMatch(/appealDispatch\.stop\(\)/);
  });
});

describe('F-06-5 문의 시작 조립', () => {
  const inquiryEnv = (o: { env?: string; purchase?: boolean; holidays?: boolean } = {}): Record<string, string> => {
    const env: Record<string, string> = { PEAKET_ENV: o.env ?? 'ci', PEAKET_INTERNAL_TOKEN: 'support-inquiry-http-token-00' };
    env.PEAKET_OPS_HTTP_URL = 'http://ops.internal:8080';
    env.PEAKET_REDIS_URL = 'redis://127.0.0.1:6379';
    if (o.purchase !== false) env.PEAKET_PURCHASE_HTTP_URL = 'http://purchase.internal:8080';
    if (o.holidays !== false) env.PEAKET_HOLIDAY_CALENDAR_FILE = 'holidays.json';
    return env;
  };

  test('F-06-5 staging·prod에서 관련 주문 원천 주소나 공휴일 파일이 없으면 그 이름을 말하며 던진다', async () => {
    const w = (await wiring()) as unknown as { supportPortsFromEnv(env: Record<string, string>): Record<string, unknown> };
    for (const envName of ['staging', 'prod']) {
      const all = inquiryEnv({ env: envName });
      const { PEAKET_PURCHASE_HTTP_URL: _p, ...noPurchase } = all;
      expect(() => w.supportPortsFromEnv(noPurchase), envName).toThrow(/PEAKET_PURCHASE_HTTP_URL/);
      const { PEAKET_HOLIDAY_CALENDAR_FILE: _h, ...noHolidays } = all;
      expect(() => w.supportPortsFromEnv(noHolidays), envName).toThrow(/PEAKET_HOLIDAY_CALENDAR_FILE/);
    }
  });

  test('F-06-5 local·ci·demo는 주소가 없어도 되고, 다 있으면 orders·holidays 포트가 선다', async () => {
    const w = (await wiring()) as unknown as { supportPortsFromEnv(env: Record<string, string>): Record<string, unknown> & { close(): void } };
    for (const envName of ['local', 'ci', 'demo']) {
      const none = w.supportPortsFromEnv({ PEAKET_ENV: envName });
      expect([envName, none.orders, none.holidays], envName).toEqual([envName, undefined, undefined]);
      none.close();
      const all = w.supportPortsFromEnv(inquiryEnv({ env: envName }));
      try {
        expect([envName, typeof all.orders, Array.isArray(all.holidays)], envName).toEqual([envName, 'object', true]);
      } finally {
        all.close();
      }
    }
  });

  test('F-06-5 main.ts가 문의 닫기 작업(InquiryCloseJob)을 시작하고 종료 때 멈춘다', () => {
    const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/InquiryCloseJob/);
    expect(main).toMatch(/inquiryClose\.start\(\)/);
    expect(main).toMatch(/inquiryClose\.stop\(\)/);
  });
});
