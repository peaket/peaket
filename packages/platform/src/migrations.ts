// DB 마이그레이션 공용 실행기(docs/devops.md §7.2·§7.3, ADR-0037 결정 6, ADR-0083, BAS-060, F-09-2).
// - Drizzle-kit은 SQL 파일 생성만 하고, 실행 순서·트랜잭션·잠금·기록은 이 실행기가 맡는다.
// - 파일마다 트랜잭션을 건다. 첫 줄 `-- peaket:no-transaction` 파일만 트랜잭션 밖에서 문장 단위로 실행한다.
// - `peaket_migration`에 SHA-256 체크섬을 남기고, 이미 적용한 파일은 다시 적용하지 않는다.
// - advisory 잠금으로 같은 DB의 두 실행을 막고, 문장마다 lock_timeout·statement_timeout을 건다.
// - 기존 `ops_migration`·`ticket_migration`·`drizzle.__drizzle_migrations` 기록을 한 번 이관한다.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const MIGRATION_LOCK_CLASS = 0x5045414b;
export const MIGRATION_LOCK_OBJECT = 0x4554;
export const NO_TRANSACTION_MARKER = '-- peaket:no-transaction';
export const MIGRATION_LEDGER = 'peaket_migration';

const LOCK_MESSAGE = '다른 마이그레이션 실행이 잠금을 쥐고 있다';
const DEFAULT_RETRY_DELAYS = [100, 200, 400, 800, 1600] as const;

export interface MigrationQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}

export interface MigrationClient {
  query(sql: string, params?: readonly unknown[]): Promise<MigrationQueryResult>;
}

export interface MigrationFile {
  name: string;
  path: string;
  sql: string;
  checksum: string;
  noTransaction: boolean;
  statements: string[];
  when?: number;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
}

export type MigrationErrorCode =
  | 'BAD_FILE_NAME'
  | 'DUPLICATE_NUMBER'
  | 'DOWN_NOT_SUPPORTED'
  | 'JOURNAL_MISMATCH'
  | 'CHECKSUM_DRIFT'
  | 'UNKNOWN_APPLIED'
  | 'OUT_OF_ORDER'
  | 'ADOPTION_MISMATCH'
  | 'LOCK_BUSY'
  | 'LOCK_TIMEOUT'
  | 'STATEMENT_TIMEOUT'
  | 'STATEMENT_FAILED'
  | 'DIRECT_URL_REQUIRED'
  | 'CLIENT_REQUIRED';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly file?: string;
  readonly statement?: number;

  constructor(code: MigrationErrorCode, message: string, options: { file?: string; statement?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MigrationError';
    this.code = code;
    this.file = options.file;
    this.statement = options.statement;
  }
}

export interface RunMigrationsOptions {
  client?: MigrationClient;
  dir: string;
  dryRun?: boolean;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxLockRetries?: number;
  retryDelayMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  afterMigrate?: (client: MigrationClient) => Promise<void>;
  legacy?: { table: string; kind: 'drizzle' | 'name' };
  log?: (line: string) => void;
}

export interface RunMigrationsResult {
  applied: string[];
  adopted: string[];
  pending: string[];
  dryRun: boolean;
}

export interface RoleSpec {
  outboxTable?: string;
  orderEventTable?: string;
  maintenanceTables?: string[];
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const checksumOf = (sql: string) => createHash('sha256').update(sql, 'utf8').digest('hex');

const sqlState = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
};

const quoteIdent = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new MigrationError('BAD_FILE_NAME', `안전하지 않은 식별자: ${name}`);
  return `"${name}"`;
};

const statementsOf = (sql: string, noTransaction: boolean): string[] => {
  const body = noTransaction ? sql.split('\n').slice(1).join('\n') : sql;
  if (!noTransaction) return [body.trim()].filter(Boolean);
  return body
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean);
};

