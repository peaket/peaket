// ClickHouse HTTP 부르기(마감 실행기, F-04-6). 값은 질의 매개변수({name:Type}, HTTP param_*)로만 넘기고 SQL 글에 잇지 않는다(analytics §4.1 'SQL 규칙').
// 바깥 호출은 공용 클라이언트(@peaket/platform createExternalHttpClient, ASVS 15.3.2)로 한다.
import { createExternalHttpClient } from '@peaket/platform';

export interface ClickHouseConfig {
  url: string;
  user: string;
  password: string;
  /** 호출마다의 시간 초과(docs/architecture.md §5 '시간 초과 기본값') */
  timeoutMs?: number;
}

export interface ClickHouse {
  query<T = Record<string, unknown>>(sql: string, params?: Record<string, string | number>): Promise<T[]>;
  command(sql: string, params?: Record<string, string | number>): Promise<void>;
  /** JSONEachRow 본문을 그대로 싣는다. 쓴 행 수를 돌려준다 */
  insertJsonEachRow(table: string, body: string, settings?: Record<string, string | number>): Promise<number>;
}

export class ClickHouseError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

const TABLE = /^[a-z_]+\.[a-z_0-9]+$/;

export function clickHouseHttp(cfg: ClickHouseConfig, fetchImpl?: typeof fetch): ClickHouse {
  const client = createExternalHttpClient({ provider: 'clickhouse', baseUrl: cfg.url.replace(/\/$/, ''), timeoutCapMs: cfg.timeoutMs ?? 30_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const headers = { 'x-clickhouse-user': cfg.user, 'x-clickhouse-key': cfg.password, 'content-type': 'text/plain; charset=utf-8' };
  async function call(sql: string, params: Record<string, string | number>, body?: string, settings: Record<string, string | number> = {}): Promise<Response> {
    const query: Record<string, string | number> = { query: sql, ...settings };
    for (const [k, v] of Object.entries(params)) query[`param_${k}`] = v;
    const res = await client.request({ method: 'POST', path: '/', query, headers, body: body ?? '' });
    if (!res.ok) {
      const text = await res.text();
      const m = /Code: (\d+)/.exec(text);
      throw new ClickHouseError(res.status, m ? Number(m[1]) : null, text.split('\n')[0]?.slice(0, 300) ?? '');
    }
    return res;
  }
  return {
    async query<T>(sql: string, params: Record<string, string | number> = {}): Promise<T[]> {
      const res = await call(`${sql} FORMAT JSON`, params);
      const json = (await res.json()) as { data: T[] };
      return json.data;
    },
    async command(sql, params = {}) {
      await (await call(sql, params)).text();
    },
    async insertJsonEachRow(table, body, settings = {}) {
      if (!TABLE.test(table)) throw new Error('표 이름이 틀렸다');
      const res = await call(`INSERT INTO ${table} FORMAT JSONEachRow`, {}, body, settings);
      await res.text();
      const summary = res.headers.get('x-clickhouse-summary');
      return summary ? Number((JSON.parse(summary) as { written_rows?: string }).written_rows ?? 0) : 0;
    },
  };
}
