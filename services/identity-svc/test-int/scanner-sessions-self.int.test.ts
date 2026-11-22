// 내 스캐너 세션 조회·끝내기의 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §6.1 '휴대폰 화면 실제 연결' ④⑤, §12 I-T89 ①~⑥,
// ADR-0362 결정 6, BUILD_ORDER F-05-7 시험 담당). 마이그레이션 0038(scanner_session.device_name)과 목록·끝내기의 실제 SQL,
// 같은 트랜잭션의 reauth_token_use·terminated_at·Outbox(control.sessions-terminated, 사유 LOGOUT)를 본다. 메모리 쪽은 test/scanner-sessions-self.test.ts.
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { DrizzleStaffAssignmentStore } from '../src/modules/session/adapters/db/drizzle-staff-assignment-store.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { CheckScannerSession } from '../src/modules/session/application/check-scanner-session.js';
import { EndScannerSession } from '../src/modules/session/application/end-scanner-session.js';
import { ListScannerSessions } from '../src/modules/session/application/list-scanner-sessions.js';
import type { ReauthOperation } from '../src/modules/session/domain/session.js';
import { ISSUER, kit, newKey } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-23T05:00:00.000Z') });

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-scanner-sessions-self-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
let seq = 0;
const uuid = (n: number) => `0190f3a1-7c2e-7a00-8000-${n.toString(16).padStart(12, '0')}`;

async function setup() {
  const sessions = new DrizzleSessionStore(database, clock);
  const staff = new DrizzleStaffAssignmentStore(database, clock);
  const k = await kit(sessions, { clock });
  const reauth = new JoseReauthVerifier(k.keys, ISSUER, clock);
  const login = (sub: string, deviceId = 'dev-phone') => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: sub, email: null, deviceId });
  const token = async (s: { accountId: string; sessionId: string }, operation: ReauthOperation) =>
    (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', operation }, clock.now())).token;
  /** 그 계정의 ASSIGNED 배정 하나와(SQL) 스캐너 세션 하나(저장소 포트 createScannerSession = 기기 승인이 쓰는 길) */
  const seed = async (s: { accountId: string; sessionId: string }, o: { deviceName?: string | null; expiresInMs?: number; role?: 'gate_staff' | 'gate_lead' } = {}) => {
    const n = ++seq;
    const assignmentId = uuid(0x91000 + n);
    const eventId = uuid(0xe1000 + n);
    const scannerSessionId = uuid(0x51000 + n);
    const deviceId = uuid(0xd1000 + n);
    const now = clock.now();
    await database.pool.query(
      `insert into staff_assignment (id, account_id, event_id, role, invited_by, valid_from, valid_until, status, promoter_id)
       values ($1, $2, $3, $4, $5, $6, $7, 'ASSIGNED', $8)`,
      [assignmentId, s.accountId, eventId, o.role ?? 'gate_lead', uuid(0xa1000 + n), new Date(now - HOUR), new Date(now + 6 * HOUR), uuid(0xb1000 + n)],
    );
    await staff.createScannerSession({
      scannerSessionId,
      assignmentId,
      deviceId,
      accountId: s.accountId,
      approvedBySession: s.sessionId,
      role: o.role ?? 'gate_lead',
      proxy: false,
      approvedAtMs: now,
      expiresAtMs: now + (o.expiresInMs ?? 6 * HOUR),
      ...(o.deviceName === undefined ? {} : { deviceName: o.deviceName }),
    });
    return { assignmentId, eventId, scannerSessionId, deviceId, approvedAtMs: now, expiresAtMs: now + (o.expiresInMs ?? 6 * HOUR) };
  };
  return {
    staff,
    login,
    token,
    seed,
    list: new ListScannerSessions(sessions, staff, clock),
    end: new EndScannerSession(sessions, staff, reauth, clock, k.signals),
    check: new CheckScannerSession(staff, clock),
  };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AccountError) return e.code;
    throw e;
  }
};
const terminatedAt = async (id: string) => (await q<{ t: Date | null }>('select terminated_at as t from scanner_session where id = $1', [id]))[0]?.t;
/** 그 계정의 세션 종료 사건 [sessionId, reason, terminatedAt](적힌 차례) */
const events = async (accountId: string) =>
  (await q<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1 order by seq", [accountId])).map((r) => {
    const v = JSON.parse(r.payload.toString()) as { accountId: string; sessionId: string; reason: string; terminatedAt: string };
    return v;
  });

