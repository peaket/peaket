// 마이그레이션 검사 도구 계약 시험(D-T8·D-T9·D-T44 ⑤, F-09-2 계획 §5·§6).
// 실제 저장소 파일(차트·서비스 스크립트·워크플로·역할 SQL)을 보는 시험과, 임시 폴더의 마이그레이션 묶음으로
// 검사기 규칙을 보는 시험을 나눈다. 검사기 자체가 없으면 뒤쪽은 실행되지 않고, 앞쪽은 실제 파일이 없어 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'tools', 'ci', 'migration-check.mjs');
const dirs = [];

function temp(files) {
  const root = mkdtempSync(join(tmpdir(), 'peaket-migration-check-'));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
}

function migrationRoot(files) {
  const all = {};
  for (const [name, sql] of Object.entries(files)) all[`services/core-svc/migrations/${name}`] = sql;
  const names = Object.keys(files).sort();
  all['services/core-svc/migrations/meta/_journal.json'] = JSON.stringify({
    version: '7',
    dialect: 'postgresql',
    entries: names.map((name, idx) => ({ idx, tag: name.replace(/\.sql$/, '') })),
  });
  return temp(all);
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? REPO,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function fakeSquawk(body) {
  return temp({ 'fake-squawk.mjs': body });
}

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('D-T9 첫 줄 표시가 있는 트랜잭션 밖 파일과 정상 journal은 통과한다', () => {
  const root = migrationRoot({
    '0000_a.sql': 'CREATE TABLE a (id int);',
    '0001_index.sql': '-- peaket:no-transaction\nCREATE INDEX CONCURRENTLY a_idx ON a (id);',
  });
  const result = run(['check', '--root', root]);
  assert.equal(result.status, 0, result.stderr);
});

test('D-T9 표시가 첫 줄이 아니면 막는다', () => {
  const root = migrationRoot({
    '0000_a.sql': '-- 설명\n-- peaket:no-transaction\nCREATE INDEX CONCURRENTLY a_idx ON a (id);',
  });
  const result = run(['check', '--root', root]);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /no-transaction|첫 줄/);
});

test('D-T9 표시 없는 파일의 CREATE INDEX CONCURRENTLY를 막는다', () => {
  const root = migrationRoot({ '0000_a.sql': 'CREATE INDEX CONCURRENTLY a_idx ON a (id);' });
  const result = run(['check', '--root', root]);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /CONCURRENTLY|no-transaction/);
});

test('D-T9 표시 파일 안의 BEGIN·COMMIT을 막는다', () => {
  const root = migrationRoot({
    '0000_a.sql': '-- peaket:no-transaction\nBEGIN;\nCREATE INDEX CONCURRENTLY a_idx ON a (id);\nCOMMIT;',
  });
  const result = run(['check', '--root', root]);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /BEGIN|COMMIT/);
});

test('D-T9 journal과 파일 이름이 다르면 막는다', () => {
  const root = temp({
    'services/core-svc/migrations/0000_a.sql': 'CREATE TABLE a (id int);',
    'services/core-svc/migrations/meta/_journal.json': JSON.stringify({ version: '7', entries: [{ idx: 0, tag: '0001_other' }] }),
  });
  const result = run(['check', '--root', root]);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /journal/);
});

test('D-T9 같은 번호의 파일 둘은 막는다', () => {
  const root = temp({
    'services/core-svc/migrations/0000_a.sql': 'CREATE TABLE a (id int);',
    'services/core-svc/migrations/0000_b.sql': 'CREATE TABLE b (id int);',
  });
  const result = run(['check', '--root', root]);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /번호|DUPLICATE/);
});

