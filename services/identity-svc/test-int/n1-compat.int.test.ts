// identity-svc N-1 앱(713b522a) 호환 통합 시험(F-09-2 D-T8, docs/devops.md §7.1 원칙 2·§7.3 적용 시험 ③).
//
// 차례: ① 0000~0037(N-1) 스키마에서 713b522a 앱의 SQL 모양이 먼저 돈다(계약이 옛 스키마의 것임을 증명)
//        ② 0000~0038(N) 스키마에서 같은 계약이 다시 돈다(N 스키마가 N-1을 깨지 않는다)
//        ③ N 앱이 N-1이 쓴 세션·관리 계정·키 회전 행을 읽는다(카나리 동안 새 앱이 옛 데이터를 읽음)
//        ④ N-1 앱이 N 앱이 쓴 세션·관리 계정·키 회전 행을 읽는다(되돌리기 동안 옛 앱이 새 데이터를 읽음)
//
// 실제 713b522a 앱 프로세스를 띄우는 시험은 아니다. 계획 `docs/review/plans/F-09-2-n1.md` §3·§9에 그 경계를 적었다.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabase, systemClock, type Database } from '@peaket/platform';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { readN1Files } from './n1/baseline.js';
import {
  readN1Account,
  readN1Admin,
  readN1Claims,
  readN1Refresh,
  readN1Session,
  runN1Contract,
  terminateN1Session,
  type N1ContractResult,
  type N1Queryable,
} from './n1/contract.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const NOW = Date.UTC(2026, 10, 27, 1, 0, 0);

let container: PostgresContainer;
let root: pg.Client;
let n1Setup: Promise<N1ContractResult> | undefined;
let nSetup: Promise<{ result: N1ContractResult; database: Database }> | undefined;

const urlOf = (database: string): string => container.url.replace(/\/peaket$/, `/${database}`);
const clientFor = async (url: string): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: url, application_name: 'identity-n1-compat-test' });
  await client.connect();
  return client;
};
const queryable = (client: pg.Client): N1Queryable => ({ query: (sql, params) => client.query(sql, params) });

/** N-1 기준(0000~0037)은 713b522a 파일을 그대로 실행한다. N 실행기의 기록 표 없이 표 모양만 만든다. */
async function applyN1Schema(url: string): Promise<void> {
  const client = await clientFor(url);
  try {
    for (const file of await readN1Files(MIGRATIONS)) await client.query(file.sql);
  } finally {
    await client.end();
  }
}

const getN1 = (): Promise<N1ContractResult> =>
  (n1Setup ??= (async () => {
    const client = await clientFor(urlOf('identity_n1'));
    try {
      return await runN1Contract(queryable(client), NOW);
    } finally {
      await client.end();
    }
  })());

const getN = (): Promise<{ result: N1ContractResult; database: Database }> =>
  (nSetup ??= (async () => {
    const url = urlOf('identity_n');
    await migrateIdentity(url);
    const database = createDatabase({ url, applicationName: 'identity-n1-compat-test', max: 8 });
    const client = await clientFor(url);
    try {
      return { result: await runN1Contract(queryable(client), NOW), database };
    } finally {
      await client.end();
    }
  })());

function expectContract(result: N1ContractResult): void {
  expect(result.providerRowsBefore, '처음 로그인은 계정을 못 찾는다').toBe(0);
  expect(result.providerRowsAfter, '만든 계정을 제공자(sub)로 다시 찾는다').toBe(1);
  expect(result.currentRefreshRows, '지금 리프레시 해시로 세션을 찾는다').toBe(1);
  expect(result.previousRefreshRows, '바로 앞 해시로도 세션을 찾는다').toBe(1);
  expect(result.historyRefreshRows, '지난 해시 기록으로 세션을 찾는다').toBe(1);
  expect(result.adminByEmailRows, '관리 계정을 이메일로 찾는다').toBe(1);
  expect(result.loginStepRows, '관리 로그인 1단계 행을 토큰 해시로 찾는다').toBe(1);
  expect(result.openRotationRows, '진행 중인 pid 키 회전을 찾는다').toBe(1);
  expect(result.claims).toEqual({ pid: result.fixture.newPid.toString('base64url'), pidPrev: null });
  expect(result.contact).toEqual({ ref: result.fixture.contactRef, refPrev: result.fixture.contactRefPrev });
  expect(result.pidVersions).toEqual([2]);
}

