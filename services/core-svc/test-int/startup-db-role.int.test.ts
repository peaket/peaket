// 운영 시작 파일의 DB 연결 시작 확인(AZ-T5, ADR-0241 결정 7, docs/security/authz-matrix.md §5.3, W12-core-rls2 감독 요청).
// 소유자·슈퍼유저로 붙으면 행 보안이 조용히 꺼지므로 서비스가 시작하지 않아야 한다. 확인 함수 자체는 rls.int.test.ts가 보고,
// 이 파일은 빌드한 dist/main.js(운영 실행 명령 그대로)가 팬·파트너·관제·검색 연결마다 그 확인을 거는지를 프로세스 결과로 본다.
// 연결 하나만 슈퍼유저 주소로 바꾸고 나머지는 운영과 같은 로그인으로 둔다. 그 밖의 의존(gRPC·이미지 출처)은 닿지 않는 주소다(시작 확인보다 뒤에 쓰인다).
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { buildDist, freePort, SERVICE_DIR } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { ensureSearchLogin, loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
/** 0043 전 트리에서는 core_notify 역할이 없어 로그인을 만들지 못한다. 그때는 undefined로 두고 AZ-T19 ④가 실패를 드러낸다 */
let notifyUrl: string | undefined;
const logins: Database[] = [];

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-startup-db-role-int', max: 2 });
  logins.push(await loginFor(admin, pg, 'core_app_login', 'core_app', 1));
  logins.push(await loginFor(admin, pg, 'core_partner_login', 'core_partner', 1));
  logins.push(await loginFor(admin, pg, 'core_ops_login', 'core_ops', 1));
  try {
    logins.push(await loginFor(admin, pg, 'core_notify_login', 'core_notify', 1));
    notifyUrl = pg.urlFor('core_notify_login', 'peaket-test');
  } catch {
    notifyUrl = undefined;
  }
  buildDist();
}, 180_000);
afterAll(async () => {
  for (const l of logins) await l.close();
  await admin?.close();
  pg?.stop();
});

