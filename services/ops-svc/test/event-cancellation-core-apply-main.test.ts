// R-T41 ③ 시작 조립(시험 담당 l3-b420-test, 2026-11-19, BUILD_ORDER GAT-110, BAT-420-rest): ops main.ts를 실제로 띄워(바깥 연결만 가짜, event-cancellation-main-wiring.test.ts와 같은 가짜)
// PEAKET_CORE_HTTP_URL 규칙이 시작 파일에 꽂혔는지 본다. 정본: docs/features/transfer-refund.md §5 'core 회차 상태 반영'(1분 [가정] 다시 하기),
// 계획 docs/review/plans/BAT-420-rest.md §4(주소가 없으면 local·ci만 경고로 시작, 그 밖은 시작 실패. 운영 환경은 다른 필수 값이 많아 조건 함수 시험이 본다).
// 자주 놓친 결함 '시작 파일 조립은 따로'. 모듈 가짜(vi.mock)는 파일 전체에 걸리므로 파일을 따로 둔다.
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  databases: [] as { url: string; applicationName?: string; tag: string }[],
  register: undefined as undefined | { database?: { tag?: string }; partnerDatabase?: { tag?: string } },
  /** 시작 차례(역할 검사·서비스 만들기·listen) */
  order: [] as string[],
  warns: [] as string[],
}));

vi.mock('@peaket/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@peaket/platform')>();
  return {
    ...actual,
    assertInternalGrpcToken: () => undefined,
    createDatabase: (o: { url: string; applicationName?: string }) => {
      const tag = `pool-${seen.databases.length + 1}`;
      seen.databases.push({ url: o.url, ...(o.applicationName !== undefined ? { applicationName: o.applicationName } : {}), tag });
      return { tag, db: {}, pool: {}, transaction: async () => undefined, close: async () => undefined };
    },
    createService: async () => {
      seen.order.push('createService');
      return {
        metrics: { registry: { registerMetric: () => undefined } },
        logger: { warn: (_o: unknown, msg: string) => void seen.warns.push(msg), error: () => undefined, info: () => undefined },
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
// 역할 검사는 가짜 풀에 SQL을 보내지 못하므로 부름만 적는다(어느 풀로 불렀는지는 풀 표지로 본다)
vi.mock('../src/adapters/db/database-role.js', () => ({
  assertOpsPartnerRole: async (database: { tag?: string }) => {
    seen.order.push(`assertOpsPartnerRole:${database?.tag ?? '?'}`);
  },
}));

const OPS_URL = 'postgres://ops_app@db.internal:5432/ops';

afterAll(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** 환경 값을 비우고 주어진 값만 넣은 뒤 main.ts를 새로 읽어 한 번 띄운다. 그동안 건 setInterval의 간격을 돌려준다 */
async function bootMain(env: Record<string, string>): Promise<number[]> {
  for (const k of Object.keys(process.env)) if (/^PEAKET_/.test(k)) vi.stubEnv(k, '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('PEAKET_IDENTITY_GRPC_URL', '127.0.0.1:1');
  seen.databases.length = 0;
  seen.order.length = 0;
  seen.warns.length = 0;
  seen.register = undefined;
  const intervals: number[] = [];
  const real = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
    intervals.push(Number(ms));
    const h = real(fn, 1_000_000_000);
    clearInterval(h);
    return h;
  }) as typeof setInterval);
  vi.resetModules();
  const sigterm = process.listeners('SIGTERM');
  try {
    await import('../src/main.js');
  } finally {
    for (const l of process.listeners('SIGTERM')) if (!sigterm.includes(l)) process.removeListener('SIGTERM', l);
  }
  return intervals;
}

const CORE_WARNING = /PEAKET_CORE_HTTP_URL이 없어 회차 취소·연기 확정이 core 회차 상태를 반영하지 않는다/;

describe('R-T41 ③ ops main.ts의 core 회차 상태 반영 조립', () => {
  test('R-T41 ③ ci·local에서 PEAKET_CORE_HTTP_URL이 없으면 시작하고 core 반영 경고가 한 번이며 1분 다시 하기 타이머를 걸지 않는다', { timeout: 120_000 }, async () => {
    for (const envName of ['ci', 'local']) {
      const intervals = await bootMain({ PEAKET_ENV: envName, PEAKET_DATABASE_URL: OPS_URL });
      expect(seen.order, envName).toContain('listen');
      expect(seen.warns.filter((w) => CORE_WARNING.test(w)), envName).toHaveLength(1);
      expect(intervals, envName).not.toContain(60_000);
    }
  });

  test('R-T41 ③ 주소가 있으면 core 반영 경고가 없고 listen 뒤 60,000ms 간격의 다시 하기 타이머를 하나 건다', { timeout: 120_000 }, async () => {
    const intervals = await bootMain({ PEAKET_ENV: 'ci', PEAKET_DATABASE_URL: OPS_URL, PEAKET_CORE_HTTP_URL: 'http://core-svc.internal:8080' });
    expect(seen.order).toContain('listen');
    expect(seen.warns.filter((w) => CORE_WARNING.test(w))).toEqual([]);
    expect(intervals.filter((ms) => ms === 60_000)).toHaveLength(1);
  });
});
