// F-06-5 ops-svc 팬 조회 시작 조립 시험(시험 담당 lane2-freeze-F-06-5-opencode).
// fanLookupPortsFromEnv(env): staging·prod는 원천 주소 넷이 없으면 그 이름을 말하며 던지고, local·ci·demo는 빈 칸이다.
// main.ts가 그 포트를 AppModule.register의 fanLookup으로 넘기는지 소스로 확인한다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

interface Wiring {
  fanLookupPortsFromEnv(env: Record<string, string>): {
    profile?: unknown;
    orders?: unknown;
    tickets?: unknown;
    transfers?: unknown;
    queueEntries?: unknown;
    access?: unknown;
    close(): void;
  };
}
async function wiring(): Promise<Wiring> {
  const spec = '../src/fan-lookup-wiring.js';
  try {
    return (await import(/* @vite-ignore */ spec)) as Wiring;
  } catch (err) {
    if (err instanceof Error && /Cannot find module|Failed to load url|ERR_MODULE_NOT_FOUND|Does the file exist/i.test(err.message)) throw new Error('src/fan-lookup-wiring.ts가 없다(계획 §3)');
    throw err;
  }
}

const envOf = (o: { env?: string; identity?: boolean; purchase?: boolean; ticket?: boolean; queue?: boolean } = {}): Record<string, string> => {
  const env: Record<string, string> = { PEAKET_ENV: o.env ?? 'ci', PEAKET_INTERNAL_TOKEN: 'fan-lookup-internal-token-00' };
  if (o.identity !== false) env.PEAKET_IDENTITY_HTTP_URL = 'http://identity.internal:8080';
  if (o.purchase !== false) env.PEAKET_PURCHASE_HTTP_URL = 'http://purchase.internal:8080';
  if (o.ticket !== false) env.PEAKET_TICKET_HTTP_URL = 'http://ticket.internal:8080';
  if (o.queue !== false) env.PEAKET_QUEUE_HTTP_URL = 'http://queue.internal:8080';
  return env;
};

describe('F-06-5 fanLookupPortsFromEnv', () => {
  test('staging·prod에서 원천 주소 넷 가운데 하나라도 없으면 그 이름을 말하며 던진다', async () => {
    const w = await wiring();
    const names = ['PEAKET_IDENTITY_HTTP_URL', 'PEAKET_PURCHASE_HTTP_URL', 'PEAKET_TICKET_HTTP_URL', 'PEAKET_QUEUE_HTTP_URL'] as const;
    for (const envName of ['staging', 'prod']) {
      for (const name of names) {
        const all = envOf({ env: envName });
        const { [name]: _drop, ...rest } = all;
        expect(() => w.fanLookupPortsFromEnv(rest), `${envName} ${name}`).toThrow(new RegExp(name));
      }
    }
  });

  test('local·ci·demo는 주소가 없어도 던지지 않고 칸이 비며, 다 있으면 원천 다섯과 접속기록 포트가 선다', async () => {
    const w = await wiring();
    for (const envName of ['local', 'ci', 'demo']) {
      const none = w.fanLookupPortsFromEnv({ PEAKET_ENV: envName });
      expect([envName, none.profile, none.orders, none.tickets, none.transfers, none.queueEntries, none.access]).toEqual([envName, undefined, undefined, undefined, undefined, undefined, undefined]);
      none.close();
      const all = w.fanLookupPortsFromEnv(envOf({ env: envName }));
      try {
        for (const k of ['profile', 'orders', 'tickets', 'transfers', 'queueEntries', 'access'] as const) expect(all[k], k).toBeTruthy();
      } finally {
        all.close();
      }
    }
  });
});

describe('F-06-5 main.ts 조립', () => {
  test('main.ts가 fanLookupPortsFromEnv를 읽어 fanLookup으로 넘긴다', () => {
    const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/fanLookupPortsFromEnv\s*\(/);
    expect(main).toMatch(/fanLookup:/);
  });
});