/** dist/main.js를 띄워 끝날 때까지 기다린다. 30초 안에 끝나지 않으면 죽이고 그 사실을 돌려준다(시작 확인을 지나 떠 버린 경우) */
async function bootUntilExit(env: Record<string, string>, limitMs = 30_000): Promise<{ code: number | null; stillRunning: boolean; output: string }> {
  const base: Record<string, string> = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k]) base[k] = process.env[k]!;
  const child: ChildProcess = spawn(process.execPath, ['dist/main.js'], { cwd: SERVICE_DIR, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', (d) => (output += String(d)));
  child.stderr!.on('data', (d) => (output += String(d)));
  const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([exited.then((code) => ({ code, stillRunning: false })), new Promise<{ code: null; stillRunning: true }>((r) => (timer = setTimeout(() => r({ code: null, stillRunning: true }), limitMs)))]);
  clearTimeout(timer);
  if (outcome.stillRunning) {
    child.kill();
    await exited;
  }
  return { ...outcome, output };
}

describe('운영 시작 파일의 DB 연결 시작 확인(ADR-0241 결정 7)', () => {
  test('AZ-T5 운영 시작 파일은 팬·파트너·관제·검색 연결 가운데 하나라도 슈퍼유저로 붙으면 뜨지 않고 그 연결의 역할을 알린다 [ASVS v5.0.0-8.4.1]', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'peaket-startup-role-'));
    try {
      const ok = {
        PEAKET_ENV: 'local',
        PORT: String(await freePort()),
        PEAKET_MANAGEMENT_PORT: String(await freePort()),
        PEAKET_DATABASE_URL: pg.urlFor('core_app_login', 'peaket-test'),
        PEAKET_PARTNER_DATABASE_URL: pg.urlFor('core_partner_login', 'peaket-test'),
        PEAKET_OPS_DATABASE_URL: pg.urlFor('core_ops_login', 'peaket-test'),
        PEAKET_SEARCH_DATABASE_URL: await ensureSearchLogin(admin, pg),
        ...(notifyUrl ? { PEAKET_NOTIFY_DATABASE_URL: notifyUrl } : {}),
        PEAKET_IDENTITY_GRPC_URL: '127.0.0.1:1',
        PEAKET_IMAGE_GRPC_URL: '127.0.0.1:1',
        PEAKET_SEATMAP_GRPC_URL: '127.0.0.1:1',
        PEAKET_IMAGE_BASE_URL: 'http://127.0.0.1:1',
        PEAKET_IMAGE_STORE_DIR: dir,
        PEAKET_PUBLIC_FILE_DIR: join(dir, 'public-files'),
      };
      // 연결마다 그 주소만 슈퍼유저(시험 컨테이너의 postgres)로 바꾼다. 팬 주소는 소비자 풀도 함께 쓴다
      const cases = [
        ['PEAKET_DATABASE_URL', 'core_app'],
        ['PEAKET_PARTNER_DATABASE_URL', 'core_partner'],
        ['PEAKET_OPS_DATABASE_URL', 'core_ops'],
        ['PEAKET_SEARCH_DATABASE_URL', 'core_search'],
        ['PEAKET_NOTIFY_DATABASE_URL', 'core_notify'],
      ] as const;
      const seen: Record<string, { code: number | null; stillRunning: boolean; refusedFor: string | null }> = {};
      for (const [name, role] of cases) {
        const r = await bootUntilExit({ ...ok, [name]: pg.url });
        const m = /슈퍼유저이거나 표 소유자라 행 보안이 걸리지 않는다\((core_[a-z]+)로 접속해야 한다\)/.exec(r.output);
        seen[name] = { code: r.code, stillRunning: r.stillRunning, refusedFor: m?.[1] ?? (r.output.slice(-300) || null) };
        expect(seen[name], `${name} ${role}`).toEqual({ code: 1, stillRunning: false, refusedFor: role });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test('AZ-T19 ④ 운영 시작 파일은 PEAKET_NOTIFY_DATABASE_URL이 없거나 core_notify가 아닌 로그인으로 시작하면 뜨지 않는다 [ASVS v5.0.0-8.4.1]', async () => {
    expect(notifyUrl, '0043이 없어 core_notify 로그인을 만들지 못했다(발송기 전용 역할이 아직 없다)').toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), 'peaket-startup-notify-'));
    try {
      const ok: Record<string, string> = {
        PEAKET_ENV: 'local',
        PORT: String(await freePort()),
        PEAKET_MANAGEMENT_PORT: String(await freePort()),
        PEAKET_DATABASE_URL: pg.urlFor('core_app_login', 'peaket-test'),
        PEAKET_PARTNER_DATABASE_URL: pg.urlFor('core_partner_login', 'peaket-test'),
        PEAKET_OPS_DATABASE_URL: pg.urlFor('core_ops_login', 'peaket-test'),
        PEAKET_SEARCH_DATABASE_URL: await ensureSearchLogin(admin, pg),
        PEAKET_NOTIFY_DATABASE_URL: notifyUrl!,
        PEAKET_IDENTITY_GRPC_URL: '127.0.0.1:1',
        PEAKET_IMAGE_GRPC_URL: '127.0.0.1:1',
        PEAKET_SEATMAP_GRPC_URL: '127.0.0.1:1',
        PEAKET_IMAGE_BASE_URL: 'http://127.0.0.1:1',
        PEAKET_IMAGE_STORE_DIR: dir,
        PEAKET_PUBLIC_FILE_DIR: join(dir, 'public-files'),
      };
      // (가) 변수 없음, (나) 팬 경로 로그인, (다) 슈퍼유저. 셋 다 시작 확인에서 멈춰야 한다
      const withoutNotify = { ...ok };
      delete withoutNotify.PEAKET_NOTIFY_DATABASE_URL;
      const missing = await bootUntilExit(withoutNotify);
      const wrongRole = await bootUntilExit({ ...ok, PEAKET_NOTIFY_DATABASE_URL: pg.urlFor('core_app_login', 'peaket-test') });
      const superuser = await bootUntilExit({ ...ok, PEAKET_NOTIFY_DATABASE_URL: pg.url });
      // (라) 발송기 로그인이 같은 이름의 표를 소유하면(행 보안을 건너뛴다) 시작 확인이 멈춰야 한다(RV-01).
      // 실제 표의 소유자를 바꾸지 않고 별도 스키마에 같은 이름의 표를 만들어 소유자 검사만 본다
      await admin.pool.query('drop schema if exists notify_owner_probe cascade');
      await admin.pool.query('create schema notify_owner_probe authorization core_notify_login');
      await admin.pool.query('create table notify_owner_probe.webhook_delivery (id int)');
      await admin.pool.query('alter table notify_owner_probe.webhook_delivery owner to core_notify_login');
      let owner: { code: number | null; stillRunning: boolean; output: string };
      try {
        owner = await bootUntilExit(ok);
      } finally {
        await admin.pool.query('drop schema if exists notify_owner_probe cascade');
      }
      // (마) core_notify 로그인이면 시작 확인을 지나 뜬다(10초 안에 끝나지 않으면 떠 있는 것으로 본다)
      const valid = await bootUntilExit(ok, 10_000);
      expect({
        missing: { code: missing.code, stillRunning: missing.stillRunning, named: /PEAKET_NOTIFY_DATABASE_URL이 없다/.test(missing.output) },
        wrongRole: { code: wrongRole.code, stillRunning: wrongRole.stillRunning, named: /DB 사용자가 core_notify 역할이 아니다/.test(wrongRole.output) },
        superuser: { code: superuser.code, stillRunning: superuser.stillRunning, named: /슈퍼유저이거나 표 소유자라 행 보안이 걸리지 않는다\(core_notify로 접속해야 한다\)/.test(superuser.output) },
        owner: { code: owner.code, stillRunning: owner.stillRunning, named: /슈퍼유저이거나 표 소유자라 행 보안이 걸리지 않는다\(core_notify로 접속해야 한다\)/.test(owner.output) },
        valid: { code: valid.code, stillRunning: valid.stillRunning },
      }).toEqual({
        missing: { code: 1, stillRunning: false, named: true },
        wrongRole: { code: 1, stillRunning: false, named: true },
        superuser: { code: 1, stillRunning: false, named: true },
        owner: { code: 1, stillRunning: false, named: true },
        valid: { code: null, stillRunning: true },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
