// 추가 검증 이의 포트의 시작 조립(F-06-7 GAT-280, B-T28 ⑥의 시작 조건, 계획 §4 csAppealPortsFromEnv·main.ts). 시험 담당 lane3-f067-test.
// ① csAppealPortsFromEnv(env): 주소가 있는 칸만 실제 gRPC 클라이언트를 만들고, staging·prod는 queue·trust 주소가 없으면 던진다(local·ci·demo는 칸이 빈다).
// ② main.ts를 실제로 읽어 띄우고(바깥 연결만 가짜) 그 포트가 AppModule.register의 csAppeals로 넘어가는지 본다(시험 조립과 따로, 자주 놓친 결함 'main.ts 조립').
// ③ 만든 클라이언트가 받는 쪽 gRPC 상태를 상태 이름(CsDispatchCallError.code)으로 돌려주는지 정본 설명자로 띄운 대역에 대 본다.
// 정본: docs/features/bot-defense.md §12 'CS 처리 첫 구현' '다시 보내기' 끝(주소 PEAKET_QUEUE_GRPC_URL·PEAKET_TRUST_GRPC_URL·PEAKET_IDENTITY_GRPC_URL,
// staging·prod의 ops-svc는 앞의 둘이 없으면 시작하지 않는다, local·ci·demo는 없으면 NOT_CONFIGURED로 쌓아 둔다).
// 모듈 가짜(vi.mock)는 파일 전체에 걸리므로 main.ts를 띄우는 시험은 이 파일에만 둔다(cs-calendar-main-wiring.test.ts와 같은 방법).
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { appealEnv, appealFixture, loadWiring, startAppealStubs, type AppealStubs } from './cs-appeal-support.js';

