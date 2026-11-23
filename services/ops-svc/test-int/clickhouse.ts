// 통합 시험용 ClickHouse 컨테이너(postgres.ts와 같은 방식: docker 명령, 무작위 포트, 끝나면 rm -f -v).
// 이미지는 clickhouse/clickhouse-server:24.12다(대상 판 26.8 LTS가 아님, F-04-1 계획 '남긴 것'). 받는 정책은 docker 기본(없을 때만)이라 받아 둔 PC는 새로 받지 않고 CI는 받는다.
import { execFileSync } from 'node:child_process';

export const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:24.12';
const USER = 'peaket';
const PASSWORD = 'peaket-test';

export interface ClickHouseContainer {
  /** http://127.0.0.1:<포트> */
  readonly url: string;
  readonly user: string;
  readonly password: string;
  /** 문장 하나를 실행하고 본문 글을 돌려준다(실패하면 던진다) */
  exec(sql: string): Promise<string>;
  stop(): void;
}

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

export async function startClickHouse(o: { name?: string } = {}): Promise<ClickHouseContainer> {
  const prefix = process.env.PEAKET_TEST_CONTAINER_PREFIX;
  const name = o.name ?? `${prefix ?? 'ops-svc-'}ch-${Math.random().toString(36).slice(2, 8)}`;
  const id = docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-e',
    `CLICKHOUSE_USER=${USER}`,
    '-e',
    `CLICKHOUSE_PASSWORD=${PASSWORD}`,
    '-e',
    'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
    '-e',
    'TZ=UTC',
    '-p',
    '127.0.0.1::8123',
    CLICKHOUSE_IMAGE,
  ]);
  const mapped = docker(['port', id, '8123/tcp']).split('\n')[0]!;
  const url = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  const stop = () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 멈췄다
    }
  };
  const auth = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
  const exec = async (sql: string): Promise<string> => {
    const res = await fetch(`${url}/`, { method: 'POST', headers: { authorization: auth, 'content-type': 'text/plain; charset=utf-8' }, body: sql });
    const text = await res.text();
    if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 500)}`);
    return text;
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await exec('SELECT 1')).trim() === '1') break;
    } catch (err) {
      if (Date.now() > deadline) {
        stop();
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { url, user: USER, password: PASSWORD, exec, stop };
}
