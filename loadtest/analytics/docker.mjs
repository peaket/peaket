// F-04-8 측정 하네스의 Docker·ClickHouse 도우미(docs/review/plans/F-04-8.md §5.1).
// 통합 시험 도우미(packages/platform/test-int/containers.ts, services/*/test-int/clickhouse.ts)와 같은 이미지를 쓰되,
// loadtest는 TypeScript를 빌드하지 않고 .mjs로 돈다. 컨테이너에는 `peaket.f048=1` 이름표를 붙여 cleanup이 남의 컨테이너를 지우지 않게 한다.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';

const execFileAsync = promisify(execFile);

export const KAFKA_IMAGE = 'apache/kafka:3.9.2';
export const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:24.12';
export const CH_USER = 'it';
export const CH_PASSWORD = 'It-Ch-Pa55word';

const docker = (args, timeout = 300_000) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();

export function freePort() {
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {() => Promise<boolean>} cond @param {string} what @param {number} timeoutMs */
export async function waitFor(cond, what, timeoutMs = 120_000, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      if (await cond()) return;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`${what}이(가) ${timeoutMs}ms 안에 오지 않았다${last ? `: ${last.message}` : ''}`);
    await sleep(everyMs);
  }
}

/** @param {unknown} err */
export function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * ClickHouse HTTP 클라이언트(시험 도우미와 같은 방식). 문장 하나를 보내고 글을 돌려준다.
 * params는 {name: value}이고 서버에는 param_name으로 간다.
 */
export function clickhouseClient(url, o = {}) {
  const user = o.user ?? CH_USER;
  const password = o.password ?? CH_PASSWORD;
  const headers = { 'x-clickhouse-user': user, 'x-clickhouse-key': password };
  async function query(sql, params = {}) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, String(v));
    const res = await fetch(u, { method: 'POST', headers, body: sql, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.split('\n')[0]?.slice(0, 300) ?? ''}`);
    return text;
  }
  async function rows(sql, params = {}) {
    const body = JSON.parse(await query(`${sql} FORMAT JSON`, params));
    return body.data;
  }
  return { url, query, rows };
}

export async function startKafka(o = {}) {
  const port = await freePort();
  const runId = o.runId ?? String(Date.now());
  const env = {
    KAFKA_NODE_ID: '1',
    KAFKA_PROCESS_ROLES: 'broker,controller',
    KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
    KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
    KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
    KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
    KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
  };
  const id = docker([
    'run', '-d',
    '--label', 'peaket.f048=1',
    '--label', `peaket.f048.run=${runId}`,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-p', `127.0.0.1:${port}:9092`,
    KAFKA_IMAGE,
  ]);
  const brokers = [`127.0.0.1:${port}`];
  return {
    id,
    brokers,
    port,
    stop: () => {
      try {
        docker(['rm', '-f', '-v', id]);
      } catch {
        // 이미 없다
      }
    },
  };
}

export async function startClickHouse(o = {}) {
  const port = await freePort();
  const runId = o.runId ?? String(Date.now());
  const id = docker([
    'run', '-d',
    '--label', 'peaket.f048=1',
    '--label', `peaket.f048.run=${runId}`,
    '-e', `CLICKHOUSE_USER=${CH_USER}`,
    '-e', `CLICKHOUSE_PASSWORD=${CH_PASSWORD}`,
    '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
    '-p', `127.0.0.1:${port}:8123`,
    '--ulimit', 'nofile=262144:262144',
    CLICKHOUSE_IMAGE,
  ]);
  const url = `http://127.0.0.1:${port}`;
  const ch = clickhouseClient(url);
  try {
    await waitFor(async () => (await ch.query('SELECT 1')).trim() === '1', 'ClickHouse 기동', 120_000);
  } catch (err) {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 없다
    }
    throw err;
  }
  return {
    id,
    url,
    ch,
    query: ch.query,
    rows: ch.rows,
    pause: () => void docker(['pause', id]),
    unpause: () => void docker(['unpause', id]),
    stats: async () => {
      try {
        const { stdout } = await execFileAsync('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}', id], { timeout: 30_000 });
        const [cpu, mem] = String(stdout).trim().split(/\s+/, 2);
        return { cpuPct: Number.parseFloat(cpu), mem: mem ?? null };
      } catch {
        return { cpuPct: null, mem: null };
      }
    },
    stop: () => {
      try {
        docker(['rm', '-f', '-v', id]);
      } catch {
        // 이미 없다
      }
    },
  };
}

/** 이 저장소의 F-04-8 이름표가 붙은 컨테이너를 지운다(남의 컨테이너는 건드리지 않는다) */
export function cleanupContainers(runId) {
  const filters = ['--filter', 'label=peaket.f048=1'];
  if (runId) filters.push('--filter', `label=peaket.f048.run=${runId}`);
  let ids = '';
  try {
    ids = docker(['ps', '-aq', ...filters]);
  } catch {
    return 0;
  }
  const list = ids.split(/\s+/).filter(Boolean);
  if (list.length) docker(['rm', '-f', '-v', ...list]);
  return list.length;
}

/** 컨테이너 안에서 실행(토픽 목록·그룹 확인이 필요할 때만 쓴다) */
export function dockerExec(id, args, timeout = 60_000) {
  return docker(['exec', id, ...args], timeout);
}
