// 부정 예매 조사용 값의 통합 시험(실제 PostgreSQL 18과 AWS 흉내 서버 moto 5.2.5의 KMS HMAC 키, docs/features/identity.md §9.1 '조사용 값의 첫 구현', BUILD_ORDER BOT-045, I-T63·I-T64·I-T67).
// 라벨 키를 KMS GenerateMac으로 받아 계산한 값이 §9.1 식과 같은지, 마이그레이션 0014(account_contact_ref)와 연결 값 조회 SQL, 탈퇴 지우기, 정비의 다시 계산을 본다.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { CreateKeyCommand, GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { InvRefKeyRing } from '../src/modules/session/adapters/inv-ref-key-ring.js';
import { phoneContactRefs } from '../src/modules/session/adapters/phone-contact-refs.js';
import { BackfillContactRefs } from '../src/modules/session/application/backfill-contact-refs.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { GetInvestigationRefs } from '../src/modules/session/application/get-investigation-refs.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { kmsMacClient } from '../src/modules/verification/adapters/kms-identity-hashers.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, kit, newKey, testAgency } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const creds = { accessKeyId: 'test', secretAccessKey: 'test' };

let pg: PostgresContainer;
let database: Database;
let moto: string;
let endpoint: string;
let kms: KMSClient;
let keys: { device: string; contact: string };
const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') });

beforeAll(async () => {
  moto = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', moto, '5000/tcp']).split('\n')[0]!;
  endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  kms = new KMSClient({ endpoint, region: 'ap-northeast-2', credentials: creds });
  pg = await startPostgres();
  const make = async () => (await kms.send(new CreateKeyCommand({ KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC' }))).KeyMetadata!.KeyId!;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      keys = { device: await make(), contact: await make() };
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-investigation-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
  if (moto) docker(['rm', '-f', '-v', moto]);
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
/** KMS로 직접 라벨 키를 받아 §9.1 식으로 계산한 값(링과 따로 계산한다) */
const viaKms = async (keyId: string, label: string, version: number, value: string) => {
  const mac = (await kms.send(new GenerateMacCommand({ KeyId: keyId, MacAlgorithm: 'HMAC_SHA_256', Message: Buffer.from(`PEAKET-inv-ref-v1|${label}`) }))).Mac!;
  return `k${version}.${createHmac('sha256', Buffer.from(mac)).update(value, 'utf8').digest('base64url')}`;
};

async function setup(o: { contact?: boolean } = {}) {
  const ring = new InvRefKeyRing({
    sources: [{ label: 'device', version: 3, kmsKeyId: keys.device }, ...(o.contact === false ? [] : [{ label: 'contact' as const, version: 1, kmsKeyId: keys.contact }])],
    client: kmsMacClient({ region: 'ap-northeast-2', endpoint, credentials: creds }),
    clock,
  });
  await ring.refresh();
  const sessions = new DrizzleSessionStore(database, clock);
  const verifications = new DrizzleVerificationStore(database);
  const closure = new CloseAccount(sessions, clock);
  const k = await kit(sessions, { clock, invRefs: ring });
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const login = (sub: string, email: string | null, deviceId: string | null) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: sub, email, emailVerified: email !== null, deviceId });
  const verify = async (accountId: string, person: string, phone?: string, purpose: 'FIRST' | 'REVERIFY' = 'FIRST') => {
    const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId: null, purpose, next: '/' });
    return new ConfirmVerification(verifications, provider, hashers, closure, clock, phoneContactRefs(ring))
      .run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person, ...(phone ? { phone } : {}) }) })
      .catch((e: unknown) => e);
  };
  return { ring, sessions, login, verify };
}

