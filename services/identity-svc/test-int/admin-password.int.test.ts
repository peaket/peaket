// 관리 계정 비밀번호 저장의 통합 시험(실제 PostgreSQL 18과 AWS 흉내 서버 moto 5.2.5의 KMS HMAC 키, docs/features/identity.md §6 '관리 계정 비밀번호 저장과 정책의 첫 구현', BUILD_ORDER BOT-110).
// 마이그레이션 0016(admin_account), KMS 페퍼의 GenerateMac·VerifyMac 왕복, 삭제하지 않은 계정 사이의 이메일 UNIQUE를 본다.
import { execFileSync } from 'node:child_process';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { createDatabase, type Database, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { KmsPepper, kmsPepperClient } from '../src/modules/admin/adapters/kms-pepper.js';
import { Pbkdf2AdminPasswords } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { SetAdminPassword } from '../src/modules/admin/application/set-admin-password.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { loadPolicyLists } from '../src/modules/admin/adapters/word-list-files.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const creds = { accessKeyId: 'test', secretAccessKey: 'test' };
let pg: PostgresContainer;
let database: Database;
let moto: string;
let endpoint: string;
let keys: { v1: string; v2: string };
const clock = fakeClock({ now: Date.parse('2026-11-05T00:00:00.000Z') });

beforeAll(async () => {
  moto = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', moto, '5000/tcp']).split('\n')[0]!;
  endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  const kms = new KMSClient({ endpoint, region: 'ap-northeast-2', credentials: creds });
  pg = await startPostgres();
  const make = async () => (await kms.send(new CreateKeyCommand({ KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC' }))).KeyMetadata!.KeyId!;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      keys = { v1: await make(), v2: await make() };
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-admin-password-test', max: 4 });
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
  if (moto) docker(['rm', '-f', '-v', moto]);
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
const ID = '0190f3a1-7c2e-7a00-8000-0000000000b1';

test('PostgreSQL·KMS에서_정한비밀번호는PHC로저장되고KMS VerifyMac으로맞으며_틀린원문·다른페퍼판으로는맞지않고_페퍼판이바뀌면다시저장을알린다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  await store.create({ id: ID, role: 'operator', email: '  Ops.Kim@Peaket.Example ', now: clock.now() });
  const client = kmsPepperClient({ region: 'ap-northeast-2', endpoint, credentials: creds });
  const v1 = new KmsPepper(client, new Map([[1, keys.v1]]), 1);
  const passwords = new Pbkdf2AdminPasswords(v1, { iterations: 1_000 });
  // 유출 목록 대역(없음)
  const set = new SetAdminPassword(store, passwords, { isBreached: async () => false }, loadPolicyLists({}), DEFAULT_ADMIN_AUTH_CONFIG, clock);
  await set.run({ accountId: ID, password: '봄비내리는월요일아침의커피한잔' });
  const [row] = await q<{ email: string; password_phc: string; breach_checked_at: Date; password_change_required: boolean }>('select email, password_phc, breach_checked_at, password_change_required from admin_account where id = $1', [ID]);
  expect(row).toMatchObject({ email: 'ops.kim@peaket.example', breach_checked_at: new Date(clock.now()), password_change_required: false });
  expect(row!.password_phc).toMatch(/^\$pbkdf2-sha256\$i=1000,k=1\$/);
  expect(await passwords.verify(ID, '봄비내리는월요일아침의커피한잔', row!.password_phc)).toBe(true);
  expect(await passwords.verify(ID, '봄비내리는월요일아침의커피한잔!', row!.password_phc)).toBe(false);
  // 같은 판 번호에 다른 KMS 키를 물리면 맞지 않는다(키가 없으면 같은 값을 만들 수 없다)
  expect(await new Pbkdf2AdminPasswords(new KmsPepper(client, new Map([[1, keys.v2]]), 1), { iterations: 1_000 }).verify(ID, '봄비내리는월요일아침의커피한잔', row!.password_phc)).toBe(false);
  // 페퍼 판 2가 쓰기 판이면 판 1 문자열은 맞되 다시 저장해야 한다
  const both = new Pbkdf2AdminPasswords(new KmsPepper(client, new Map([[1, keys.v1], [2, keys.v2]]), 2), { iterations: 1_000 });
  expect(await both.verify(ID, '봄비내리는월요일아침의커피한잔', row!.password_phc)).toBe(true);
  expect(both.needsRehash(row!.password_phc)).toBe(true);
});

test('PostgreSQL에서_삭제하지않은계정사이에서업무이메일은하나이고_삭제한계정의이메일은다시쓸수있다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  await store.create({ id: '0190f3a1-7c2e-7a00-8000-0000000000b2', role: 'cs_agent', email: 'same@peaket.example', now: clock.now() });
  await expect(store.create({ id: '0190f3a1-7c2e-7a00-8000-0000000000b3', role: 'cs_agent', email: 'SAME@peaket.example', now: clock.now() })).rejects.toThrow();
  await q("update admin_account set status = 'REMOVED' where id = $1", ['0190f3a1-7c2e-7a00-8000-0000000000b2']);
  await store.create({ id: '0190f3a1-7c2e-7a00-8000-0000000000b4', role: 'cs_agent', email: 'same@peaket.example', now: clock.now() });
  // 삭제한 계정 행에는 비밀번호를 쓰지 않는다(읽은 뒤 삭제되어도, 새 맥락 리뷰 2026-11-05)
  expect(await store.setPassword({ id: '0190f3a1-7c2e-7a00-8000-0000000000b2', phc: '$pbkdf2-sha256$i=1,k=1$AA$BB', breachCheckedAt: clock.now(), now: clock.now() })).toBe(false);
  const [gone] = await q<{ password_phc: string | null }>('select password_phc from admin_account where id = $1', ['0190f3a1-7c2e-7a00-8000-0000000000b2']);
  expect(gone!.password_phc).toBeNull();
  // 파트너 역할은 파트너사(promoter_id)가 있어야 한다
  await expect(store.create({ id: '0190f3a1-7c2e-7a00-8000-0000000000b5', role: 'partner_admin', email: 'p@haeoreum.example', now: clock.now() })).rejects.toThrow();
});
