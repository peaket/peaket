// D-T27 종료 시험의 서비스 프로세스(docs/devops.md §6.4 ①~③, BUILD_ORDER BAS-080). 빌드한 플랫폼(dist)을 쓴다(st18-child.mjs와 같은 꼴).
// 서비스 뼈대(createService) + 공용 업무 gRPC 서버(startGrpcServer) + 시작 파일의 SIGTERM 처리기(onSigterm(shutdownInOrder…)).
// 표준 출력에 JSON 한 줄씩 알린다: { ev: 'ready', grpcPort, managementPort }, { ev: 'callEnd', t }, { ev: 'closeServiceStart', t }, { ev: 'closed', t }.
// 표준 입력의 'term' 줄은 Windows용이다(Windows에서는 부모의 SIGTERM이 처리기 없이 프로세스를 끝내 SIGTERM 처리기를 부를 수 없다. 리눅스 CI는 진짜 SIGTERM을 보낸다).
// 구현 전 트리(공용 startGrpcServer·shutdownInOrder·onSigterm이 없음)에서는 서비스들이 쓰던 같은 꼴(tryShutdown, 10초 뒤 forceShutdown)로 무대를 만든다.
import 'reflect-metadata';
import { createInterface } from 'node:readline';
import * as grpc from '@grpc/grpc-js';
import { Module } from '@nestjs/common';
import * as platform from '../dist/index.js';

const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const bytes = { requestSerialize: (b) => b, requestDeserialize: (b) => b, responseSerialize: (b) => b, responseDeserialize: (b) => b };
export const SLOW_DEF = { Slow: { path: '/peaket.test.v1.SlowService/Slow', requestStream: false, responseStream: false, ...bytes } };

class ShutdownModule {}
Module({})(ShutdownModule);

const service = await platform.createService({
  name: 'shutdown-svc',
  module: ShutdownModule,
  env: { PEAKET_ENV: 'ci', PORT: '0', PEAKET_MANAGEMENT_PORT: '0', PEAKET_LOG_LEVEL: 'warn' },
});

const handlers = {
  Slow: (call, cb) => {
    const ms = Number(call.request.toString());
    setTimeout(() => {
      say({ ev: 'callEnd', t: Date.now() });
      cb(null, Buffer.from(`done-${ms}`));
    }, ms);
  },
};

async function legacyGrpcServer() {
  const server = new grpc.Server();
  server.addService(SLOW_DEF, handlers);
  const port = await new Promise((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  return {
    port,
    close: () =>
      new Promise((res) => {
        const timer = setTimeout(() => {
          server.forceShutdown();
          res();
        }, 10_000);
        server.tryShutdown(() => {
          clearTimeout(timer);
          res();
        });
      }),
  };
}

const grpcServer = platform.startGrpcServer
  ? await platform.startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: SLOW_DEF, handlers }], profile: service.config.grpcLbProfile, metrics: service.metrics })
  : await legacyGrpcServer();

const steps = {
  stop: () => [grpcServer.close()],
  closeService: async () => {
    say({ ev: 'closeServiceStart', t: Date.now() });
    await service.close();
  },
  closeConnections: () => [],
  onError: (err) => say({ ev: 'error', message: String(err?.message ?? err) }),
};
const inOrder = platform.shutdownInOrder ?? (async (s) => {
  for (const make of [() => s.stop(), () => [s.closeService()], () => s.closeConnections()]) for (const r of await Promise.allSettled(make())) if (r.status === 'rejected') s.onError(r.reason);
});
const onTerm = platform.onSigterm ?? ((fn) => process.once('SIGTERM', () => void fn()));
onTerm(async () => {
  await inOrder(steps);
  say({ ev: 'closed', t: Date.now() });
  input.close();
  process.stdin.destroy();
});

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim() === 'term') process.emit('SIGTERM');
});

const ports = await service.listen('127.0.0.1');
say({ ev: 'ready', grpcPort: grpcServer.port, managementPort: ports.managementPort });