const seen = vi.hoisted(() => ({
  register: undefined as undefined | { csAppeals?: Record<string, unknown>; background?: unknown },
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

let stubs: AppealStubs;
beforeAll(async () => {
  stubs = await startAppealStubs();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await stubs.close();
});

async function wiring() {
  const w = await loadWiring();
  if (!w) throw new Error('src/cs-appeal-wiring.ts가 없다(계획 §4)');
  return w;
}

describe('B-T28 ⑥ csAppealPortsFromEnv의 시작 조건', () => {
  test('B-T28 ⑥ staging·prod에서 queue나 trust 주소가 없으면 그 변수 이름을 말하며 던진다(identity만 없으면 시작한다)', async () => {
    const w = await wiring();
    for (const env of ['staging', 'prod']) {
      const all = appealEnv(stubs, { env });
      expect(() => w.csAppealPortsFromEnv({ ...all, PEAKET_QUEUE_GRPC_URL: '' }), env).toThrow(/PEAKET_QUEUE_GRPC_URL/);
      const { PEAKET_TRUST_GRPC_URL: _t, ...noTrust } = all;
      expect(() => w.csAppealPortsFromEnv(noTrust), env).toThrow(/PEAKET_TRUST_GRPC_URL/);
      const { PEAKET_IDENTITY_GRPC_URL: _i, ...noIdentity } = all;
      const ports = w.csAppealPortsFromEnv(noIdentity);
      try {
        expect([env, Boolean(ports.appeals), Boolean(ports.labels), Boolean(ports.evidence), ports.holds]).toEqual([env, true, true, true, undefined]);
      } finally {
        ports.close();
      }
    }
  });

  test('B-T28 ⑥ local·ci·demo는 주소가 없어도 던지지 않고 그 칸이 비며, 주소가 다 있으면 네 칸이 다 선다', async () => {
    const w = await wiring();
    for (const env of ['local', 'ci', 'demo']) {
      const none = w.csAppealPortsFromEnv({ PEAKET_ENV: env });
      expect([env, none.appeals, none.labels, none.evidence, none.holds]).toEqual([env, undefined, undefined, undefined, undefined]);
      none.close();
      const all = w.csAppealPortsFromEnv(appealEnv(stubs, { env }));
      try {
        expect([env, typeof all.appeals?.get, typeof all.appeals?.resolve, typeof all.labels?.apply, typeof all.evidence?.get, typeof all.holds?.set]).toEqual([env, 'function', 'function', 'function', 'function', 'function']);
      } finally {
        all.close();
      }
    }
  });
});

describe('B-T28 ⑥ 포트가 gRPC 상태를 이름으로 돌려준다', () => {
  test('B-T28 ⑥ 받는 쪽의 UNAVAILABLE·NOT_FOUND·INVALID_ARGUMENT를 code에 상태 이름으로 싣는다(다시 보낼지 가르는 값)', async () => {
    const w = await wiring();
    const ports = w.csAppealPortsFromEnv(appealEnv(stubs));
    const fx = appealFixture();
    try {
      for (const [name, code] of [
        ['UNAVAILABLE', grpc.status.UNAVAILABLE],
        ['NOT_FOUND', grpc.status.NOT_FOUND],
        ['INVALID_ARGUMENT', grpc.status.INVALID_ARGUMENT],
      ] as const) {
        stubs.queue.fail(code);
        stubs.trust.fail(code);
        stubs.identity.fail(code);
        const calls = [
          ports.appeals!.get(fx.appealId),
          ports.appeals!.resolve({ appealId: fx.appealId, caseId: crypto.randomUUID(), caseVersion: 2, outcome: 'ACCEPTED' }),
          ports.labels!.apply({ caseId: crypto.randomUUID(), version: 2, eventId: fx.eventId, pid: fx.pid, actedBy: crypto.randomUUID() }),
          ports.evidence!.get({ eventId: fx.eventId, pid: fx.pid }),
          ports.holds!.set({ accountId: fx.accountId, caseId: crypto.randomUUID(), state: 'OPEN', version: 1 }),
        ];
        for (const [i, p] of calls.entries()) await expect(p, `${name} #${i}`).rejects.toMatchObject({ code: name });
      }
    } finally {
      stubs.queue.restore();
      stubs.trust.restore();
      stubs.identity.restore();
      ports.close();
    }
  });

  test('B-T28 ⑥ 답의 모양을 포트 값으로 옮긴다(ResolveAppealResult·changed·block_list·found)', async () => {
    const w = await wiring();
    const ports = w.csAppealPortsFromEnv(appealEnv(stubs));
    const fx = appealFixture();
    stubs.appeals.set(fx.appealId, fx);
    try {
      expect(await ports.appeals!.get(fx.appealId)).toMatchObject({ appealId: fx.appealId, eventId: fx.eventId, accountId: fx.accountId, pid: fx.pid, text: fx.text, receivedAtMs: Date.parse(fx.receivedAtIso), entryState: 'VERIFYING' });
      stubs.queue.set('ResolveVerificationAppeal', { value: { result: 'RESOLVE_APPEAL_RESULT_NOT_ISOLATED' } });
      expect(await ports.appeals!.resolve({ appealId: fx.appealId, caseId: crypto.randomUUID(), caseVersion: 3, outcome: 'REJECTED' })).toBe('NOT_ISOLATED');
      stubs.trust.set('ApplyLabel', { value: { changed: false, block_list: 'BLOCK_LIST_CHANGE_DEVICE_NOT_FOUND' } });
      expect(await ports.labels!.apply({ caseId: crypto.randomUUID(), version: 3, eventId: fx.eventId, pid: fx.pid, actedBy: crypto.randomUUID() })).toEqual({ changed: false, blockList: 'DEVICE_NOT_FOUND' });
      stubs.trust.set('GetVerdictEvidence', { value: { found: false } });
      expect(await ports.evidence!.get({ eventId: fx.eventId, pid: fx.pid })).toEqual({ found: false });
      stubs.identity.set('SetAccountHold', { value: { changed: false } });
      expect(await ports.holds!.set({ accountId: fx.accountId, caseId: crypto.randomUUID(), state: 'CLOSED', version: 4 })).toEqual({ changed: false });
    } finally {
      stubs.queue.restore();
      stubs.trust.restore();
      stubs.identity.restore();
      ports.close();
    }
  });
});

async function bootMain(env: Record<string, string>): Promise<void> {
  for (const k of Object.keys(process.env)) if (/^PEAKET_/.test(k)) vi.stubEnv(k, '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('PEAKET_DATABASE_URL', 'postgres://ops_app@db.internal:5432/ops');
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

// main.ts를 처음 읽을 때 모듈 그래프 변환이 크게 든다(cs-calendar-main-wiring.test.ts와 같은 까닭으로 이 파일의 이 시험만 60초)
const BOOT_TEST_TIMEOUT_MS = 60_000;

describe('B-T28 ⑥ main.ts 조립', () => {
  test('B-T28 ⑥ ci에서 세 주소를 주면 main.ts가 네 포트를 AppModule.register의 csAppeals로 넘기고 배경 작업을 끄지 않는다', { timeout: BOOT_TEST_TIMEOUT_MS }, async () => {
    await bootMain(appealEnv(stubs, { env: 'ci' }));
    expect(seen.order).toEqual(['createService', 'listen']);
    const a = seen.register?.csAppeals as Record<string, Record<string, unknown> | undefined> | undefined;
    expect([typeof a?.appeals?.get, typeof a?.appeals?.resolve, typeof a?.labels?.apply, typeof a?.evidence?.get, typeof a?.holds?.set]).toEqual(['function', 'function', 'function', 'function', 'function']);
    expect(seen.register?.background).not.toBe(false);
  });

  test('B-T28 ⑥ ci에서 queue·trust 주소가 없으면 시작은 하고 그 칸이 빈다(NOT_CONFIGURED로 쌓는다). identity 주소는 main.ts가 늘 요구한다', { timeout: BOOT_TEST_TIMEOUT_MS }, async () => {
    await bootMain({ PEAKET_ENV: 'ci', PEAKET_IDENTITY_GRPC_URL: stubs.addresses.identity });
    expect(seen.order).toEqual(['createService', 'listen']);
    const a = (seen.register?.csAppeals ?? {}) as Record<string, Record<string, unknown> | undefined>;
    expect([a.appeals, a.labels, a.evidence, typeof a.holds?.set]).toEqual([undefined, undefined, undefined, 'function']);
  });
});