test('I-T63·I-T64①_KMS로받은라벨키로_기기행은invRef(device,deviceId)이고_연락처는E164번호와맞춘이메일의PHONE·EMAIL행이며_원문과device_hash열이없다', async () => {
  const t = await setup();
  const a = await t.login('pg-i-1', '  Fan@Example.com ', 'dev-pg-1');
  await t.verify(a.accountId, 'pg-inv-person', '010-1234-5678');
  expect(await q('select device_ref from device where account_id = $1', [a.accountId])).toEqual([{ device_ref: await viaKms(keys.device, 'device', 3, 'dev-pg-1') }]);
  expect(await q('select kind, ref from account_contact_ref where account_id = $1 order by kind desc', [a.accountId])).toEqual([
    { kind: 'PHONE', ref: await viaKms(keys.contact, 'contact', 1, '+821012345678') },
    { kind: 'EMAIL', ref: await viaKms(keys.contact, 'contact', 1, 'fan@example.com') },
  ]);
  // 기기 식별값 원문과 옛 해시 열이 없다(I-T63), 연락처 표에 원문 칸이 없다(I-T64)
  // 기기 식별값 원문이 어느 칸에도 없다(I-T63)
  expect(JSON.stringify(await q('select row_to_json(d) from device d where account_id = $1', [a.accountId]))).not.toContain('dev-pg-1');
  // 다시 본인확인해 번호가 바뀌면 PHONE 값과 바뀐 시각만 새로 쓰고 EMAIL 행은 그대로다(I-T64 ④)
  const before = await q<{ kind: string; ref: string; updated_at: Date }>('select kind, ref, updated_at from account_contact_ref where account_id = $1 order by kind', [a.accountId]);
  clock.advance(60_000);
  await t.verify(a.accountId, 'pg-inv-person', '010-9999-0000', 'REVERIFY');
  const after = await q<{ kind: string; ref: string; updated_at: Date }>('select kind, ref, updated_at from account_contact_ref where account_id = $1 order by kind', [a.accountId]);
  expect(after.find((x) => x.kind === 'EMAIL')).toEqual(before.find((x) => x.kind === 'EMAIL'));
  expect(after.find((x) => x.kind === 'PHONE')).toEqual({ kind: 'PHONE', ref: await viaKms(keys.contact, 'contact', 1, '+821099990000'), updated_at: new Date(clock.now()) });
  // 탈퇴로 계정을 지우면 PHONE·EMAIL 행이 모두 없다(I-T64 ⑤)
  await t.sessions.transaction((tx) => tx.eraseAccount(a.accountId, clock.now()));
  expect(await q('select 1 from account_contact_ref where account_id = $1', [a.accountId])).toHaveLength(0);
  const cols = await q<{ table_name: string; column_name: string }>("select table_name, column_name from information_schema.columns where table_name in ('device', 'account_contact_ref')");
  expect(cols.map((c) => c.column_name)).not.toContain('device_hash');
  expect(cols.filter((c) => c.table_name === 'account_contact_ref').map((c) => c.column_name).sort()).toEqual(['account_id', 'kind', 'ref', 'ref_prev', 'updated_at']);
});

