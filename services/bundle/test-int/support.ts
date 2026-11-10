// 시작 파일 시험의 도우미(BUILD_ORDER PRF-215): 실제 Valkey 8.1·PostgreSQL 18 컨테이너(docker 명령, 다른 서비스의 test-int와 같은 방식),
// 빈 포트, 시작 파일을 운영 시작 명령 그대로 띄우기(node --import @peaket/platform/telemetry/register dist/main.js), 우아한 종료.
// 서비스 dist는 시험이 처음 부를 때 그 서비스 폴더에서 tsc로 만든다(지난 빌드를 돌리지 않게, payment-process.int.test.ts와 같다).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { distProblem } from './dist-check.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVICES_DIR = join(HERE, '..', '..');
export const REPO = join(SERVICES_DIR, '..');

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const mappedPort = (id: string, port: number) => {
  const mapped = docker(['port', id, `${port}/tcp`]).split('\n')[0]!;
  return Number(mapped.slice(mapped.lastIndexOf(':') + 1));
};
const rm = (id: string) => {
  try {
    docker(['rm', '-f', '-v', id]);
  } catch {
    // 이미 없다
  }
};

export interface Container {
  url: string;
  stop(): void;
}

export function startValkey(): Container {
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::6379', 'valkey/valkey:8.1-alpine']);
  return { url: `redis://127.0.0.1:${mappedPort(id, 6379)}`, stop: () => rm(id) };
}

export interface Postgres extends Container {
  /** 같은 서버의 DB 하나를 만들고 그 주소를 돌려준다 */
  database(name: string): Promise<string>;
}

export async function startPostgres(): Promise<Postgres> {
  const id = docker(['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=bundle-test', '-e', 'POSTGRES_DB=peaket', '-p', '127.0.0.1::5432', 'postgres:18-alpine']);
  const port = mappedPort(id, 5432);
  const urlOf = (db: string) => `postgres://postgres:bundle-test@127.0.0.1:${port}/${db}`;
  const url = urlOf('peaket');
  const deadline = Date.now() + 60_000;
  for (;;) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      await c.query('select 1');
      await c.end();
      break;
    } catch (err) {
      await c.end().catch(() => {});
      if (Date.now() > deadline) {
        rm(id);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return {
    url,
    stop: () => rm(id),
    database: async (name) => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await c.query(`create database ${name}`);
      } finally {
        await c.end();
      }
      return urlOf(name);
    },
  };
}

export async function freePort(): Promise<number> {
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

export async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 60_000, every = 100): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`기다린 ${what}이(가) ${ms}ms 안에 오지 않았다`);
    await new Promise((r) => setTimeout(r, every));
  }
}

const built = new Set<string>();
/**
 * 패키지 폴더에서 tsc -p tsconfig.build.json(한 번만). 타입 오류면 그 글로 던진다.
 * CI는 앞 단계(turbo build)에서 만든 dist를 쓴다(PEAKET_START_FILES_PREBUILT=1): 다시 빌드하지 않고 dist가 src보다 새로운지만 본다(코드 리뷰, ci-node 잡 시간)
 */
export function build(dir: string): void {
  if (built.has(dir)) return;
  if (process.env.PEAKET_START_FILES_PREBUILT === '1') {
    const problem = distProblem(dir);
    if (problem) throw new Error(problem);
    built.add(dir);
    return;
  }
  try {
    execFileSync(process.execPath, [join(dir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`${dir} 빌드 실패: ${(e as { stdout?: string }).stdout ?? String(e)}`);
  }
  built.add(dir);
}

export interface Running {
  child: ChildProcess;
  /** 표준 출력·오류를 받은 차례대로 이은 글 */
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  gone(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
}

/** 패키지 폴더의 dist/main.js를 운영 시작 명령 그대로 띄운다(부모의 시험 보고서·NODE_OPTIONS 값은 넘기지 않는다) */
export function spawnMain(dir: string, env: Record<string, string | undefined>): Running {
  build(dir);
  const { PEAKET_TEST_REPORT: _r, NODE_OPTIONS: _o, ...parent } = process.env;
  const child = spawn(process.execPath, ['--import', '@peaket/platform/telemetry/register', '--import', pathToFileURL(join(HERE, 'sigterm-bridge.mjs')).href, 'dist/main.js'], {
    cwd: dir,
    env: { ...parent, OTEL_TRACES_EXPORTER: 'none', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let text = '';
  child.stdout!.on('data', (d) => (text += String(d)));
  child.stderr!.on('data', (d) => (text += String(d)));
  let left: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => {
      left = { code, signal };
      resolve(left);
    }),
  );
  return { child, output: () => text, exited, gone: () => left };
}

/** 관리 포트 /ready가 200일 때까지 기다린다(그 전에 프로세스가 끝나면 그 출력과 함께 던진다) */
export async function waitReady(r: Running, managementPort: number, ms = 90_000): Promise<void> {
  await until(
    async () => {
      const g = r.gone();
      if (g) throw new Error(`프로세스가 일찍 끝났다(${JSON.stringify(g)}): ${r.output().slice(-3000)}`);
      try {
        return (await fetch(`http://127.0.0.1:${managementPort}/ready`)).status === 200;
      } catch {
        return false;
      }
    },
    `관리 포트 ${managementPort} /ready`,
    ms,
    200,
  );
}

/** 우아한 종료를 부르고 끝날 때까지(최대 ms) 기다린다 */
export async function sigterm(r: Running, ms = 30_000): Promise<{ code: number | null; signal: NodeJS.Signals | null } | 'timeout'> {
  if (process.platform === 'win32') r.child.send('SIGTERM');
  else r.child.kill('SIGTERM');
  return Promise.race([r.exited, new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), ms))]);
}

/** 정해진 차례의 로그 줄(JSON) 가운데 조건에 맞는 것 */
export function logLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}
