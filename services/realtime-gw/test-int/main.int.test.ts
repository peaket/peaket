// realtime-gw 시작 파일(dist/main.js)을 운영 시작 명령 그대로(node --import @peaket/platform/telemetry/register) 자식 프로세스로 띄운다(BUILD_ORDER HOT-090, BAT-052).
// 시험 조립(start())과 따로 시작 파일의 조립을 본다: 포트 알림(peaket-ports)·준비 확인, 환경 값을 그대로 넘기는지(입장 토큰 발급자로 핸드셰이크 101),
// 필수 값 하나씩 뺌·운영 값 PEAKET_ENV의 Redis 주소 규칙(시작하지 않고 오류 글에 비밀번호 없음), SIGTERM에 1012로 닫고 스스로 끝남.
// 정본: docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '틀과 설정'·'느린 연결과 내릴 때', §12 S-T42 ⑫⑬⑲(ADR-0297 결정 5: 해제 대기 1초, 내리기 마감 10초).
// Windows는 child.kill('SIGTERM')이 처리기를 부르지 않아 IPC로 SIGTERM을 낸다(sigterm-bridge.mjs). Linux는 진짜 신호다.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { admissionToken, connect, isBatchInterval, JWKS, ISS, layoutDir, PSEUDONYM_KEY, streamPath, subscribeBytes, until } from './support.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = join(HERE, '..');
const PW = 'Main-Pw-93kq';

let valkey: ValkeyContainer;
let layout: ReturnType<typeof layoutDir>;
const children: ChildProcess[] = [];

beforeAll(async () => {
  // 지난 빌드를 돌리지 않게 처음에 빌드한다
  try {
    execFileSync(process.execPath, [join(SERVICE_DIR, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: SERVICE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  } catch (e) {
    throw new Error(`realtime-gw 빌드 실패: ${(e as { stdout?: string }).stdout ?? String(e)}`);
  }
  valkey = await startValkey();
  layout = layoutDir({ 'ev-1': 4 });
}, 300_000);

afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  valkey?.stop();
  layout?.remove();
});

interface Proc {
  child: ChildProcess;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  ports: Promise<{ app: number; management: number } | undefined>;
}

function spawnMain(env: Record<string, string | undefined>): Proc {
  const { PEAKET_TEST_REPORT: _r, NODE_OPTIONS: _o, ...parent } = process.env;
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...parent, OTEL_SERVICE_NAME: 'realtime-gw', OTEL_TRACES_EXPORTER: 'none', ...env })) if (v !== undefined) merged[k] = v;
  const child = spawn(process.execPath, ['--import', '@peaket/platform/telemetry/register', '--import', pathToFileURL(join(HERE, 'sigterm-bridge.mjs')).href, 'dist/main.js'], {
    cwd: SERVICE_DIR,
    env: merged,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let text = '';
  child.stdout!.on('data', (d) => (text += String(d)));
  child.stderr!.on('data', (d) => (text += String(d)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let resolvePorts!: (p: { app: number; management: number } | undefined) => void;
  const ports = new Promise<{ app: number; management: number } | undefined>((r) => (resolvePorts = r));
  child.on('message', (m) => {
    const msg = m as { type?: string; app?: number; management?: number };
    if (msg?.type === 'peaket-ports') resolvePorts({ app: Number(msg.app), management: Number(msg.management) });
  });
  void exited.then(() => resolvePorts(undefined));
  return { child, output: () => text, exited, ports };
}

const goodEnv = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  PEAKET_ENV: 'local',
  PORT: '0',
  PEAKET_MANAGEMENT_PORT: '0',
  PEAKET_LOG_LEVEL: 'info',
  PEAKET_LOG_PSEUDONYM_KEY: PSEUDONYM_KEY.toString('base64'),
  PEAKET_SEAT_REDIS_URL: valkey.url,
  PEAKET_SEAT_REDIS_CLUSTER_URLS: undefined,
  PEAKET_ADMISSION_JWKS: JWKS,
  PEAKET_ADMISSION_ISSUER: ISS,
  PEAKET_SEATMAP_DIR: layout.dir,
  ...over,
});

function sigterm(c: ChildProcess): void {
  if (process.platform === 'win32') c.send('SIGTERM');
  else c.kill('SIGTERM');
}

/** 시작하지 않아야 하는 프로세스: 포트를 알리지 않고 0이 아닌 코드로 끝난다 */
async function mustNotStart(env: Record<string, string | undefined>): Promise<string> {
  const p = spawnMain(env);
  const timer = setTimeout(() => p.child.kill('SIGKILL'), 30_000);
  const [ports, exit] = await Promise.all([p.ports, p.exited]);
  clearTimeout(timer);
  expect(ports).toBeUndefined();
  expect(exit.signal).toBeNull();
  expect(exit.code).not.toBe(0);
  return p.output();
}

describe('S-T42 ⑬ 시작 파일', () => {
  test(
    'S-T42 ⑬ dist/main.js가 포트를 알리고 준비 확인이 200이며, 넘긴 환경 값(발급자·JWKS·판 폴더)으로 맞는 토큰의 핸드셰이크가 101·BatchInterval 100이다',
    async () => {
      const p = spawnMain(goodEnv());
      const ports = await p.ports;
      expect(ports, p.output().slice(-2000)).toBeDefined();
      await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${ports!.management}/ready`)).status === 200;
        } catch {
          return false;
        }
      }, '/ready', 30_000, 100);
      const c = connect(`ws://127.0.0.1:${ports!.app}${streamPath('ev-1')}`, { token: admissionToken() });
      await c.opened;
      expect(await c.next(isBatchInterval)).toEqual({ type: 'batchInterval', intervalMs: 100 });
      c.ws.terminate();
      sigterm(p.child);
      expect((await p.exited).code).toBe(0);
    },
    60_000,
  );

  test(
    'S-T42 ⑬ 필수 환경 값(좌석 Redis 주소·JWKS·발급자·판 폴더)을 하나씩 빼면 시작하지 않고 오류 글에 비밀번호가 없다',
    async () => {
      const withPw = `redis://rtgw:${PW}@127.0.0.1:${valkey.port}`;
      const outs = await Promise.all(
        ['PEAKET_SEAT_REDIS_URL', 'PEAKET_ADMISSION_JWKS', 'PEAKET_ADMISSION_ISSUER', 'PEAKET_SEATMAP_DIR'].map(async (name) => [name, await mustNotStart(goodEnv({ PEAKET_SEAT_REDIS_URL: withPw, [name]: undefined }))] as const),
      );
      for (const [name, out] of outs) {
        expect(out.length, name).toBeGreaterThan(0);
        expect(out, name).not.toContain(PW);
      }
    },
    90_000,
  );

  test(
    'S-T42 ⑬ PEAKET_ENV prod·staging·demo에서 redis://·사용자 없음·default 사용자 주소로는 시작하지 않고 오류 글에 비밀번호가 없다 [ASVS v5.0.0-12.3.1] [ASVS v5.0.0-13.2.1] [ASVS v5.0.0-13.2.3]',
    async () => {
      const cases: Array<[string, string]> = [
        ['prod', `redis://rtgw:${PW}@127.0.0.1:${valkey.port}`],
        ['prod', `rediss://:${PW}@127.0.0.1:${valkey.port}`],
        ['prod', `rediss://default:${PW}@127.0.0.1:${valkey.port}`],
        ['staging', `redis://rtgw:${PW}@127.0.0.1:${valkey.port}`],
        ['demo', `redis://rtgw:${PW}@127.0.0.1:${valkey.port}`],
      ];
      const outs = await Promise.all(cases.map(async ([env, url]) => [`${env} ${url.split(':')[0]}`, await mustNotStart(goodEnv({ PEAKET_ENV: env, PEAKET_SEAT_REDIS_URL: url }))] as const));
      for (const [name, out] of outs) {
        expect(out.length, name).toBeGreaterThan(0);
        expect(out, name).not.toContain(PW);
      }
    },
    90_000,
  );
});

describe('S-T42 ⑫ SIGTERM', () => {
  test(
    'S-T42 ⑫ dist/main.js에 SIGTERM을 보내면 맺은 연결이 모두 1012로 닫히고 프로세스가 코드 0으로 스스로 끝난다',
    async () => {
      const p = spawnMain(goodEnv());
      const ports = await p.ports;
      expect(ports, p.output().slice(-2000)).toBeDefined();
      const url = `ws://127.0.0.1:${ports!.app}${streamPath('ev-1')}`;
      const a = connect(url, { token: admissionToken() });
      const b = connect(url, { token: admissionToken({ accountId: 'acct-2' }) });
      await Promise.all([a.opened, b.opened]);
      await Promise.all([a.next(isBatchInterval), b.next(isBatchInterval)]);
      sigterm(p.child);
      const [ca, cb] = await Promise.all([a.closed, b.closed]);
      expect([ca.code, cb.code]).toEqual([1012, 1012]);
      const exit = await Promise.race([p.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15_000))]);
      expect(exit, p.output().slice(-2000)).toEqual({ code: 0, signal: null });
    },
    60_000,
  );
});

