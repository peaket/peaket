// BAT-420 검증 2에서 살아남은 M-S2b-main(시험 담당 l3w8-420-surv-test, 2026-11-17): ops main.ts를 실제로 띄워(바깥 연결만 가짜로 바꿈)
// 파트너 회차 취소 경로의 DB 풀이 PEAKET_PARTNER_DATABASE_URL로 따로 만들어져 AppModule.register에 partnerDatabase로 넘어가는지 본다.
// 정본: docs/security/authz-matrix.md §5.3 'ops-svc 구현'(파트너 경로는 PEAKET_PARTNER_DATABASE_URL의 풀로만 접속, 행 보안 2차 방어).
// 모듈 가짜(vi.mock)는 파일 전체에 걸리므로 다른 시험과 섞지 않으려고 파일을 따로 둔다.
import { afterAll, describe, expect, test, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  databases: [] as { url: string; applicationName?: string; tag: string }[],
  register: undefined as undefined | { database?: { tag?: string }; partnerDatabase?: { tag?: string } },
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
    createService: async () => ({
      metrics: { registry: { registerMetric: () => undefined } },
      logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
      listen: async () => undefined,
      close: async () => undefined,
    }),
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

const OPS_URL = 'postgres://ops_app@db.internal:5432/ops';
const PARTNER_URL = 'postgres://ops_partner@db.internal:5432/ops';

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('ops main.ts의 파트너 DB 풀 조립 [BAT-420 검증 2 M-S2b-main]', () => {
  test('GAT-110 S2 [ASVS v5.0.0-8.4.1] main.ts는 PEAKET_PARTNER_DATABASE_URL이 관제 주소와 다르면 그 주소로 따로 풀을 만들어 AppModule.register에 partnerDatabase로 넘기고 관제 풀과 같은 것을 넘기지 않는다', async () => {
    for (const k of Object.keys(process.env)) if (/^PEAKET_/.test(k)) vi.stubEnv(k, '');
    vi.stubEnv('PEAKET_ENV', 'ci');
    vi.stubEnv('PEAKET_DATABASE_URL', OPS_URL);
    vi.stubEnv('PEAKET_PARTNER_DATABASE_URL', PARTNER_URL);
    vi.stubEnv('PEAKET_IDENTITY_GRPC_URL', '127.0.0.1:1');
    const sigterm = process.listeners('SIGTERM');
    try {
      await import('../src/main.js');
    } finally {
      // main.ts가 건 SIGTERM 처리기는 시험 프로세스에 남기지 않는다
      for (const l of process.listeners('SIGTERM')) if (!sigterm.includes(l)) process.removeListener('SIGTERM', l);
    }
    const opsPool = seen.databases.find((d) => d.url === OPS_URL);
    const partnerPool = seen.databases.find((d) => d.url === PARTNER_URL);
    expect(opsPool, '관제 풀').toBeDefined();
    expect(partnerPool, '파트너 주소로 만든 풀').toBeDefined();
    expect(partnerPool!.tag).not.toBe(opsPool!.tag);
    expect(seen.register?.database?.tag).toBe(opsPool!.tag);
    expect(seen.register?.partnerDatabase?.tag).toBe(partnerPool!.tag);
  });
});
