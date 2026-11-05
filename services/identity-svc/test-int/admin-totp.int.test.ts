// 관리 계정 TOTP와 로그인 2단계의 통합 시험(실제 PostgreSQL 18과 KMS 흉내 서버 moto 5.2.5, docs/features/identity.md §6 '관리 계정 TOTP와 로그인 2단계의 첫 구현', BUILD_ORDER BOT-120).
// KMS GenerateDataKey·Decrypt의 암호화 컨텍스트 결속(I-T41), 마이그레이션 0018(admin_session·admin_recovery_code·TOTP 칸), 세션 2개 제한과 세션 종료 사건 Outbox를 본다.
import { execFileSync } from 'node:child_process';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { KmsTotpSeedCipher } from '../src/modules/admin/adapters/kms-totp-seed-cipher.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { Pbkdf2AdminPasswords, RECOVERY_CODE_ITERATIONS } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { ConfirmTotpEnrollment, BeginTotpEnrollment } from '../src/modules/admin/application/totp-enrollment.js';
import { TotpSeedUnreadable } from '../src/modules/admin/domain/ports.js';
import { base32Decode, totpAt } from '../src/modules/admin/domain/totp.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const creds = { accessKeyId: 'test', secretAccessKey: 'test' };
let pg: PostgresContainer;
let database: Database;
let moto: string;
let kms: KMSClient;
let keyId: string;
const clock = fakeClock({ now: Date.parse('2026-11-05T05:00:00.000Z') });
const A = '0190f3a1-7c2e-7a00-8000-0000000005a1';
const B = '0190f3a1-7c2e-7a00-8000-0000000005a2';

