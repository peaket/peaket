// BAT-420 검증 2에서 살아남은 M-S2b-main(시험 담당 l3w8-420-surv-test, 2026-11-17): ops main.ts를 실제로 띄워(바깥 연결만 가짜로 바꿈)
// 파트너 회차 취소 경로의 DB 풀이 PEAKET_PARTNER_DATABASE_URL로 따로 만들어져 AppModule.register에 partnerDatabase로 넘어가는지 본다.
// 정본: docs/security/authz-matrix.md §5.3 'ops-svc 구현'(파트너 경로는 PEAKET_PARTNER_DATABASE_URL의 풀로만 접속, 행 보안 2차 방어).
// W9-fix3 F1(시험 담당 w9f3-test, 2026-11-17): 같은 절 끝 '시작 검사'. 파트너 DB 주소가 있으면(환경·관제 주소와 같은지와 상관없이) main.ts가
// 서비스를 만들기 전에 assertOpsPartnerRole(파트너 풀)을 부르고, 없으면 부르지 않는다. 역할 검사 자체(실제 역할)는 test-int/event-cancellation-rls.int.test.ts가 본다.
// 모듈 가짜(vi.mock)는 파일 전체에 걸리므로 다른 시험과 섞지 않으려고 파일을 따로 둔다.
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { partnerRoleCheckRequired } from '../src/event-cancellation-wiring.js';

