// 검사 실행(docs/verification.md §2.5, openspec 변경 add-invariant-checker-and-pg-simulator 결정 1·2·4).
// 1) 검사 연결에 임시 표를 만들고 시각 기준·한도를 넣는다
// 2) 원본 DB마다 REPEATABLE READ READ ONLY 트랜잭션 하나로 고정 목록의 칸만 읽어 임시 표에 옮긴다(원본에 없는 표는 '없음'으로 둔다)
// 3) 시험 기록을 싣는다 4) 불변식 SQL마다 위반 행을 센다
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { INVARIANTS } from './invariants.js';
import type { TestRecords } from './records.js';
import { DETAIL_LIMIT, type InvariantResult } from './report.js';
import { SOURCE_TABLES, SOURCES, type SourceName } from './tables.js';

export interface CheckOptions {
  /** 임시 표를 만들 연결(연결된 상태). 검사가 끝나도 닫지 않는다 */
  check: pg.ClientBase;
  /** 원본 DB 연결. 없는 원본을 쓰는 불변식은 SKIPPED */
  sources: Partial<Record<SourceName, pg.ClientBase>>;
  /** 없으면 기록을 쓰는 불변식은 SKIPPED */
  records?: TestRecords;
  clock?: { now(): number };
  /** 승인 뒤 큐 등록 시한. 기본 60초 [가정](ADR-0106) */
  enqueueWithinMs?: number;
  /** 발권 기한. 기본 30분 [가정](ADR-0106) */
  issueDeadlineMs?: number;
}

export interface CheckRun {
  asOf: number;
  results: InvariantResult[];
}

const sqlFile = (name: string) => readFileSync(new URL(`../sql/${name}`, import.meta.url), 'utf8');
const CHUNK = 2_000;
// 원본 값은 글자 그대로 받아 임시 표의 형으로 바꾼다(날짜를 JS Date로 바꾸며 시간대가 끼어들지 않게). json·jsonb만 풀어 둔다
const JSON_OIDS = new Set([114, 3802]);
const RAW_TYPES = { getTypeParser: (oid: number) => (JSON_OIDS.has(oid) ? (v: string) => JSON.parse(v) as unknown : (v: string) => v) };
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function insertRows(check: pg.ClientBase, table: string, columns: readonly string[], rows: readonly object[]) {
  const cols = columns.map(ident).join(', ');
  for (let i = 0; i < rows.length; i += CHUNK) {
    await check.query(`INSERT INTO pg_temp.${ident(table)} (${cols}) SELECT ${cols} FROM json_populate_recordset(NULL::pg_temp.${ident(table)}, $1::json)`, [
      JSON.stringify(rows.slice(i, i + CHUNK)),
    ]);
  }
}

export async function runInvariantChecks(o: CheckOptions): Promise<CheckRun> {
  const asOf = (o.clock ?? { now: () => Date.now() }).now();
  const { check } = o;
  // 같은 연결이면 원본 읽기가 이름이 같은 임시 표(pg_temp가 먼저 찾힌다)를 읽어 빈 표를 센다. 같은 DB라도 연결은 따로 연다
  if (Object.values(o.sources).includes(check)) throw new Error('검사 연결과 원본 연결은 같은 연결 객체일 수 없다(같은 DB면 연결을 따로 연다)');
  // 위반 행에 찍는 시각을 KST로 고정한다(검사 연결 하나에만 건다). 날짜 판정(M5)은 SQL이 Asia/Seoul로 직접 바꾼다
  await check.query("SET TIME ZONE 'Asia/Seoul'");
  await check.query(sqlFile('tables.sql'));
  await check.query('INSERT INTO pg_temp.inv_params VALUES ($1::timestamptz, make_interval(secs => $2::double precision), make_interval(secs => $3::double precision))', [
    new Date(asOf).toISOString(),
    (o.enqueueWithinMs ?? 60_000) / 1000,
    (o.issueDeadlineMs ?? 30 * 60_000) / 1000,
  ]);

  const loaded = new Set<string>();
  const missingSources = new Set<SourceName>();
  for (const source of SOURCES) {
    const src = o.sources[source];
    if (!src) {
      missingSources.add(source);
      continue;
    }
    await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      // 값을 글자 그대로 옮기므로 원본 세션의 날짜 표기를 ISO로 고정한다(DateStyle이 SQL·DMY면 날짜가 틀어진다, 새 맥락 리뷰 2)
      await src.query("SET LOCAL DateStyle = 'ISO, YMD'");
      for (const t of SOURCE_TABLES.filter((x) => x.source === source)) {
        const exists = await src.query<{ r: string | null }>('SELECT to_regclass($1)::text AS r', [t.name]);
        if (!exists.rows[0]?.r) continue;
        const res = await src.query({ text: `SELECT ${t.columns.map(ident).join(', ')} FROM ${ident(t.name)}`, types: RAW_TYPES });
        await insertRows(check, t.name, t.columns, res.rows as object[]);
        loaded.add(t.name);
      }
    } finally {
      await src.query('COMMIT');
    }
  }

  if (o.records) {
    const r = o.records;
    await insertRows(check, 'rec_queue_entry', ['event_id', 'account_ref', 'request_id', 'result', 'seq', 'generation', 'started_at', 'ended_at'], r.queue_entry);
    await insertRows(check, 'rec_queue_admit', ['event_id', 'account_ref', 'request_id', 'result', 'seq', 'generation', 'started_at', 'ended_at'], r.queue_admit);
    await insertRows(check, 'rec_queue_serving', ['event_id', 'serving', 'observed_at'], r.queue_serving);
    await insertRows(check, 'rec_pg_charge', ['pg', 'payment_ref', 'order_ref', 'amount', 'status', 'approved_at', 'canceled_amount'], r.pg_charge);
  }

  const results: InvariantResult[] = [];
  for (const def of INVARIANTS) {
    const sourceNames = [...new Set(def.requires.map((t) => SOURCE_TABLES.find((x) => x.name === t)!.source))].sort();
    const sources = [...(def.records ? ['records'] : []), ...sourceNames];
    const base = { id: def.id, name: def.name, sources, violations: 0, unknown: 0, details: [] };
    const noSource = sourceNames.filter((s) => missingSources.has(s));
    const noTable = def.requires.filter((t) => !loaded.has(t) && !noSource.includes(SOURCE_TABLES.find((x) => x.name === t)!.source));
    if (def.records && !o.records) {
      results.push({ ...base, result: 'SKIPPED', reason: '시험 기록 없음' });
      continue;
    }
    if (noSource.length) {
      results.push({ ...base, result: 'SKIPPED', reason: `원본 없음: ${noSource.join(', ')}` });
      continue;
    }
    if (noTable.length) {
      results.push({ ...base, result: 'SKIPPED', reason: `원본에 표 없음: ${noTable.join(', ')}` });
      continue;
    }
    const r = await check.query<{ subject: string; detail: string }>(sqlFile(def.file));
    const unknown = def.unknownSql ? (await check.query<{ n: number }>(def.unknownSql)).rows[0]!.n : 0;
    const violations = r.rows.length;
    results.push({
      ...base,
      violations,
      unknown,
      result: violations > 0 ? 'FAIL' : 'PASS',
      details: r.rows.slice(0, DETAIL_LIMIT).map((x) => ({ subject: String(x.subject), detail: String(x.detail) })),
    });
  }
  return { asOf, results };
}
