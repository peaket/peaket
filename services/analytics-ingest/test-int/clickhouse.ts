// 통합 시험용 ClickHouse 컨테이너(services/ops-rt/test-int/clickhouse.ts와 같다. 자기가 띄운 컨테이너 ID만 지운다).
// 이미지는 이 PC에 받아 둔 24.12다(운영 대상 판 26.8 LTS와 다르다. 매개변수 뷰·비동기 삽입은 23.x부터 있다, F-04-1 계획 '남긴 것').
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

export const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:24.12';
export const CH_USER = 'it';
export const CH_PASSWORD = 'It-Ch-Pa55word';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export interface ClickHouseContainer {
  url: string;
  /** 문장 하나(JSON 결과면 FORMAT JSON을 붙여 쓴다) */
  query(sql: string, params?: Record<string, string>): Promise<string>;
  rows<T = Record<string, unknown>>(sql: string, params?: Record<string, string>): Promise<T[]>;
  pause(): void;
  unpause(): void;
  stop(): void;
}

export async function startClickHouse(): Promise<ClickHouseContainer> {
  const port = await freePort();
  const id = docker([
    'run', '-d',
    '-e', `CLICKHOUSE_USER=${CH_USER}`,
    '-e', `CLICKHOUSE_PASSWORD=${CH_PASSWORD}`,
    '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
    '-p', `127.0.0.1:${port}:8123`,
    '--ulimit', 'nofile=262144:262144',
    CLICKHOUSE_IMAGE,
  ]);
  const url = `http://127.0.0.1:${port}`;
  const auth = { 'x-clickhouse-user': CH_USER, 'x-clickhouse-key': CH_PASSWORD };
  const query = async (sql: string, params: Record<string, string> = {}) => {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, v);
    const res = await fetch(u, { method: 'POST', headers: auth, body: sql, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 400)}`);
    return text;
  };
  const end = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await query('SELECT 1')).trim() === '1') break;
    } catch {
      // 아직 뜨는 중
    }
    if (Date.now() > end) {
      docker(['rm', '-f', '-v', id]);
      throw new Error('ClickHouse가 120초 안에 뜨지 않았다');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    url,
    query,
    async rows<T>(sql: string, params?: Record<string, string>) {
      const body = JSON.parse(await query(`${sql} FORMAT JSON`, params)) as { data: T[] };
      return body.data;
    },
    pause: () => void docker(['pause', id]),
    unpause: () => void docker(['unpause', id]),
    stop: () => {
      try {
        docker(['rm', '-f', '-v', id]);
      } catch {
        // 이미 없다
      }
    },
  };
}
