#!/usr/bin/env node
// 마이그레이션 검사(docs/devops.md §7.3, D-T8·D-T9·D-T44 ⑤, BAS-060, F-09-2 계획 §5).
// 끝 코드: 0 통과, 1 위반, 2 인자·파일·도구 오류. Squawk가 없거나 결과를 읽지 못하면 통과로 보지 않는다.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const MARKER = '-- peaket:no-transaction';
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string', default: '.' },
    files: { type: 'string' },
    base: { type: 'string' },
    squawk: { type: 'string' },
    now: { type: 'string' },
  },
});
const command = positionals[0];
const ROOT = resolve(values.root);
const errors = [];

const line = (path, message) => errors.push(`막음: ${path}: ${message}`);
const rel = (path) => relative(ROOT, path).split('\\').join('/');
const read = (path) => readFileSync(path, 'utf8');

function migrationDirs(root) {
  const services = join(root, 'services');
  if (!existsSync(services)) return [];
  return readdirSync(services)
    .map((name) => join(services, name, 'migrations'))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
}

function sqlFiles(root) {
  const files = [];
  for (const dir of migrationDirs(root)) {
    for (const name of readdirSync(dir).sort()) if (name.endsWith('.sql')) files.push(join(dir, name));
  }
  return files;
}

function check() {
  for (const dir of migrationDirs(ROOT)) {
    const names = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
    if (names.some((name) => name.endsWith('.down.sql'))) line(rel(dir), '되돌리기(down) 마이그레이션은 받지 않는다');
    const numbers = new Set();
    for (const name of names) {
      if (name.endsWith('.down.sql')) continue;
      if (!NAME.test(name)) line(rel(join(dir, name)), '파일 이름이 NNNN_이름.sql 꼴이 아니다');
      const number = name.slice(0, 4);
      if (numbers.has(number)) line(rel(join(dir, name)), `같은 번호의 파일이 둘 있다: ${number}`);
      numbers.add(number);
    }
    const journalPath = join(dir, 'meta', '_journal.json');
    if (existsSync(journalPath)) {
      try {
        const journal = JSON.parse(read(journalPath));
        const tags = Array.isArray(journal.entries) ? journal.entries.map((entry) => entry.tag) : [];
        const stems = names.filter((name) => !name.endsWith('.down.sql')).map((name) => name.slice(0, -4));
        if (tags.length !== stems.length || tags.some((tag, index) => tag !== stems[index])) {
          line(rel(journalPath), 'journal과 마이그레이션 파일 이름이 다르다');
        }
      } catch {
        line(rel(journalPath), 'journal을 읽지 못했다');
      }
    }
    for (const name of names) {
      if (name.endsWith('.down.sql')) continue;
      const path = join(dir, name);
      const sql = read(path);
      const lines = sql.split('\n');
      const first = (lines[0] ?? '').trim();
      const markerFirst = first === MARKER;
      const mentionsMarker = lines.some((row) => row.trim() === MARKER);
      const concurrent = /CREATE\s+INDEX\s+CONCURRENTLY/i.test(sql) || /DROP\s+INDEX\s+CONCURRENTLY/i.test(sql);
      if (mentionsMarker && !markerFirst) line(rel(path), 'no-transaction 표시는 첫 줄에만 쓴다');
      if (concurrent && !markerFirst) line(rel(path), 'CREATE INDEX CONCURRENTLY는 no-transaction 표시 파일에만 쓴다');
      if (markerFirst && (/\bBEGIN\s*;/i.test(sql) || /\bCOMMIT\s*;/i.test(sql))) {
        line(rel(path), 'no-transaction 파일에 BEGIN·COMMIT을 쓸 수 없다');
      }
    }
  }
}