const journalOf = async (dir: string): Promise<Array<{ tag: string; when?: number }> | undefined> => {
  const path = join(dir, 'meta', '_journal.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { entries?: Array<{ tag?: unknown; when?: unknown }> };
    if (!Array.isArray(parsed.entries)) throw new MigrationError('JOURNAL_MISMATCH', 'journal entries가 없다');
    return parsed.entries.map((entry) => ({
      tag: typeof entry.tag === 'string' ? entry.tag : '',
      when: typeof entry.when === 'number' ? entry.when : undefined,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('JOURNAL_MISMATCH', 'journal을 읽지 못했다', { cause: error });
  }
};

export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  } catch (error) {
    throw new MigrationError('BAD_FILE_NAME', '마이그레이션 폴더를 읽지 못했다', { cause: error });
  }
  if (names.some((name) => name.endsWith('.down.sql'))) {
    throw new MigrationError('DOWN_NOT_SUPPORTED', '되돌리기(down) 마이그레이션은 받지 않는다');
  }
  const seen = new Set<number>();
  for (const name of names) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) {
      throw new MigrationError('BAD_FILE_NAME', `마이그레이션 파일 이름이 NNNN_이름.sql 꼴이 아니다: ${name}`, { file: name });
    }
    const number = Number(name.slice(0, 4));
    if (seen.has(number)) {
      throw new MigrationError('DUPLICATE_NUMBER', `같은 번호의 마이그레이션 파일이 둘 있다: ${name}`, { file: name });
    }
    seen.add(number);
  }
  const journal = await journalOf(dir);
  if (journal) {
    const tags = journal.map((entry) => entry.tag);
    const stems = names.map((name) => name.slice(0, -4));
    if (tags.length !== stems.length || tags.some((tag, index) => tag !== stems[index])) {
      throw new MigrationError('JOURNAL_MISMATCH', 'journal과 마이그레이션 파일 이름이 다르다');
    }
  }

  const files: MigrationFile[] = [];
  for (const [index, name] of names.entries()) {
    const sql = await readFile(join(dir, name), 'utf8');
    const firstLine = sql.split('\n', 1)[0]?.trim() ?? '';
    const noTransaction = firstLine === NO_TRANSACTION_MARKER;
    files.push({
      name,
      path: join(dir, name),
      sql,
      checksum: checksumOf(sql),
      noTransaction,
      statements: statementsOf(sql, noTransaction),
      when: journal?.[index]?.when,
    });
  }
  return files;
}

export function planMigrations(
  files: MigrationFile[],
  applied: AppliedMigration[],
): { pending: MigrationFile[]; alreadyApplied: AppliedMigration[] } {
  if (applied.length > files.length) {
    throw new MigrationError('OUT_OF_ORDER', '적용 기록이 마이그레이션 파일 수보다 많다');
  }
  for (const [index, row] of applied.entries()) {
    const file = files[index];
    if (!file || row.name !== file.name) {
      if (!files.some((candidate) => candidate.name === row.name)) {
        throw new MigrationError('UNKNOWN_APPLIED', `DB에만 있는 마이그레이션 기록: ${row.name}`, { file: row.name });
      }
      throw new MigrationError('OUT_OF_ORDER', `적용 순서가 파일 순서와 다르다: ${row.name}`, { file: row.name });
    }
    if (row.checksum !== file.checksum) {
      throw new MigrationError('CHECKSUM_DRIFT', `적용한 파일의 체크섬이 다르다: ${row.name}`, { file: row.name });
    }
  }
  return { pending: files.slice(applied.length), alreadyApplied: applied };
}

export function assertDirectDatabaseUrl(url: string, options: { requireTls?: boolean } = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new MigrationError('DIRECT_URL_REQUIRED', '마이그레이션 DB 주소를 읽지 못했다', { cause: error });
  }
  if (parsed.hostname.toLowerCase().includes('pgbouncer') || parsed.searchParams.has('pgbouncer')) {
    throw new MigrationError('DIRECT_URL_REQUIRED', '마이그레이션은 PgBouncer를 거치지 않는 직접 주소로만 붙는다');
  }
  const requireTls = options.requireTls ?? true;
  if (requireTls && parsed.searchParams.get('sslmode') !== 'verify-full') {
    throw new MigrationError('DIRECT_URL_REQUIRED', '마이그레이션 DB 주소는 sslmode=verify-full이어야 한다');
  }
}