test('D-T8 DROP COLUMN·RENAME COLUMN·SET NOT NULL은 N-1 비호환이라 막는다', () => {
  for (const sql of [
    'ALTER TABLE account DROP COLUMN nickname;',
    'ALTER TABLE account RENAME COLUMN nickname TO display_name;',
    'ALTER TABLE account ALTER COLUMN email SET NOT NULL;',
  ]) {
    const root = migrationRoot({ '0000_change.sql': sql });
    const result = run(['n1', '--root', root, '--files', 'services/core-svc/migrations/0000_change.sql']);
    assert.equal(result.status, 1, `${sql}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /DROP COLUMN|RENAME COLUMN|SET NOT NULL|N-1/);
  }
});

test('D-T8 NOT NULL DEFAULT 추가와 NOT VALID 제약은 통과한다', () => {
  const root = migrationRoot({
    '0000_expand.sql': [
      'ALTER TABLE account ADD COLUMN nickname text NOT NULL DEFAULT \'\';',
      'ALTER TABLE account ADD CONSTRAINT account_email_check CHECK (email <> \'\') NOT VALID;',
    ].join('\n'),
  });
  const result = run(['n1', '--root', root, '--files', 'services/core-svc/migrations/0000_expand.sql']);
  assert.equal(result.status, 0, result.stderr);
});

test('Squawk는 바뀐 파일만 부르고 위반이면 막는다', () => {
  const root = migrationRoot({ '0000_a.sql': 'CREATE TABLE a (id int);' });
  const log = join(root, 'squawk-args.txt');
  const fake = fakeSquawk(`
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\n'), 'utf8');
console.error('0000_a.sql:1: prefer-text-field: 위험 패턴');
process.exit(1);
`);
  const result = run(['squawk', '--root', root, '--base', 'HEAD', '--squawk', join(fake, 'fake-squawk.mjs')], {
    env: { PEAKET_SQUAWK: join(fake, 'fake-squawk.mjs') },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout + result.stderr, /prefer-text-field/);
  const args = readFileSync(log, 'utf8');
  assert.match(args, /0000_a\.sql/);
});

test('Squawk 실행 파일이 없으면 통과로 보지 않는다', () => {
  const root = migrationRoot({ '0000_a.sql': 'CREATE TABLE a (id int);' });
  const empty = temp({ '.keep': '' });
  const result = run(['squawk', '--root', root, '--base', 'HEAD'], {
    env: { PEAKET_SQUAWK: '', PATH: empty, Path: empty },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test('Squawk 예외는 파일·규칙·까닭·만료가 맞을 때만 면제한다', () => {
  const root = migrationRoot({ '0000_a.sql': 'CREATE TABLE a (id int);' });
  mkdirSync(join(root, 'tools', 'ci'), { recursive: true });
  writeFileSync(
    join(root, 'tools', 'ci', 'squawk-exceptions.json'),
    JSON.stringify({ 'services/core-svc/migrations/0000_a.sql': { rules: ['prefer-text-field'], reason: '기존 표 확장', expiresAt: '2026-12-31' } }),
    'utf8',
  );
  const fake = fakeSquawk(`
console.error('services/core-svc/migrations/0000_a.sql:1: prefer-text-field: 위험 패턴');
process.exit(1);
`);
  const ok = run(['squawk', '--root', root, '--base', 'HEAD', '--now', '2026-11-27', '--squawk', join(fake, 'fake-squawk.mjs')]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);

  writeFileSync(
    join(root, 'tools', 'ci', 'squawk-exceptions.json'),
    JSON.stringify({ 'services/core-svc/migrations/0000_a.sql': { rules: ['prefer-text-field'], reason: '기존 표 확장', expiresAt: '2026-11-01' } }),
    'utf8',
  );
  const expired = run(['squawk', '--root', root, '--base', 'HEAD', '--now', '2026-11-27', '--squawk', join(fake, 'fake-squawk.mjs')]);
  assert.equal(expired.status, 1, expired.stdout + expired.stderr);
});

test('D-T44 ⑤ 차트의 PreSync 마이그레이션 Job은 DDL 역할 주소만 쓴다', () => {
  const path = join(REPO, 'deploy', 'charts', 'peaket-service', 'templates', 'migration-job.yaml');
  assert.ok(existsSync(path), `차트 마이그레이션 Job이 없다: ${path}`);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /argocd\.argoproj\.io\/hook:\s*PreSync/);
  assert.match(text, /hook-delete-policy:\s*BeforeHookCreation/);
  assert.match(text, /PEAKET_MIGRATION_DATABASE_URL/);
  assert.match(text, /PEAKET_MAINTENANCE_DATABASE_URL/);
  assert.doesNotMatch(text, /PEAKET_DATABASE_URL/);
  assert.doesNotMatch(text, /pgbouncer/i);
  assert.match(text, /scripts\/migrate\.mjs/);
});

test('D-T44 ⑤ 모든 PostgreSQL 서비스 스크립트는 공용 실행기를 부른다', () => {
  const services = ['core-svc', 'identity-svc', 'ops-svc', 'payment-svc', 'purchase-svc', 'ticket-svc'];
  for (const service of services) {
    const path = join(REPO, 'services', service, 'scripts', 'migrate.mjs');
    assert.ok(existsSync(path), `${service} migrate.mjs가 없다`);
    const text = readFileSync(path, 'utf8');
    assert.match(text, /runMigrations/, `${service}: 공용 실행기를 부르지 않는다`);
    assert.doesNotMatch(text, /drizzle-orm\/.*\/migrator/, `${service}: Drizzle migrator를 아직 쓴다`);
    assert.doesNotMatch(text, /query\(['"]BEGIN['"]\)/, `${service}: 자체 BEGIN 루프가 남아 있다`);
    assert.match(text, /PEAKET_MIGRATION_DATABASE_URL/, `${service}: DDL 역할 주소를 읽지 않는다`);
    assert.doesNotMatch(text, /PEAKET_DATABASE_URL/, `${service}: 앱 PgBouncer 주소를 읽는다`);
  }
});

test('[ASVS v5.0.0-13.2.2] 서비스별 역할 SQL은 릴레이에 SELECT와 sent_at UPDATE만 준다', () => {
  const services = ['core-svc', 'identity-svc', 'ops-svc', 'payment-svc', 'purchase-svc', 'ticket-svc'];
  for (const service of services) {
    const path = join(REPO, 'services', service, 'db', 'roles.sql');
    assert.ok(existsSync(path), `${service} roles.sql이 없다`);
    const text = readFileSync(path, 'utf8');
    const db = service.replace(/-svc$/, '').replace('-', '_');
    assert.match(text, new RegExp(`${db}_outbox_relay`));
    assert.match(text, /GRANT SELECT ON [^;]*outbox/i);
    assert.match(text, /GRANT UPDATE \(sent_at\) ON [^;]*outbox/i);
    assert.doesNotMatch(text, /GRANT (INSERT|DELETE|UPDATE) ON [^;]*outbox[^;]*TO [^;]*_outbox_relay/i);
    assert.match(text, /REVOKE (UPDATE|DELETE)/i);
  }
});

test('마이그레이션 검사 워크플로가 ci.yml에 연결돼 있다', () => {
  const workflow = join(REPO, '.github', 'workflows', 'migration-check.yml');
  assert.ok(existsSync(workflow), 'migration-check.yml이 없다');
  const text = readFileSync(workflow, 'utf8');
  assert.match(text, /migration-check\.mjs (check|all)/);
  assert.match(text, /migration-check\.mjs squawk/);
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /migration-check/);
});