describe('S-T42 ⑲ 답하지 않는 Valkey와 SIGTERM(ADR-0297 결정 5)', () => {
  test(
    'S-T42 ⑲ 구역을 구독한 연결이 있는 채 Valkey를 얼리고(docker pause) SIGTERM을 보내면 연결은 1012로 닫히고 프로세스는 10초 안에 스스로 끝난다',
    async () => {
      const p = spawnMain(goodEnv());
      const ports = await p.ports;
      expect(ports, p.output().slice(-2000)).toBeDefined();
      const ch = 's:{event:ev-1}:sec:1';
      const a = connect(`ws://127.0.0.1:${ports!.app}${streamPath('ev-1')}`, { token: admissionToken() });
      await a.opened;
      await a.next(isBatchInterval);
      a.send(subscribeBytes([1]));
      await until(() => Number(valkey.cli('PUBSUB', 'SHARDNUMSUB', ch).split('\n').at(-1)) === 1, '구역 1 구독', 20_000, 200);
      valkey.freeze();
      try {
        const sentAt = Date.now();
        sigterm(p.child);
        expect(await Promise.race([a.closed, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5_000))])).toEqual({ code: 1012, reason: 'server restart' });
        const exit = await Promise.race([p.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000 - (Date.now() - sentAt)))]);
        expect(exit, p.output().slice(-2000)).not.toBe('timeout');
        expect((exit as { signal: NodeJS.Signals | null }).signal).toBeNull();
        expect(Date.now() - sentAt).toBeLessThanOrEqual(10_000);
      } finally {
        valkey.thaw();
      }
    },
    60_000,
  );
});