beforeAll(async () => {
  moto = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', moto, '5000/tcp']).split('\n')[0]!;
  kms = new KMSClient({ endpoint: `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`, region: 'ap-northeast-2', credentials: creds });
  pg = await startPostgres();
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      keyId = (await kms.send(new CreateKeyCommand({ KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT' }))).KeyMetadata!.KeyId!;
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-admin-totp-test', max: 4 });
  await ensureOutboxPartitions(database, clock);
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
  if (moto) docker(['rm', '-f', '-v', moto]);
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

test('KMS에서_TOTP시드는그계정의암호화컨텍스트로만풀리고_다른계정으로옮긴암호문은KMS가거절한다(I-T41) [ASVS v5.0.0-11.4.2]', async () => {
  const cipher = new KmsTotpSeedCipher(kms, keyId);
  const seed = Buffer.from('12345678901234567890', 'ascii');
  const blob = await cipher.encrypt(A, seed);
  expect(blob.includes(seed)).toBe(false);
  expect((await cipher.decrypt(A, blob)).equals(seed)).toBe(true);
  await expect(cipher.decrypt(B, blob)).rejects.toBeInstanceOf(TotpSeedUnreadable);
  // 시드 암호문 한 바이트만 바꿔도(GCM 태그), 암호화한 데이터 키 한 바이트만 바꿔도(KMS) 풀리지 않는다
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 1;
  await expect(cipher.decrypt(A, tampered)).rejects.toBeInstanceOf(TotpSeedUnreadable);
  // 암호화한 데이터 키의 끝 바이트(moto는 앞 36바이트에 키 ID를 두어 거기를 바꾸면 권한 거부로 답한다)
  const edk = Buffer.from(blob);
  edk[3 + blob.readUInt16BE(1) - 1] ^= 1;
  await expect(cipher.decrypt(A, edk)).rejects.toBeInstanceOf(TotpSeedUnreadable);
  // 암호화한 데이터 키 길이가 0인 깨진 행도 '풀 수 없음'이다(키 서비스 장애가 아니다)
  await expect(cipher.decrypt(A, Buffer.concat([Buffer.from([1, 0, 0]), blob.subarray(3 + blob.readUInt16BE(1))]))).rejects.toBeInstanceOf(TotpSeedUnreadable);
});

test('PostgreSQL에서_등록확인은시드·시간칸·복구코드10개를한트랜잭션으로쓰고_같은시간칸·같은로그인단계·같은복구코드는한번만받는다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  await store.create({ id: A, role: 'operator', email: 'totp.a@peaket.example', status: 'ACTIVE', now: clock.now() });
  const cipher = new KmsTotpSeedCipher(kms, keyId);
  const pepper = new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1);
  const hasher = new Pbkdf2AdminPasswords(pepper, { iterations: RECOVERY_CODE_ITERATIONS, context: 'admin-rc-v1' });
  const { otpauthUri } = await new BeginTotpEnrollment(store, cipher).run({ accountId: A });
  const seed = base32Decode(new URL(otpauthUri).searchParams.get('secret')!);
  const step = Math.floor(clock.now() / 30_000);
  const { recoveryCodes } = await new ConfirmTotpEnrollment(store, cipher, hasher, clock).run({ accountId: A, code: totpAt(seed, step) });
  const [row] = await q<{ totp_seed_enc: Buffer; totp_pending_enc: Buffer | null; totp_last_step: string }>('select totp_seed_enc, totp_pending_enc, totp_last_step from admin_account where id = $1', [A]);
  expect(row!.totp_pending_enc).toBeNull();
  expect(Number(row!.totp_last_step)).toBe(step);
  expect((await cipher.decrypt(A, row!.totp_seed_enc)).equals(seed)).toBe(true);
  const codes = await q<{ code_phc: string }>('select code_phc from admin_recovery_code where admin_account_id = $1', [A]);
  expect(codes).toHaveLength(10);
  expect(codes.every((c) => c.code_phc.startsWith('$pbkdf2-sha256$i=10000,k=1$'))).toBe(true);
  expect(recoveryCodes).toHaveLength(10);
  // 같은 시간 칸은 한 번만
  expect(await store.recordTotpStep(A, step, clock.now())).toBe(false);
  expect(await store.recordTotpStep(A, step + 1, clock.now())).toBe(true);
  // 복구 코드 행은 한 번만 지운다
  const [first] = await store.listRecoveryCodes(A);
  expect(await Promise.all([store.useRecoveryCode(first!.id), store.useRecoveryCode(first!.id)])).toEqual(expect.arrayContaining([true, false]));
});

test('PostgreSQL에서_로그인단계는한번만쓰고_세번째세션은유휴만료가가장이른세션을DEVICE_LIMIT로끝내며_알림행과세션종료사건을같은트랜잭션에적는다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  await store.create({ id: B, role: 'partner_admin', email: 'totp.b@haeoreum.example', status: 'ACTIVE', promoterId: '0190f3a1-7c2e-7a00-8000-000000000001', now: clock.now() });
  const stepId = '0190f3a1-7c2e-7a00-8000-0000000005b1';
  await store.createLoginStep({ id: stepId, accountId: B, tokenHash: Buffer.alloc(32, 1), aud: 'partner', pairRef: 'p'.repeat(32), createdAt: clock.now(), expiresAt: clock.now() + 300_000 });
  expect(await store.findLoginStep(Buffer.alloc(32, 1))).toMatchObject({ id: stepId, accountId: B, aud: 'partner', usedAt: null });
  expect(await Promise.all([store.useLoginStep(stepId, clock.now()), store.useLoginStep(stepId, clock.now())])).toEqual(expect.arrayContaining([true, false]));
  const ids = ['0190f3a1-7c2e-7a00-8000-0000000005c1', '0190f3a1-7c2e-7a00-8000-0000000005c2', '0190f3a1-7c2e-7a00-8000-0000000005c3'];
  const evicted: string[][] = [];
  for (const [k, id] of ids.entries()) {
    clock.advance(60_000);
    const now = clock.now();
    evicted.push((await store.createSession({ id, accountId: B, aud: 'partner', refreshHash: Buffer.alloc(32, 10 + k), refreshFamily: id, pairRef: 'p'.repeat(32), createdAt: now, absoluteExpiresAt: now + 86_400_000, idleExpiresAt: now + 3_600_000 }, 2)).evicted);
  }
  expect(evicted).toEqual([[], [], [ids[0]]]);
  const rows = await q<{ id: string; termination_reason: string | null }>('select id, termination_reason from admin_session where admin_account_id = $1 order by created_at', [B]);
  expect(rows.map((r) => r.termination_reason)).toEqual(['DEVICE_LIMIT', null, null]);
  expect(await q('select kind from admin_security_notice where admin_account_id = $1', [B])).toEqual([{ kind: 'SESSION_LIMIT' }]);
  const events = await q<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1", [B]);
  expect(events.map((e) => JSON.parse(e.payload.toString('utf8')))).toEqual([{ accountId: B, sessionId: ids[0], reason: 'DEVICE_LIMIT', terminatedAt: new Date(clock.now()).toISOString() }]);
});

test('PostgreSQL에서_같은계정의세션만들기네개가동시에와도살아있는세션은2개이고_2단계마치기는코드·단계·세션을한트랜잭션으로써서단계를이미썼으면복구코드를남긴다(BOT-120이넘긴것)', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const C = '0190f3a1-7c2e-7a00-8000-0000000005a3';
  await store.create({ id: C, role: 'partner_admin', email: 'totp.c@haeoreum.example', status: 'ACTIVE', promoterId: '0190f3a1-7c2e-7a00-8000-000000000001', now: clock.now() });
  const now = clock.now();
  const ids = [1, 2, 3, 4].map((k) => `0190f3a1-7c2e-7a00-8000-0000000005d${k}`);
  await Promise.all(ids.map((id, k) => store.createSession({ id, accountId: C, aud: 'partner', refreshHash: Buffer.alloc(32, 40 + k), refreshFamily: id, pairRef: 'p'.repeat(32), createdAt: now, absoluteExpiresAt: now + 86_400_000, idleExpiresAt: now + 3_600_000 + k }, 2)));
  expect(await q('select 1 from admin_session where admin_account_id = $1 and terminated_at is null', [C])).toHaveLength(2);
  // 복구 코드 하나와 이미 쓴 단계: 마치기는 STEP_USED이고 복구 코드·세션을 쓰지 않는다
  await q("insert into admin_recovery_code (id, admin_account_id, code_phc, created_at) values ('0190f3a1-7c2e-7a00-8000-0000000005e1', $1, 'phc', now())", [C]);
  const stepId = '0190f3a1-7c2e-7a00-8000-0000000005e2';
  await store.createLoginStep({ id: stepId, accountId: C, tokenHash: Buffer.alloc(32, 50), aud: 'partner', pairRef: 'p'.repeat(32), createdAt: now, expiresAt: now + 300_000 });
  expect(await store.useLoginStep(stepId, now)).toBe(true);
  const sid = '0190f3a1-7c2e-7a00-8000-0000000005e3';
  const r = await store.finishSecondStep({ id: sid, accountId: C, aud: 'partner', refreshHash: Buffer.alloc(32, 51), refreshFamily: sid, pairRef: 'p'.repeat(32), createdAt: now, absoluteExpiresAt: now + 86_400_000, idleExpiresAt: now + 3_600_000 }, 2, { stepId, code: { kind: 'recovery', rowId: '0190f3a1-7c2e-7a00-8000-0000000005e1' } });
  expect(r).toEqual({ kind: 'STEP_USED' });
  expect(await q('select 1 from admin_recovery_code where admin_account_id = $1', [C])).toHaveLength(1);
  expect(await q('select 1 from admin_session where id = $1', [sid])).toHaveLength(0);
  // 새 단계와 TOTP 시간 칸: 마치면 시간 칸·단계·세션을 함께 쓰고, 같은 시간 칸으로 다시 마치면 CODE_USED이고 단계는 쓰지 않는다
  const s2 = '0190f3a1-7c2e-7a00-8000-0000000005e4';
  await store.createLoginStep({ id: s2, accountId: C, tokenHash: Buffer.alloc(32, 52), aud: 'partner', pairRef: 'p'.repeat(32), createdAt: now, expiresAt: now + 300_000 });
  const ok = '0190f3a1-7c2e-7a00-8000-0000000005e5';
  const done = await store.finishSecondStep({ id: ok, accountId: C, aud: 'partner', refreshHash: Buffer.alloc(32, 53), refreshFamily: ok, pairRef: 'p'.repeat(32), createdAt: now, absoluteExpiresAt: now + 86_400_000, idleExpiresAt: now + 7_200_000 }, 2, { stepId: s2, code: { kind: 'totp', step: 999_999_999 } });
  expect(done).toMatchObject({ kind: 'DONE', evicted: [expect.any(String)] });
  expect(await q('select totp_last_step from admin_account where id = $1', [C])).toEqual([{ totp_last_step: '999999999' }]);
  expect(await q<{ used_at: Date | null }>('select used_at from admin_login_step where id = $1', [s2])).toEqual([{ used_at: new Date(now) }]);
  const s3 = '0190f3a1-7c2e-7a00-8000-0000000005e6';
  await store.createLoginStep({ id: s3, accountId: C, tokenHash: Buffer.alloc(32, 54), aud: 'partner', pairRef: 'p'.repeat(32), createdAt: now, expiresAt: now + 300_000 });
  const again = '0190f3a1-7c2e-7a00-8000-0000000005e7';
  expect(await store.finishSecondStep({ id: again, accountId: C, aud: 'partner', refreshHash: Buffer.alloc(32, 55), refreshFamily: again, pairRef: 'p'.repeat(32), createdAt: now, absoluteExpiresAt: now + 86_400_000, idleExpiresAt: now + 7_200_000 }, 2, { stepId: s3, code: { kind: 'totp', step: 999_999_999 } })).toEqual({ kind: 'CODE_USED' });
  expect(await q<{ used_at: Date | null }>('select used_at from admin_login_step where id = $1', [s3])).toEqual([{ used_at: null }]);
  // 계정이 활성이 아니면(그 사이 재초대 정리·삭제) 단계·코드를 쓰지 않는다
  await q("update admin_account set status = 'REMOVED' where id = $1", [C]);
  expect(await store.finishSecondStep({ id: again, accountId: C, aud: 'partner', refreshHash: Buffer.alloc(32, 56), refreshFamily: again, pairRef: 'p'.repeat(32), createdAt: now, absoluteExpiresAt: now + 86_400_000, idleExpiresAt: now + 7_200_000 }, 2, { stepId: s3, code: { kind: 'totp', step: 1_000_000_000 } })).toEqual({ kind: 'STEP_USED' });
  expect(await q<{ used_at: Date | null }>('select used_at from admin_login_step where id = $1', [s3])).toEqual([{ used_at: null }]);
});
