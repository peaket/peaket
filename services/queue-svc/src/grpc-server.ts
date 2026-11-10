// 업무 gRPC 포트 시작과 닫기(trust-svc·identity-svc와 같은 모양). queue-svc의 첫 업무 gRPC 포트다(VerificationAppealService, BUILD_ORDER BOT-090).
// 공용 서버 시작·우아한 종료(D-T27)는 BUILD_ORDER BAS-080이 packages/platform에 두고, 그때 이 파일을 그것으로 바꾼다.
// 메시 없는 로컬·CI에서는 평문이다(파드 사이 mTLS는 메시가 맡는다, ADR-0082).
import * as grpc from '@grpc/grpc-js';
import { grpcServerOptions } from '@peaket/platform';

/** 닫을 때 처리 중인 호출을 기다리는 시간. 넘으면 끊는다 [가정] */
const DRAIN_MS = 10_000;

export interface GrpcServiceBinding {
  definition: grpc.ServiceDefinition;
  handlers: grpc.UntypedServiceImplementation;
}

export async function startGrpcServer(o: { host: string; port: number; services: GrpcServiceBinding[] }): Promise<{ port: number; close(): Promise<void> }> {
  const server = new grpc.Server(grpcServerOptions('service'));
  for (const s of o.services) server.addService(s.definition, s.handlers);
  const port = await new Promise<number>((res, rej) => server.bindAsync(`${o.host}:${o.port}`, grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  return {
    port,
    close: () =>
      new Promise<void>((res) => {
        const timer = setTimeout(() => {
          server.forceShutdown();
          res();
        }, DRAIN_MS);
        timer.unref();
        server.tryShutdown(() => {
          clearTimeout(timer);
          res();
        });
      }),
  };
}