export function roleStatements(service: string, spec: RoleSpec): string[] {
  const app = quoteIdent(`${service}_app`);
  const relay = quoteIdent(`${service}_outbox_relay`);
  const maintenance = quoteIdent(`${service}_maintenance`);
  const outbox = quoteIdent(spec.outboxTable ?? 'outbox');
  const statements = [
    `GRANT SELECT ON ${outbox} TO ${relay};`,
    `GRANT UPDATE (sent_at) ON ${outbox} TO ${relay};`,
  ];
  if (spec.orderEventTable) {
    statements.push(`REVOKE UPDATE, DELETE ON ${quoteIdent(spec.orderEventTable)} FROM ${app};`);
  }
  for (const table of spec.maintenanceTables ?? []) {
    const ident = quoteIdent(table);
    statements.push(`GRANT MAINTAIN ON ${ident} TO ${maintenance};`);
    statements.push(`GRANT DELETE ON ${ident} TO ${maintenance};`);
  }
  statements.push('CREATE EXTENSION IF NOT EXISTS pgstattuple;');
  statements.push(`GRANT EXECUTE ON FUNCTION pgstattuple(regclass) TO ${maintenance};`);
  return statements;
}

const readApplied = async (client: MigrationClient): Promise<AppliedMigration[]> => {
  const result = await client.query(`SELECT name, checksum FROM ${MIGRATION_LEDGER} ORDER BY applied_at, name`);
  return result.rows.map((row) => ({ name: String(row.name), checksum: String(row.checksum) }));
};

const insertApplied = async (client: MigrationClient, file: MigrationFile): Promise<void> => {
  await client.query(`INSERT INTO ${MIGRATION_LEDGER} (name, checksum) VALUES ($1, $2)`, [file.name, file.checksum]);
};

const acquireLock = async (client: MigrationClient, options: Required<Pick<RunMigrationsOptions, 'lockTimeoutMs' | 'maxLockRetries' | 'retryDelayMs' | 'sleep'>>): Promise<void> => {
  await client.query(`SET lock_timeout = '${options.lockTimeoutMs}ms'`);
  for (let attempt = 0; attempt <= options.maxLockRetries; attempt += 1) {
    const result = await client.query('SELECT pg_try_advisory_lock($1, $2)', [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_OBJECT]);
    if (Boolean(result.rows[0]?.locked)) return;
    if (attempt < options.maxLockRetries) {
      const delay = options.retryDelayMs[Math.min(attempt, options.retryDelayMs.length - 1)] ?? 0;
      await options.sleep(delay);
    }
  }
  throw new MigrationError('LOCK_BUSY', LOCK_MESSAGE);
};

const releaseLock = async (client: MigrationClient): Promise<void> => {
  await client.query('SELECT pg_advisory_unlock($1, $2)', [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_OBJECT]).catch(() => undefined);
};

