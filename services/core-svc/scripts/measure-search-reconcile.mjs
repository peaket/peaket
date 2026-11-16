// 검색 따라잡기 계산량 측정(웨이브 끝 M-1 SR-T13 ①의 따라잡기 몫, 리뷰 W7L2-K3, 계획 docs/review/plans/BAT-165.md '### 17' W7L2-K3).
// fill-search.mjs로 공연 1만·2만 [가정]을 채운 로컬 DB에서, 운영과 같은 역할 문장 상한(core_ops의 statement_timeout 5초, drizzle-sale-store.ts 머리 주석)을 건 연결로
// ① 시작 따라잡기 전체 시간과 끊음(트랜잭션)마다 시간 ② 따라잡기 동안 판매 승인 동기화(공연 하나의 sync 트랜잭션)의 대기 시간과 실패 수
// ③ 1시간 관심도 다시 세기 시간을 잰다. 결과는 JSON 한 덩어리로 찍고 --out 파일에도 쓴다.
// 끊음 하나가 상한에 닿거나(문장 시간 초과) 판매 승인 대기가 1초 [가정]를 넘으면 경고 줄을 찍는다(결과 파일에 적고 감독에게 올린다).
// 결과가 비면(끊음 0, 승인 시도 0) 끝 코드 1로 끝낸다(SKIPPED·0건이 통과로 새지 않게).
// 먼저 빌드해 둔다: pnpm --filter @peaket/core-svc build(dist를 읽는다). 환경 확인은 fill-search.mjs와 같다(ADR-0271 결정 21).
// 쓰는 법: PEAKET_ENV=local PEAKET_DATABASE_URL=postgres://…@127.0.0.1:…/peaket node scripts/measure-search-reconcile.mjs [--out 결과.json]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values } = parseArgs({ options: { out: { type: 'string' }, chunk: { type: 'string', default: '500' } } });
const url = process.env.PEAKET_DATABASE_URL;
if (!url) {
  console.error('PEAKET_DATABASE_URL이 없다');
  process.exit(2);
}
const env = process.env.PEAKET_ENV ?? '';
if (env !== 'local' && env !== 'ci') {
  console.error(`PEAKET_ENV가 local·ci가 아니라(${JSON.stringify(env)}) 재지 않는다`);
  process.exit(2);
}
// 호스트는 pg가 연결 문자열을 해석한 값(쿼리 ?host= 포함)으로 본다. 여럿·빈 값·소켓 경로는 멈춘다(fill-search.mjs와 같다, 리뷰 W7L2-S12)
/** @type {string} */
let host = '';
try {
  host = String(new pg.Client({ connectionString: url }).host ?? '');
} catch {
  host = '';
}
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`DB 호스트 ${JSON.stringify(host)}가 로컬이 아니라 재지 않는다`);
  process.exit(2);
}

/** 운영 core_ops와 같은 문장 상한(ms) */
const STATEMENT_TIMEOUT_MS = 5_000;
/** 판매 승인 대기 경고 기준(ms) [가정] */
const APPROVAL_WAIT_WARN_MS = 1_000;
const CHUNK = Number(values.chunk);

const { createDatabase } = await import('@peaket/platform');
const catalogModule = '../dist/modules/catalog/index.js';
const { DrizzleSearchReadModel } = /** @type {{ DrizzleSearchReadModel: new (db: unknown) => any }} */ (await import(catalogModule));

const limited = new URL(url);
limited.searchParams.set('options', `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`);
const base = createDatabase({ url: limited.toString(), applicationName: 'core-svc-measure-reconcile', max: 4 });
const approvals = createDatabase({ url: limited.toString(), applicationName: 'core-svc-measure-approval', max: 2 });

/** 트랜잭션마다 걸린 시간을 모으는 감싸개(따라잡기의 끊음 = 트랜잭션 하나) */
/** @type {number[]} */
const chunkMs = [];
const timed = {
  get db() {
    return base.db;
  },
  get pool() {
    return base.pool;
  },
  /**
   * @param {(tx: any) => Promise<any>} fn
   * @param {any} [o]
   */
  async transaction(fn, o) {
    const started = performance.now();
    try {
      return await base.transaction(fn, o);
    } finally {
      chunkMs.push(performance.now() - started);
    }
  },
  close: () => base.close(),
};

/** @type {{ at: string; statementTimeoutMs: number; chunkSize: number; reconcile: Record<string, unknown> | null; chunks: number[]; approvals: { tried: number; failed: number; waitsMs: number[] }; recountMs: number | null; warnings: string[] }} */
const result = { at: new Date().toISOString(), statementTimeoutMs: STATEMENT_TIMEOUT_MS, chunkSize: CHUNK, reconcile: null, chunks: [], approvals: { tried: 0, failed: 0, waitsMs: [] }, recountMs: null, warnings: [] };
try {
  const [{ ids }] = (await base.pool.query('select array(select production_id from search_document order by production_id limit 50) as ids')).rows;
  const model = new DrizzleSearchReadModel(timed);
  const syncer = new DrizzleSearchReadModel(approvals);
  // 표를 비워 처음 채우기와 같은 일을 하게 한다(임대·끝낸 시각도 비운다)
  await base.pool.query('update search_version set reconcile_owner = null, reconcile_lease_until = null, reconcile_started_at = null, reconcile_cursor = null, reconciled_at = null where id = 1');
  let running = true;
  const approvalLoop = (async () => {
    let n = 0;
    while (running && ids.length > 0) {
      const id = ids[n++ % ids.length];
      const started = performance.now();
      result.approvals.tried += 1;
      try {
        await approvals.transaction((tx) => syncer.sync(tx, [id], new Date()));
      } catch {
        result.approvals.failed += 1;
      }
      result.approvals.waitsMs.push(performance.now() - started);
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  const started = performance.now();
  const r = await model.reconcileAll(new Date(), { chunkSize: CHUNK, owner: 'measure' });
  result.reconcile = { ...r, totalMs: performance.now() - started };
  running = false;
  await approvalLoop;
  result.chunks = chunkMs;
  const recountStarted = performance.now();
  await model.recountInterest(new Date());
  result.recountMs = performance.now() - recountStarted;
  const worstChunk = Math.max(0, ...chunkMs);
  const worstWait = Math.max(0, ...result.approvals.waitsMs);
  if (worstChunk >= STATEMENT_TIMEOUT_MS * 0.8) result.warnings.push(`끊음 하나가 ${Math.round(worstChunk)}ms로 문장 상한 ${STATEMENT_TIMEOUT_MS}ms에 가깝다`);
  if (worstWait > APPROVAL_WAIT_WARN_MS) result.warnings.push(`판매 승인 동기화 대기가 ${Math.round(worstWait)}ms로 ${APPROVAL_WAIT_WARN_MS}ms를 넘었다`);
  if (result.approvals.failed > 0) result.warnings.push(`판매 승인 동기화 실패 ${result.approvals.failed}번`);
} finally {
  await base.close();
  await approvals.close();
}
const text = JSON.stringify(result, null, 1);
console.log(text);
if (values.out) writeFileSync(values.out, `${text}\n`);
for (const w of result.warnings) console.error(`경고: ${w}`);
if (!result.reconcile || result.chunks.length === 0 || result.approvals.tried === 0) {
  console.error('측정 결과가 비었다(끊음 0 또는 승인 시도 0). 실패로 적는다');
  process.exit(1);
}
