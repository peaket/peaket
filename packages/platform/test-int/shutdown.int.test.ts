// D-T27 우아한 종료를 따로 띄운 서비스 프로세스로 본다(docs/devops.md §6.4 ①~③·D-T27, ADR-0082, ADR-0303 결정 1, BUILD_ORDER BAS-080). Docker는 쓰지 않는다.
// 2초 걸리는 gRPC 호출을 처리하는 중에 SIGTERM을 보낸다: 그 호출은 OK로 끝나고, 새 호출은 받지 않으며, 관리 포트 /ready는 바로 503(shutting-down)·/livez는 200,
// 앱 닫기는 gRPC 마감(처리 중 호출의 끝)보다 먼저 시작하지 않고, 프로세스는 끝 코드 0으로 12초 안에 끝난다.
// 리눅스(CI)는 진짜 SIGTERM을 보낸다. Windows는 처리기를 부르는 신호를 보낼 수 없어 자식에게 'term' 줄을 보내 같은 처리기를 부른다(shutdown-child.mjs).
// 자식은 빌드한 플랫폼(dist)을 쓴다: 먼저 pnpm --filter @peaket/platform build.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { afterEach, expect, test } from 'vitest';

type Ev = { ev: string; t?: number; grpcPort?: number; managementPort?: number; message?: string };

const bytes = { requestSerialize: (b: Buffer) => b, requestDeserialize: (b: Buffer) => b, responseSerialize: (b: Buffer) => b, responseDeserialize: (b: Buffer) => b };
const Client = grpc.makeGenericClientConstructor({ Slow: { path: '/peaket.test.v1.SlowService/Slow', requestStream: false, responseStream: false, ...bytes } } as unknown as grpc.ServiceDefinition, 'SlowService');

const children: ChildProcessWithoutNullStreams[] = [];
const clients: grpc.Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

function startChild() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./shutdown-child.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const events: Ev[] = [];
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += String(d)));
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      events.push(JSON.parse(line) as Ev);
    } catch {
      // 서비스 로그 줄(JSON이지만 ev가 없다)도 여기 온다
    }
  });
  const exited = new Promise<{ code: number | null; at: number }>((res) => child.on('exit', (code) => res({ code, at: Date.now() })));
  return { child, events, exited, stderr: () => stderr };
}

const until = async <T>(what: string, get: () => T | undefined, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`기다림 한도: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function call(port: number, body: string, deadlineMs: number) {
  const c = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as grpc.Client & Record<string, (req: Buffer, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, r?: Buffer) => void) => void>;
  clients.push(c);
  return new Promise<{ code: number; body?: string; at: number }>((resolve) => {
    c.Slow!(Buffer.from(body), new grpc.Metadata(), { deadline: Date.now() + deadlineMs }, (err, res) => resolve(err ? { code: err.code, at: Date.now() } : { code: grpc.status.OK, body: res!.toString(), at: Date.now() }));
  });
}

const term = (child: ChildProcessWithoutNullStreams) => (process.platform === 'win32' ? child.stdin.write('term\n') : child.kill('SIGTERM'));

test('D-T27_2초호출을처리하는중에SIGTERM을받으면_그호출은OK로끝나고_새호출은실패하며_ready는바로503·livez는200_끝코드0으로12초안에끝난다', { timeout: 60_000 }, async () => {
  const s = startChild();
  const ready = await until('자식 준비', () => s.events.find((e) => e.ev === 'ready'), 45_000).catch((e: Error) => {
    throw new Error(`${e.message}\n${s.stderr()}`);
  });
  const mgmt = `http://127.0.0.1:${ready.managementPort}`;
  expect((await fetch(`${mgmt}/ready`)).status).toBe(200);

  const inflight = call(ready.grpcPort!, '2000', 15_000);
  await new Promise((r) => setTimeout(r, 300));
  const termAt = Date.now();
  term(s.child);
  // SIGTERM 직후(처리 중 호출이 아직 돈다) 준비 상태는 내려가고 생존은 그대로다
  await new Promise((r) => setTimeout(r, 150));
  const r = await fetch(`${mgmt}/ready`);
  expect(r.status).toBe(503);
  expect(await r.json()).toMatchObject({ status: 'shutting-down', pending: expect.arrayContaining(['shutting-down']) });
  expect((await fetch(`${mgmt}/livez`)).status).toBe(200);
  // 새 호출은 받지 않는다
  const late = await call(ready.grpcPort!, '1', 1_500);
  expect(late.code).not.toBe(grpc.status.OK);

  const done = await inflight;
  expect(done).toMatchObject({ code: grpc.status.OK, body: 'done-2000' });
  const exit = await s.exited;
  expect(exit.code, s.stderr()).toBe(0);
  expect(exit.at - termAt).toBeLessThan(12_000);
  expect(s.events.filter((e) => e.ev === 'error')).toEqual([]);
});

test('D-T27_종료차례의앱닫기는_gRPC마감(처리중호출의끝)보다먼저시작하지않는다', { timeout: 60_000 }, async () => {
  const s = startChild();
  const ready = await until('자식 준비', () => s.events.find((e) => e.ev === 'ready'), 45_000);
  const inflight = call(ready.grpcPort!, '2000', 15_000);
  await new Promise((r) => setTimeout(r, 300));
  term(s.child);
  expect((await inflight).code).toBe(grpc.status.OK);
  await s.exited;
  const callEnd = s.events.find((e) => e.ev === 'callEnd');
  const closeStart = s.events.find((e) => e.ev === 'closeServiceStart');
  expect(callEnd, '호출 끝 기록').toBeDefined();
  expect(closeStart, '앱 닫기 기록').toBeDefined();
  expect(closeStart!.t!).toBeGreaterThanOrEqual(callEnd!.t!);
  expect(s.events.some((e) => e.ev === 'closed')).toBe(true);
});