const adoptLegacy = async (
  client: MigrationClient,
  files: MigrationFile[],
  legacy: NonNullable<RunMigrationsOptions['legacy']>,
): Promise<AppliedMigration[]> => {
  const byName = new Map(files.map((file) => [file.name, file]));
  let names: string[];
  try {
    if (legacy.kind === 'name') {
      const table = quoteIdent(legacy.table);
      const result = await client.query(`SELECT name FROM ${table} ORDER BY name`);
      names = result.rows.map((row) => String(row.name));
    } else {
      if (legacy.table !== 'drizzle.__drizzle_migrations') {
        throw new MigrationError('ADOPTION_MISMATCH', `모르는 drizzle 이관 표: ${legacy.table}`);
      }
      const result = await client.query('SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at');
      const byWhen = new Map(files.filter((file) => file.when !== undefined).map((file) => [file.when as number, file.name]));
      names = result.rows.map((row) => {
        const name = byWhen.get(Number(row.created_at));
        if (!name) throw new MigrationError('ADOPTION_MISMATCH', `drizzle 적용 시각을 journal에서 찾지 못했다: ${String(row.created_at)}`);
        return name;
      });
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if (sqlState(error) === '42P01') return [];
    throw new MigrationError('ADOPTION_MISMATCH', '기존 적용 기록을 읽지 못했다', { cause: error });
  }
  const adopted: AppliedMigration[] = [];
  for (const [index, name] of names.entries()) {
    const file = byName.get(name);
    if (!file || file.name !== files[index]?.name) {
      throw new MigrationError('ADOPTION_MISMATCH', `기존 적용 기록이 파일 순서와 다르다: ${name}`, { file: name });
    }
    adopted.push({ name: file.name, checksum: file.checksum });
  }
  for (const row of adopted) {
    await client.query(`INSERT INTO ${MIGRATION_LEDGER} (name, checksum) VALUES ($1, $2)`, [row.name, row.checksum]);
  }
  return adopted;
};

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const files = await readMigrationFiles(options.dir);
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? (() => undefined);
  if (dryRun) {
    log('[dry-run] 빈 DB 가정: 적용 기록을 읽지 않는다');
    for (const file of files) {
      log(`[dry-run] ${file.name} (${file.noTransaction ? `no-transaction, ${file.statements.length}문장` : 'transaction'})`);
    }
    return { applied: [], adopted: [], pending: files.map((file) => file.name), dryRun: true };
  }
  if (!options.client) throw new MigrationError('CLIENT_REQUIRED', '마이그레이션 연결이 필요하다');
  const client = options.client;
  const lockTimeoutMs = options.lockTimeoutMs ?? 3000;
  const statementTimeoutMs = options.statementTimeoutMs ?? 30000;
  const maxLockRetries = options.maxLockRetries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAYS;
  const sleep = options.sleep ?? sleepDefault;

  await acquireLock(client, { lockTimeoutMs, maxLockRetries, retryDelayMs, sleep });
  const applied: string[] = [];
  const adopted: string[] = [];
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER} (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    let rows = await readApplied(client);
    if (rows.length === 0 && options.legacy) {
      const adoptedRows = await adoptLegacy(client, files, options.legacy);
      adopted.push(...adoptedRows.map((row) => row.name));
      rows = adoptedRows;
    }
    const plan = planMigrations(files, rows);
    const pending = [...plan.pending];
    for (const file of pending) {
      if (file.noTransaction) {
        await client.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
        await client.query(`SET statement_timeout = '${statementTimeoutMs}ms'`);
        for (const [index, statement] of file.statements.entries()) {
          for (let attempt = 0; ; attempt += 1) {
            try {
              await client.query(statement);
              break;
            } catch (error) {
              const code = sqlState(error);
              if (code === '55P03' && attempt < maxLockRetries) {
                await sleep(retryDelayMs[Math.min(attempt, retryDelayMs.length - 1)] ?? 0);
                continue;
              }
              if (code === '57014') {
                throw new MigrationError('STATEMENT_TIMEOUT', `file ${file.name}: 57014 (statement ${index + 1})`, { file: file.name, statement: index + 1 });
              }
              if (code === '55P03') {
                throw new MigrationError('LOCK_TIMEOUT', `file ${file.name}: 55P03 (statement ${index + 1})`, { file: file.name, statement: index + 1 });
              }
              throw new MigrationError('STATEMENT_FAILED', `file ${file.name}: ${code ?? 'UNKNOWN'} (statement ${index + 1})`, {
                file: file.name,
                statement: index + 1,
                cause: error,
              });
            }
          }
        }
        await insertApplied(client, file);
        applied.push(file.name);
        continue;
      }

      for (let attempt = 0; ; attempt += 1) {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
          await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
          await client.query(file.sql);
          await insertApplied(client, file);
          await client.query('COMMIT');
          applied.push(file.name);
          break;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          const code = sqlState(error);
          if (code === '55P03' && attempt < maxLockRetries) {
            await sleep(retryDelayMs[Math.min(attempt, retryDelayMs.length - 1)] ?? 0);
            continue;
          }
          if (code === '57014') {
            throw new MigrationError('STATEMENT_TIMEOUT', `file ${file.name}: 57014 (statement 1)`, { file: file.name, statement: 1 });
          }
          if (code === '55P03') {
            throw new MigrationError('LOCK_TIMEOUT', `file ${file.name}: 55P03 (statement 1)`, { file: file.name, statement: 1 });
          }
          throw new MigrationError('STATEMENT_FAILED', `file ${file.name}: ${code ?? 'UNKNOWN'} (statement 1)`, {
            file: file.name,
            statement: 1,
            cause: error,
          });
        }
      }
    }
    if (applied.length > 0 && options.afterMigrate) await options.afterMigrate(client);
    const pendingNames = files.filter((file) => !rows.some((row) => row.name === file.name) && !applied.includes(file.name)).map((file) => file.name);
    return { applied, adopted, pending: pendingNames, dryRun: false };
  } catch (error) {
    if (error instanceof MigrationError) {
      log(error.message);
      throw error;
    }
    const wrapped = new MigrationError('STATEMENT_FAILED', '마이그레이션을 적용하지 못했다', { cause: error });
    log(wrapped.message);
    throw wrapped;
  } finally {
    await releaseLock(client);
  }
}