describe('I-T89 PostgreSQL', () => {
  test('I-T89 ⑥ 마이그레이션 0038은 scanner_session.device_name(text, 비어도 됨)을 더하고 다시 적용해도 같다', async () => {
    await migrateIdentity(pg.url);
    expect(await q("select data_type, is_nullable from information_schema.columns where table_name = 'scanner_session' and column_name = 'device_name'")).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
  });

  test('I-T89 ①⑥ 목록 한 줄은 저장한 값과 같고 device_name은 승인 때 넘긴 이름이며 내 배정의 activeScannerDeviceName이 같다', async () => {
    const t = await setup();
    const s = await t.login('pg-sc-1');
    expect(await t.list.run(s)).toEqual([]);
    const seeded = await t.seed(s, { deviceName: '서문-14', role: 'gate_staff' });
    expect((await q('select device_name from scanner_session where id = $1', [seeded.scannerSessionId]))[0]).toEqual({ device_name: '서문-14' });
    expect(await t.list.run(s)).toEqual([
      {
        sessionId: seeded.scannerSessionId,
        deviceName: '서문-14',
        eventId: seeded.eventId,
        role: 'gate_staff',
        proxy: false,
        approvedAt: new Date(seeded.approvedAtMs).toISOString(),
        expiresAt: new Date(seeded.expiresAtMs).toISOString(),
        lastSeenAt: null,
      },
    ]);
    const mine = await t.staff.listSelf({ accountId: s.accountId, limit: 10, nowMs: clock.now() });
    expect(mine.items.map((x) => [x.assignmentId, x.activeScannerDeviceName])).toEqual([[seeded.assignmentId, '서문-14']]);
  });

  test('I-T89 ⑥ 0038 전처럼 이름 없이 들어간 행은 null이고 교대로 끝난 이전 세션은 목록에서 빠진다', async () => {
    const t = await setup();
    const s = await t.login('pg-sc-2');
    const old = await t.seed(s);
    expect((await t.list.run(s)).map((x) => [x.sessionId, x.deviceName])).toEqual([[old.scannerSessionId, null]]);
    // 같은 계정의 새 세션이 이전 세션을 끝낸다(계정당 하나)
    const next = await t.seed(s, { deviceName: '북문-02' });
    expect(await terminatedAt(old.scannerSessionId)).toEqual(new Date(clock.now()));
    expect((await t.list.run(s)).map((x) => [x.sessionId, x.deviceName])).toEqual([[next.scannerSessionId, '북문-02']]);
    const mine = await t.staff.listSelf({ accountId: s.accountId, limit: 10, nowMs: clock.now() });
    expect(Object.fromEntries(mine.items.map((x) => [x.assignmentId, x.activeScannerDeviceName]))).toEqual({ [old.assignmentId]: null, [next.assignmentId]: '북문-02' });
  });

  test('I-T89 ② expires_at 1ms 전은 남고 정각은 빠지며, 다른 계정의 세션은 없다', async () => {
    const t = await setup();
    const s = await t.login('pg-sc-3');
    const other = await t.login('pg-sc-3-other');
    const edge = await t.seed(s, { deviceName: '남문-01', expiresInMs: 1 });
    await t.seed(other, { deviceName: '남문-09' });
    expect((await t.list.run(s)).map((x) => x.sessionId)).toEqual([edge.scannerSessionId]);
    clock.advance(1);
    expect(await t.list.run(s)).toEqual([]);
    expect((await t.staff.listSelf({ accountId: s.accountId, limit: 10, nowMs: clock.now() })).items.map((x) => x.activeScannerDeviceName)).toEqual([null]);
  });

  test('I-T89 ④ 맞는 토큰이면 terminated_at과 LOGOUT 사건 한 건과 토큰 사용 기록을 남기고 CheckScannerSession이 거절하며, 같은 토큰은 다시 못 쓴다 [ASVS v5.0.0-10.4.9] [ASVS v5.0.0-7.5.2]', async () => {
    const t = await setup();
    const s = await t.login('pg-sc-4');
    const seeded = await t.seed(s, { deviceName: '동문-31' });
    expect((await t.check.run({ scannerSessionId: seeded.scannerSessionId, deviceId: seeded.deviceId })).valid).toBe(true);
    const before = (await events(s.accountId)).length;
    const tok = await t.token(s, 'SCANNER_SESSION_END');
    await t.end.run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: tok, scannerSessionId: seeded.scannerSessionId });
    expect(await terminatedAt(seeded.scannerSessionId)).toEqual(new Date(clock.now()));
    expect((await events(s.accountId)).slice(before)).toEqual([{ accountId: s.accountId, sessionId: seeded.scannerSessionId, reason: 'LOGOUT', terminatedAt: new Date(clock.now()).toISOString() }]);
    expect(await q('select account_id from reauth_token_use where account_id = $1', [s.accountId])).toHaveLength(1);
    expect((await t.check.run({ scannerSessionId: seeded.scannerSessionId, deviceId: seeded.deviceId })).valid).toBe(false);
    expect(await t.list.run(s)).toEqual([]);
    const again = await t.seed(s, { deviceName: '동문-32' });
    expect(await code(t.end.run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: tok, scannerSessionId: again.scannerSessionId }))).toBe('REAUTH_REQUIRED');
    expect(await terminatedAt(again.scannerSessionId)).toBeNull();
    expect((await events(s.accountId)).length).toBe(before + 1);
  });

  test('I-T89 ④ 사건을 쓰지 못하면(그날 Outbox 파티션 없음) 세션 끝냄과 토큰 사용 기록도 남지 않는다(한 트랜잭션)', async () => {
    const t = await setup();
    const s = await t.login('pg-sc-5');
    const seeded = await t.seed(s, { deviceName: '동문-41', expiresInMs: 500 * DAY });
    // Outbox 행 ID의 시계만 파티션이 없는 먼 날로 둔 저장소
    const far = new DrizzleStaffAssignmentStore(database, fakeClock({ now: clock.now() + 400 * DAY }));
    const jti = newKey();
    await expect(far.endOwnScannerSession({ accountId: s.accountId, scannerSessionId: seeded.scannerSessionId, nowMs: clock.now(), reauth: { jti, expiresAtMs: clock.now() + 300_000 } })).rejects.toThrow();
    expect(await terminatedAt(seeded.scannerSessionId)).toBeNull();
    expect(await q('select 1 from reauth_token_use where jti = $1', [jti])).toHaveLength(0);
    // 같은 토큰으로 제대로 된 저장소면 끝난다
    expect(await t.staff.endOwnScannerSession({ accountId: s.accountId, scannerSessionId: seeded.scannerSessionId, nowMs: clock.now(), reauth: { jti, expiresAtMs: clock.now() + 300_000 } })).toBe('ENDED');
  });

  test('I-T89 ③ 다른 작업(SESSION_END) 토큰·다른 팬 세션 토큰·토큰 없음은 REAUTH_REQUIRED이고 세션·기록은 그대로다 [ASVS v5.0.0-7.5.2]', async () => {
    const t = await setup();
    const phone = await t.login('pg-sc-6', 'dev-phone-6');
    const laptop = await t.login('pg-sc-6', 'dev-laptop-6');
    const seeded = await t.seed(phone, { deviceName: '동문-51' });
    const run = (reauthToken: string) => code(t.end.run({ accountId: phone.accountId, sessionId: phone.sessionId, reauthToken, scannerSessionId: seeded.scannerSessionId }));
    expect(await run(await t.token(phone, 'SESSION_END'))).toBe('REAUTH_REQUIRED');
    expect(await run(await t.token(laptop, 'SCANNER_SESSION_END'))).toBe('REAUTH_REQUIRED');
    expect(await run('')).toBe('REAUTH_REQUIRED');
    expect(await terminatedAt(seeded.scannerSessionId)).toBeNull();
    expect(await q('select 1 from reauth_token_use where account_id = $1', [phone.accountId])).toHaveLength(0);
    expect(await events(phone.accountId)).toEqual([]);
  });

  test('I-T89 ⑤ 남의 세션·끝난 세션·없는 ID는 SESSION_NOT_FOUND이고 토큰을 쓰지 않아 바로 뒤 자기 세션에는 같은 토큰이 통한다', async () => {
    const t = await setup();
    const me = await t.login('pg-sc-7');
    const other = await t.login('pg-sc-7-other');
    const theirs = await t.seed(other, { deviceName: '서문-61' });
    const old = await t.seed(me, { deviceName: '서문-62' });
    const mine = await t.seed(me, { deviceName: '서문-63' });
    expect(await terminatedAt(old.scannerSessionId)).not.toBeNull();
    const tok = await t.token(me, 'SCANNER_SESSION_END');
    const run = (id: string) => code(t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: tok, scannerSessionId: id }));
    expect([await run(theirs.scannerSessionId), await run(old.scannerSessionId), await run(uuid(0xfffff1)), await run('not-a-uuid')]).toEqual(['SESSION_NOT_FOUND', 'SESSION_NOT_FOUND', 'SESSION_NOT_FOUND', 'SESSION_NOT_FOUND']);
    expect(await terminatedAt(theirs.scannerSessionId)).toBeNull();
    expect(await q('select 1 from reauth_token_use where account_id = $1', [me.accountId])).toHaveLength(0);
    expect(await run(mine.scannerSessionId)).toBe('OK');
    expect(await terminatedAt(mine.scannerSessionId)).toEqual(new Date(clock.now()));
  });
});