const seen = vi.hoisted(() => ({
  databases: [] as { url: string; applicationName?: string; tag: string }[],
  register: undefined as undefined | { database?: { tag?: string }; partnerDatabase?: { tag?: string } },
  /** 시작 차례(역할 검사·서비스 만들기·listen) */
  order: [] as string[],
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
        // main.ts가 시작 조립 뒤 ApprovalLifecycle을 configure하므로 가짜 앱에도 get을 둔다
        app: { get: () => ({ configure: () => undefined }) },
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
// 역할 검사는 가짜 풀에 SQL을 보내지 못하므로 부름만 적는다(어느 풀로 불렀는지는 풀 표지로 본다)
vi.mock('../src/adapters/db/database-role.js', () => ({
  assertOpsPartnerRole: async (database: { tag?: string }) => {
    seen.order.push(`assertOpsPartnerRole:${database?.tag ?? '?'}`);
  },
}));

const OPS_URL = 'postgres://ops_app@db.internal:5432/ops';
const PARTNER_URL = 'postgres://ops_partner@db.internal:5432/ops';

afterAll(() => {
  vi.unstubAllEnvs();
});

/** 환경 값을 비우고 주어진 값만 넣은 뒤 main.ts를 새로 읽어 한 번 띄운다 */
async function bootMain(env: Record<string, string>): Promise<void> {
  for (const k of Object.keys(process.env)) if (/^PEAKET_/.test(k)) vi.stubEnv(k, '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('PEAKET_IDENTITY_GRPC_URL', '127.0.0.1:1');
  seen.databases.length = 0;
  seen.order.length = 0;
  seen.register = undefined;
  vi.resetModules();
  const sigterm = process.listeners('SIGTERM');
  try {
    await import('../src/main.js');
  } finally {
    // main.ts가 건 SIGTERM 처리기는 시험 프로세스에 남기지 않는다
    for (const l of process.listeners('SIGTERM')) if (!sigterm.includes(l)) process.removeListener('SIGTERM', l);
  }
}

beforeEach(() => {
  seen.order.length = 0;
});

describe('ops main.ts의 파트너 DB 풀 조립 [BAT-420 검증 2 M-S2b-main]', () => {
  test('GAT-110 S2 [ASVS v5.0.0-8.4.1] main.ts는 PEAKET_PARTNER_DATABASE_URL이 관제 주소와 다르면 그 주소로 따로 풀을 만들어 AppModule.register에 partnerDatabase로 넘기고 관제 풀과 같은 것을 넘기지 않는다', async () => {
    await bootMain({ PEAKET_ENV: 'ci', PEAKET_DATABASE_URL: OPS_URL, PEAKET_PARTNER_DATABASE_URL: PARTNER_URL });
    const opsPool = seen.databases.find((d) => d.url === OPS_URL);
    const partnerPool = seen.databases.find((d) => d.url === PARTNER_URL);
    expect(opsPool, '관제 풀').toBeDefined();
    expect(partnerPool, '파트너 주소로 만든 풀').toBeDefined();
    expect(partnerPool!.tag).not.toBe(opsPool!.tag);
    expect(seen.register?.database?.tag).toBe(opsPool!.tag);
    expect(seen.register?.partnerDatabase?.tag).toBe(partnerPool!.tag);
  });
});

describe('ops 파트너 풀의 DB 역할 시작 검사 [W9-fix3 F1]', () => {
  test('W9F3 F1 파트너 DB 주소가 있으면 환경과 같은 주소 여부와 상관없이 역할 검사를 부른다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-13.2.2]', async () => {
    // 조건 함수: 주소가 있으면 환경과 상관없이 true, 없거나 비면 false
    for (const envName of ['production', 'prod', 'staging', 'ci', 'local']) {
      expect(partnerRoleCheckRequired({ PEAKET_ENV: envName, PEAKET_PARTNER_DATABASE_URL: PARTNER_URL }), `${envName}·주소 있음`).toBe(true);
      expect(partnerRoleCheckRequired({ PEAKET_ENV: envName, PEAKET_PARTNER_DATABASE_URL: OPS_URL }), `${envName}·관제와 같은 주소`).toBe(true);
      expect(partnerRoleCheckRequired({ PEAKET_ENV: envName }), `${envName}·주소 없음`).toBe(false);
      expect(partnerRoleCheckRequired({ PEAKET_ENV: envName, PEAKET_PARTNER_DATABASE_URL: '' }), `${envName}·빈 값`).toBe(false);
    }
    expect(partnerRoleCheckRequired({ PEAKET_PARTNER_DATABASE_URL: PARTNER_URL }), 'PEAKET_ENV 없음·주소 있음').toBe(true);

    // main.ts 조립: 다른 주소(ci) → 파트너 풀로 부르고, 서비스를 만들기 전이다
    await bootMain({ PEAKET_ENV: 'ci', PEAKET_DATABASE_URL: OPS_URL, PEAKET_PARTNER_DATABASE_URL: PARTNER_URL });
    const partnerPool = seen.databases.find((d) => d.url === PARTNER_URL)!;
    expect(seen.order, '다른 주소(ci)').toEqual([`assertOpsPartnerRole:${partnerPool.tag}`, 'createService', 'listen']);

    // 관제 주소와 글자까지 같은 주소(같은 풀을 함께 씀)여도 건너뛰지 않는다
    await bootMain({ PEAKET_ENV: 'ci', PEAKET_DATABASE_URL: OPS_URL, PEAKET_PARTNER_DATABASE_URL: OPS_URL });
    const shared = seen.register?.partnerDatabase?.tag;
    expect(shared, '같은 주소의 파트너 풀').toBeDefined();
    expect(seen.order, '같은 주소(ci)').toEqual([`assertOpsPartnerRole:${shared}`, 'createService', 'listen']);

    // local도 같다(운영은 감사 서명 키 등 다른 필수 값이 많아 main.ts를 띄우지 않고 위 조건 함수로 본다)
    await bootMain({ PEAKET_ENV: 'local', PEAKET_DATABASE_URL: OPS_URL, PEAKET_PARTNER_DATABASE_URL: PARTNER_URL });
    const localPartner = seen.databases.find((d) => d.url === PARTNER_URL)!;
    expect(seen.order, '다른 주소(local)').toEqual([`assertOpsPartnerRole:${localPartner.tag}`, 'createService', 'listen']);

    // 주소가 없어 local·ci가 관제 풀을 함께 쓰면 부르지 않는다(경고만)
    for (const envName of ['ci', 'local']) {
      await bootMain({ PEAKET_ENV: envName, PEAKET_DATABASE_URL: OPS_URL });
      expect(seen.order, `${envName}·주소 없음`).toEqual(['createService', 'listen']);
    }
  });
});
