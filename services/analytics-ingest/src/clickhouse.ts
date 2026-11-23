// ClickHouse HTTP 쓰기(docs/streaming.md §4.4 적재 설정 'analytics-ingest' 칸, OPS-200, F-04-3). 사용자는 bronze_writer(브론즈 쓰기만, §2.3)다.
// services/ops-rt/src/clickhouse.ts와 같은 꼴이다(서비스끼리 가져오지 않아 따로 둔다). 묶음 크기 상한만 다르다(16MB).
// - 묶음 하나를 표마다 INSERT 한 번으로 쓴다. 중복 거르기 표시는 묶음 표시(`<토픽>:<파티션>:<첫>:<끝>`)이고, 표가 달라도 같은 표시를 쓴다
//   (표시는 표마다 따로 본다). 8MB를 넘는 표는 조각으로 나눠 `<표시>:<조각 번호>`를 쓴다
// - 디스크에 쓴 뒤 답한다(async_insert=1, wait_for_async_insert=1). wait_for_async_insert=0은 쓰지 않는다(§4.4)
// - 실패(연결·시간 초과·2xx 밖)는 던진다. 실행기가 같은 묶음을 다시 보낸다(§2.4)
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';

/** 쓰기 사용자(docs/security/secrets-and-keys.md) */
export const CLICKHOUSE_WRITER = 'bronze_writer';
/** 묶음 크기 상한 16MB(§4.4 analytics-ingest) */
export const MAX_INSERT_BYTES = 16 * 1024 * 1024;
/** 쓰기 하나의 상한 [가정](다시 시도가 받는다) */
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

  /** 문장 하나를 보낸다. 2xx가 아니면 첫 줄만 담아 던진다(본문에 행 값이 없다) */
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

  /** JSONEachRow로 싣는다(§4.4 서버 설정). token이 같으면 서버가 같은 묶음을 거른다 */
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
      }, `${c.join('\n')}\n`);
    }
  }
}
