// 이미지·좌석맵 가져오기 통합 시험의 공용 도움(ADR-0257, BUILD_ORDER BAT-145).
// - seatmap-worker는 빌드한 dist/seatmap-worker/main.js를 운영 실행 명령 그대로 자식 프로세스로 띄운다(진짜 해석기·작업 스레드·gRPC 서버).
//   처음 부를 때 tsc로 빌드한다(지난 빌드를 돌리지 않게, payment-svc 프로세스 시험과 같은 방법).
// - multipart 본문은 플랫폼의 Request로 만든다(화면의 api-client와 같은 인코딩).
// - 로그는 Writable에 모아 JSON 줄로 읽는다.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVICE_DIR = join(HERE, '..');

let built = false;
/** tsc로 dist를 만든다(한 번만). 타입 오류면 그 글로 던진다 */
export function buildDist(): void {
  if (built) return;
  try {
    execFileSync(process.execPath, [join(SERVICE_DIR, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: SERVICE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`core-svc 빌드 실패: ${(e as { stdout?: string }).stdout ?? String(e)}`);
  }
  built = true;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export interface WorkerProcess {
  child: ChildProcess;
  port: number;
  address: string;
  output: () => string;
  /** seatmap_parse 기록 줄(해석 요청 하나마다 한 줄) */
  parses: () => Record<string, unknown>[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  isRunning: () => boolean;
  stop: () => Promise<void>;
}

/** 운영 실행 명령(node dist/seatmap-worker/main.js)으로 띄운다. env는 부모 환경을 거의 물려주지 않는다(자격 증명이 섞이지 않게) */
export function spawnWorker(env: Record<string, string>): Omit<WorkerProcess, 'port' | 'address'> {
  buildDist();
  const base: Record<string, string> = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k]) base[k] = process.env[k]!;
  const child = spawn(process.execPath, ['dist/seatmap-worker/main.js'], { cwd: SERVICE_DIR, env: { ...base, PEAKET_ENV: 'local', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout!.on('data', (d) => (text += String(d)));
  child.stderr!.on('data', (d) => (text += String(d)));
  let running = true;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => {
      running = false;
      resolve({ code, signal });
    }),
  );
  return {
    child,
    output: () => text,
    parses: () => logLines(text).filter((l) => l.event === 'seatmap_parse'),
    exited,
    isRunning: () => running,
    stop: async () => {
      if (!running) return;
      child.kill();
      await exited;
    },
  };
}

export async function startWorker(env: Record<string, string> = {}): Promise<WorkerProcess> {
  const port = await freePort();
  const w = spawnWorker({ PEAKET_GRPC_HOST: '127.0.0.1', PEAKET_GRPC_PORT: String(port), ...env });
  await until(() => w.output().includes('seatmap_worker_started') || !w.isRunning(), 'seatmap-worker 시작', 20_000);
  if (!w.isRunning()) throw new Error(`seatmap-worker가 뜨지 않았다: ${w.output()}`);
  return { ...w, port, address: `127.0.0.1:${port}` };
}

export function logLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 서비스 로거 목적지: 줄을 모은다 */
export function logSink(): { stream: Writable; lines: () => Record<string, unknown>[]; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  return { stream, lines: () => logLines(text), text: () => text };
}

export async function until(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000, everyMs = 25): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`기다리다 시간이 지났다: ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export interface FilePart {
  field?: string;
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** multipart/form-data 본문(경계는 undici가 정한다) */
export async function multipart(fields: Record<string, string>, files: FilePart[] = []): Promise<{ payload: Buffer; contentType: string }> {
  const fd = new FormData();
  for (const f of files) fd.append(f.field ?? 'file', new Blob([f.bytes], { type: f.type }), f.name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const req = new Request('http://local/', { method: 'POST', body: fd });
  return { payload: Buffer.from(await req.arrayBuffer()), contentType: req.headers.get('content-type')! };
}

/**
 * 바깥 연결을 세는 작은 HTTP 서버(파일 안의 주소를 서버가 부르는지 본다). 연결 수와 요청 수를 함께 센다:
 * 같은 프로세스의 fetch는 앞서 연 keep-alive 연결을 다시 쓰므로 새 연결 없이 요청만 올 수 있다
 */
export async function connectionCounter(): Promise<{ url: string; connections: () => number; requests: () => number; reset: () => void; close: () => Promise<void> }> {
  let n = 0;
  let requests = 0;
  const server: Server = createServer((_req, res) => {
    requests++;
    res.end('x');
  });
  server.on('connection', () => n++);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => n,
    requests: () => requests,
    reset: () => {
      n = 0;
      requests = 0;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const enc = (s: string) => new TextEncoder().encode(s);