test('I-T67①·I-T64⑤_연결값조회는연락처·기기두개·같은본인확인시도의상대계정을주고_탈퇴한계정은빈항목이며연락처행이0건이다', async () => {
  const t = await setup();
  const a = await t.login('pg-i-2', 'two@peaket.test', 'dev-pg-2a');
  await t.login('pg-i-2', null, 'dev-pg-2b');
  await t.verify(a.accountId, 'pg-inv-twin', '010-2222-3333');
  // 같은 사람이 다른 계정에서 본인확인을 시도한다(409, identity_conflict_attempt)
  const b = await t.login('pg-i-3', null, null);
  await t.verify(b.accountId, 'pg-inv-twin');
  const gone = await t.login('pg-i-4', 'gone@peaket.test', 'dev-pg-4');
  await t.sessions.transaction((tx) => tx.eraseAccount(gone.accountId, clock.now()));
  expect(await q('select 1 from account_contact_ref where account_id = $1', [gone.accountId])).toHaveLength(0);
  const items = await new GetInvestigationRefs(t.sessions, clock).run([a.accountId, b.accountId, gone.accountId, '0190f3a1-7c2e-7a00-8000-0000000000fe']);
  expect(items.map((x) => x.accountId)).toEqual([a.accountId, b.accountId, gone.accountId]);
  expect(items[0]).toMatchObject({ contactRefs: [{ kind: 'PHONE' }, { kind: 'EMAIL' }], identityConflicts: [{ otherAccountId: b.accountId, attemptedAt: clock.now() }] });
  expect(new Set(items[0]!.deviceRefs)).toEqual(new Set([await viaKms(keys.device, 'device', 3, 'dev-pg-2a'), await viaKms(keys.device, 'device', 3, 'dev-pg-2b')]));
  expect(items[1]).toEqual({ accountId: b.accountId, contactRefs: [], deviceRefs: [], identityConflicts: [{ otherAccountId: a.accountId, attemptedAt: clock.now() }] });
  expect(items[2]).toEqual({ accountId: gone.accountId, contactRefs: [], deviceRefs: [], identityConflicts: [] });
  // 응답에 원문 번호·이메일이 없다
  expect(JSON.stringify(items)).not.toMatch(/two@peaket|2222|3333/);
});

test('연락처라벨키가없어쓰지못한EMAIL행은_PostgreSQL정비가account.email로다시계산하고_탈퇴한계정은건너뛴다', async () => {
  const t = await setup({ contact: false });
  const a = await t.login('pg-i-5', 'Late@Peaket.test', null);
  const a2 = await t.login('pg-i-5b', 'late2@peaket.test', null);
  const gone = await t.login('pg-i-6', 'gone2@peaket.test', null);
  await t.sessions.transaction((tx) => tx.eraseAccount(gone.accountId, clock.now()));
  expect(await q('select 1 from account_contact_ref where account_id = $1', [a.accountId])).toHaveLength(0);
  const full = await setup();
  // 한 묶음 1개로 돌아 커서(id > after) 분기를 PostgreSQL에서 탄다(다시 검토 중간 3)
  expect(await new BackfillContactRefs(full.sessions, full.ring, clock).run(1)).toBeGreaterThanOrEqual(2);
  expect(await q('select ref from account_contact_ref where account_id = $1', [a.accountId])).toEqual([{ ref: await viaKms(keys.contact, 'contact', 1, 'late@peaket.test') }]);
  expect(await q('select ref from account_contact_ref where account_id = $1', [a2.accountId])).toEqual([{ ref: await viaKms(keys.contact, 'contact', 1, 'late2@peaket.test') }]);
  expect(await q('select 1 from account_contact_ref where account_id = $1', [gone.accountId])).toHaveLength(0);
});

test('새맥락리뷰중간2_PostgreSQL에서_병합은흡수계정의연락처가명행을지우고대표계정의행은둔다', async () => {
  const t = await setup();
  const p = await t.login('pg-i-7', 'primary@peaket.test', null);
  const m = await t.login('pg-i-8', 'absorbed@peaket.test', null);
  await t.verify(m.accountId, 'pg-inv-absorbed', '010-7777-8888');
  await t.sessions.transaction(async (tx) => {
    await tx.lockAccount(p.accountId);
    await tx.lockAccount(m.accountId);
    await tx.mergeAccounts({ mergeId: '0190f3a1-7c2e-7a00-8000-0000000000e9', primaryAccountId: p.accountId, absorbedAccountId: m.accountId, mergedProvider: 'kakao', moved: {}, requestedAt: clock.now(), now: clock.now() });
  });
  expect(await q('select 1 from account_contact_ref where account_id = $1', [m.accountId])).toHaveLength(0);
  expect(await q('select kind from account_contact_ref where account_id = $1', [p.accountId])).toEqual([{ kind: 'EMAIL' }]);
});