beforeAll(async () => {
  container = await startPostgres();
  root = await clientFor(container.url);
  await root.query('CREATE DATABASE identity_n1');
  await root.query('CREATE DATABASE identity_n');
  await applyN1Schema(urlOf('identity_n1'));
});

afterAll(async () => {
  await nSetup?.then(({ database }) => database.close()).catch(() => undefined);
  await root?.end();
  container?.stop();
});

describe('D-T8 identity N-1 앱(713b522a) 호환', () => {
  test('D-T8 identity N-1 계약이 713b522a 스키마에서 로그인·세션·관리 계정·키 회전을 마친다', async () => {
    const result = await getN1();
    expectContract(result);
    const client = await clientFor(urlOf('identity_n1'));
    try {
      const db = queryable(client);
      const account = await readN1Account(db, result.fixture.accountId);
      expect(String(account?.id)).toBe(result.fixture.accountId);
      expect(String(account?.email)).toBe('n1-fan@peaket.test');
      const refresh = await readN1Refresh(db, result.fixture.currentRefreshHash);
      expect(String(refresh?.id)).toBe(result.fixture.sessionId);
      expect(refresh?.refresh_used).toBe(false);

      await terminateN1Session(db, result.fixture.sessionId, NOW + 5_000);
      const ended = await readN1Session(db, result.fixture.sessionId);
      expect(String(ended?.terminated_reason)).toBe('LOGOUT');
      expect(ended?.terminated_at).toBeInstanceOf(Date);
    } finally {
      await client.end();
    }
  });

  test('D-T8 identity N 스키마에서 N-1 계약이 그대로 돈다', async () => {
    const { result } = await getN();
    expectContract(result);
  });

  test('D-T8 identity N 앱이 N-1 앱이 쓴 세션·관리 계정·키 회전 행을 읽는다', async () => {
    const { result, database } = await getN();
    const sessions = new DrizzleSessionStore(database, systemClock);
    const session = await sessions.sessionOf(result.fixture.sessionId);
    expect(session).toMatchObject({
      id: result.fixture.sessionId,
      accountId: result.fixture.accountId,
      deviceId: result.fixture.deviceId,
      refreshFamily: result.fixture.refreshFamily,
      loginVerdict: 'ALLOW',
      terminatedAt: null,
    });
    expect(await sessions.refreshOwner(result.fixture.currentRefreshHash)).toBe(result.fixture.accountId);
    expect(await sessions.refreshOwner(result.fixture.firstRefreshHash)).toBe(result.fixture.accountId);
    const live = await sessions.liveSessionsOf(result.fixture.accountId, NOW + 10_000);
    expect(live.filter((row) => row.sessionId === result.fixture.sessionId)).toEqual([
      {
        sessionId: result.fixture.sessionId,
        deviceId: result.fixture.deviceId,
        deviceLabel: '브라우저 · Windows',
        lastActiveAt: NOW + 2_000,
      },
    ]);
    const refs = await sessions.investigationRefsOf([result.fixture.accountId], 0);
    expect(refs).toEqual([
      {
        accountId: result.fixture.accountId,
        contactRefs: [
          { kind: 'EMAIL', ref: result.fixture.contactRef },
          { kind: 'EMAIL', ref: result.fixture.contactRefPrev },
        ],
        deviceRefs: ['k1.device-n1'],
        identityConflicts: [],
      },
    ]);

    const admins = new DrizzleAdminAccountStore(database, systemClock);
    expect(await admins.get(result.fixture.adminAccountId)).toMatchObject({
      id: result.fixture.adminAccountId,
      role: 'operator',
      status: 'INVITED',
      email: result.fixture.adminEmail,
      displayName: 'N-1 관리자',
    });
    expect(await admins.findForLogin(result.fixture.adminEmail)).toMatchObject({
      id: result.fixture.adminAccountId,
      role: 'operator',
      status: 'INVITED',
    });

    const verifications = new DrizzleVerificationStore(database);
    expect(await verifications.claimsOf(result.fixture.verifiedAccountId)).toEqual({
      pid: result.fixture.newPid.toString('base64url'),
    });
    expect(await verifications.pidKeyVersionsInUse()).toContain(2);
  });

  test('D-T8 identity N-1 앱이 N 앱이 쓴 세션·관리 계정·키 회전 행을 읽는다', async () => {
    const { result, database } = await getN();
    const client = await clientFor(urlOf('identity_n'));
    try {
      const db = queryable(client);
      const sessions = new DrizzleSessionStore(database, systemClock);
      const nSessionId = randomUUID();
      const nRefreshHash = randomBytes(32);
      const nFamily = randomUUID();
      await sessions.transaction(async (tx) => {
        await tx.insertSession({
          id: nSessionId,
          accountId: result.fixture.accountId,
          deviceId: null,
          refreshHash: nRefreshHash,
          refreshFamily: nFamily,
          absoluteExpiresAt: NOW + 86_400_000,
          idleExpiresAt: NOW + 3_600_000,
          loginVerdict: 'UNKNOWN',
          createdAt: NOW + 20_000,
          deviceLabel: 'N 앱',
        });
        await tx.recordRefreshHash({
          hash: nRefreshHash,
          sessionId: nSessionId,
          refreshFamily: nFamily,
          issuedAt: NOW + 20_000,
          expiresAt: NOW + 86_400_000,
        });
      });
      const oldSession = await readN1Session(db, nSessionId);
      expect(String(oldSession?.id)).toBe(nSessionId);
      expect(String(oldSession?.login_verdict)).toBe('UNKNOWN');
      expect(String(oldSession?.device_label)).toBe('N 앱');
      expect((await readN1Refresh(db, nRefreshHash))?.id).toBe(nSessionId);

      const admins = new DrizzleAdminAccountStore(database, systemClock);
      const nAdminId = randomUUID();
      const nAdminEmail = `n-app-${randomUUID()}@peaket.test`;
      await admins.create({ id: nAdminId, role: 'viewer', email: nAdminEmail, status: 'ACTIVE', now: NOW + 30_000 });
      const oldAdmin = await readN1Admin(db, nAdminId);
      expect(String(oldAdmin?.id)).toBe(nAdminId);
      expect(String(oldAdmin?.email)).toBe(nAdminEmail);
      expect(String(oldAdmin?.role)).toBe('viewer');

      const verifications = new DrizzleVerificationStore(database);
      const nVerifiedAccountId = randomUUID();
      const nPid = randomBytes(32);
      // N 앱도 본인확인은 이미 있는 계정에만 쓴다(identity_verification.account_id -> account.id 외래 키).
      await sessions.transaction((tx) => tx.createAccount({ id: nVerifiedAccountId, email: null, emailVerified: false }, NOW + 40_000));
      await verifications.transaction((tx) =>
        tx.saveVerification({
          accountId: nVerifiedAccountId,
          ciHmac: randomBytes(32),
          ciHmacKeyVersion: 1,
          pid: nPid,
          pidKeyVersion: 1,
          verifiedAt: NOW + 40_000,
          sourceRecord: 'n-app',
        }),
      );
      expect(await readN1Claims(db, nVerifiedAccountId)).toEqual({ pid: nPid.toString('base64url'), pidPrev: null });
    } finally {
      await client.end();
    }
  });
});

