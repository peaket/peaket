// 조사 저장소 ClickHouse HTTP(docs/streaming.md §6.4, F-04-10). 사용자는 inv_ingest(넣기만)·inv_reader(읽기만)·inv_purger(파티션 지우기만)다.
// services/analytics-ingest/src/clickhouse.ts와 같은 꼴이다(서비스끼리 가져오지 않아 따로 둔다).
// - 묶음 하나를 표마다 INSERT 한 번으로 쓴다. 중복 거르기 표시는 묶음 표시이고, 8MB를 넘는 표는 조각으로 나눈다
// - 디스크에 쓴 뒤 답한다(async_insert=1, wait_for_async_insert=1)
// - 실패(연결·시간 초과·2xx 밖)는 던진다. 실행기가 같은 묶음을 다시 보낸다
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';

/** 쓰기 사용자(docs/data.md DB 사용자) */
export const CLICKHOUSE_WRITER = 'inv_ingest';
const MAX_INSERT_BYTES = 16 * 1024 * 1024;
const INSERT_TIMEOUT_MS = 10_000;

export interface ClickHouseOptions {
  readonly baseUrl: string;
  readonly user: string;
  readonly password?: string;
  readonly timeoutCapMs?: number;
  readonly fetch?: typeof fetch;
}

export class ClickHouseHttp {
  readonly #client: ExternalHttpClient;
  readonly #auth: Record<string, string>;

  constructor(o: ClickHouseOptions) {
    this.#client = createExternalHttpClient({
      provider: 'clickhouse',
      baseUrl: o.baseUrl,
      timeoutCapMs: o.timeoutCapMs ?? INSERT_TIMEOUT_MS,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    this.#auth = { 'x-clickhouse-user': o.user, 'x-clickhouse-key': o.password ?? '' };
  }

  async exec(sql: string, settings: Readonly<Record<string, string | number>> = {}, body?: string): Promise<string> {
    const res = await this.#client.request({
      method: 'POST',
      path: '/',
      query: body === undefined ? { ...settings } : { query: sql, ...settings },
      headers: { ...this.#auth, 'content-type': 'text/plain; charset=utf-8' },
      body: body ?? sql,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.split('\n')[0]?.slice(0, 300) ?? ''}`);
    return text;
  }

  async rows<T = Record<string, unknown>>(sql: string, params: Readonly<Record<string, string>> = {}): Promise<T[]> {
    const q = Object.fromEntries(Object.entries(params).map(([k, v]) => [`param_${k}`, v]));
    const text = await this.exec(`${sql} FORMAT JSON`, q);
    return (JSON.parse(text) as { data: T[] }).data;
  }

  /** JSONEachRow로 싣는다. token이 같으면 서버가 같은 묶음을 거른다 */
  async insert(table: string, rows: readonly Record<string, unknown>[], token: string): Promise<void> {
    const lines = rows.map((r) => JSON.stringify(r));
    const chunks: string[][] = [];
    let cur: string[] = [];
    let size = 0;
    for (const l of lines) {
      const n = Buffer.byteLength(l, 'utf8') + 1;
      if (cur.length > 0 && size + n > MAX_INSERT_BYTES) {
        chunks.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(l);
      size += n;
    }
    if (cur.length > 0) chunks.push(cur);
    for (const [i, c] of chunks.entries()) {
      await this.exec(`INSERT INTO ${table} FORMAT JSONEachRow`, {
        async_insert: 1,
        wait_for_async_insert: 1,
        insert_deduplicate: 1,
        async_insert_deduplicate: 1,
        insert_deduplication_token: chunks.length === 1 ? token : `${token}:${i}`,
        date_time_input_format: 'best_effort',
        input_format_skip_unknown_fields: 1,
      }, `${c.join('\n')}\n`);
    }
  }
}