function changedSqlFiles(base) {
  const result = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`, '--', 'services'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) return undefined;
  return (result.stdout ?? '')
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row.endsWith('.sql'))
    .map((row) => resolve(ROOT, row))
    .filter((path) => existsSync(path));
}

function n1() {
  const files = values.files
    ? values.files.split(',').map((path) => resolve(ROOT, path.trim())).filter(Boolean)
    : values.base
      ? changedSqlFiles(values.base) ?? sqlFiles(ROOT)
      : sqlFiles(ROOT);
  for (const path of files) {
    if (!existsSync(path)) {
      line(rel(path), '파일이 없다');
      continue;
    }
    const sql = read(path);
    if (/\bDROP\s+COLUMN\b/i.test(sql)) line(rel(path), 'DROP COLUMN은 N-1 비호환 축소다');
    if (/\bRENAME\s+COLUMN\b/i.test(sql)) line(rel(path), 'RENAME COLUMN은 N-1 비호환 축소다');
    if (/\bSET\s+NOT\s+NULL\b/i.test(sql)) line(rel(path), 'SET NOT NULL은 N-1 비호환 축소다');
    if (/\bALTER\s+COLUMN\s+\S+\s+TYPE\b/i.test(sql)) line(rel(path), 'ALTER COLUMN TYPE은 N-1 비호환 축소다');
    for (const match of sql.matchAll(/ADD\s+CONSTRAINT[\s\S]*?(?=;|$)/gi)) {
      if (!/NOT\s+VALID/i.test(match[0])) line(rel(path), 'ADD CONSTRAINT는 NOT VALID로 먼저 더한다');
    }
  }
}

function exceptions() {
  const path = join(ROOT, 'tools', 'ci', 'squawk-exceptions.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(read(path));
  } catch {
    return {};
  }
}

function activeException(exception, now) {
  if (!exception || typeof exception !== 'object') return false;
  if (typeof exception.reason !== 'string' || exception.reason.trim() === '') return false;
  if (typeof exception.expiresAt !== 'string' || exception.expiresAt < now) return false;
  return Array.isArray(exception.rules);
}

function squawk() {
  const configured = values.squawk ?? process.env.PEAKET_SQUAWK ?? 'squawk';
  if (configured === '') {
    line('squawk', 'Squawk 실행 파일이 없다');
    return 2;
  }
  const files = (values.files
    ? values.files.split(',').map((path) => resolve(ROOT, path.trim())).filter(Boolean)
    : values.base
      ? changedSqlFiles(values.base) ?? sqlFiles(ROOT)
      : sqlFiles(ROOT)
  ).map((path) => (path.startsWith(ROOT) ? rel(path) : path));
  if (files.length === 0) return 0;
  const useNode = /\.(mjs|cjs|js)$/i.test(configured);
  const result = useNode
    ? spawnSync(process.execPath, [configured, ...files], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
    : spawnSync(configured, files, { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status === null) {
    line('squawk', `Squawk를 실행하지 못했다: ${result.error?.message ?? 'unknown'}`);
    return 2;
  }
  if (result.status === 0) return 0;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const now = values.now ?? new Date().toISOString().slice(0, 10);
  const table = exceptions();
  let blocked = 0;
  for (const row of output.split('\n')) {
    const match = /^(.+?):(\d+):\s*([A-Za-z0-9_-]+):/.exec(row.trim());
    if (!match) continue;
    const [, file, , rule] = match;
    const exception = table[file];
    if (activeException(exception, now) && exception.rules.includes(rule)) continue;
    blocked += 1;
    line(file, `${rule} (Squawk)`);
  }
  if (blocked === 0 && output !== '') return 0;
  if (output !== '' && blocked === 0) return 1;
  return 1;
}

function roles() {
  const services = join(ROOT, 'services');
  if (!existsSync(services)) return;
  for (const service of readdirSync(services)) {
    const path = join(services, service, 'db', 'roles.sql');
    if (!existsSync(path)) continue;
    const text = read(path);
    const db = service.replace(/-svc$/, '').replace(/-/g, '_');
    const relay = `${db}_outbox_relay`;
    const maintenance = `${db}_maintenance`;
    if (!text.includes(`GRANT SELECT ON`) || !/GRANT\s+SELECT\s+ON[^;]*outbox/i.test(text)) line(rel(path), `${relay}에 Outbox SELECT가 없다`);
    if (!/GRANT\s+UPDATE\s+\(sent_at\)\s+ON[^;]*outbox/i.test(text)) line(rel(path), `${relay}에 sent_at UPDATE가 없다`);
    if (/GRANT\s+(INSERT|DELETE|UPDATE)\s+ON[^;]*outbox[^;]*TO[^;]*_outbox_relay/i.test(text)) line(rel(path), `${relay}에 Outbox 쓰기 권한이 과하다`);
    if (!new RegExp(`GRANT\\s+MAINTAIN\\s+ON[^;]*TO[^;]*${maintenance}`, 'i').test(text)) line(rel(path), `${maintenance}에 MAINTAIN이 없다`);
    if (!new RegExp(`GRANT\\s+DELETE\\s+ON[^;]*TO[^;]*${maintenance}`, 'i').test(text)) line(rel(path), `${maintenance}에 DELETE가 없다`);
    if (!/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+pgstattuple/i.test(text)) line(rel(path), 'pgstattuple 확장이 없다');
    if (!/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+pgstattuple/i.test(text)) line(rel(path), `${maintenance}에 pgstattuple EXECUTE가 없다`);
    if (service === 'purchase-svc') {
      if (!new RegExp(`REVOKE\\s+UPDATE,\\s*DELETE\\s+ON[^;]*order_event[^;]*FROM[^;]*${db}_app`, 'i').test(text)) {
        line(rel(path), 'purchase_app의 order_event UPDATE·DELETE 회수가 없다');
      }
    } else if (/REVOKE[^;]*order_event/i.test(text)) {
      line(rel(path), 'order_event는 purchase DB에만 있다');
    }
  }
}

try {
  if (!existsSync(ROOT)) {
    console.error(`없는 폴더: ${ROOT}`);
    process.exit(2);
  }
  if (command === 'check') check();
  else if (command === 'n1') n1();
  else if (command === 'roles') roles();
  else if (command === 'squawk') {
    const status = squawk();
    if (status === 2) {
      for (const row of errors) console.error(row);
      process.exit(2);
    }
  } else if (command === 'all') {
    check();
    n1();
    roles();
    squawk();
  } else {
    console.error('쓰는 법: node tools/ci/migration-check.mjs <check|squawk|n1|roles|all> [--root <폴더>] [--files a,b] [--base <ref>] [--squawk <실행 파일>] [--now YYYY-MM-DD]');
    process.exit(2);
  }
  if (errors.length > 0) {
    for (const row of errors) console.error(row);
    process.exit(1);
  }
} catch (error) {
  console.error(`검사하지 못했다: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
