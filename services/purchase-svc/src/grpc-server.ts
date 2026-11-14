// purchase-svc 업무 gRPC 포트 시작과 닫기(BAT-425 GAT-130, payment-svc grpc-server.ts와 같은 꼴).
// 메시 없는 로컬·CI에서는 평문이다(파드 사이 mTLS는 메시가 맡는다, ADR-0082).
import * as grpc from '@grpc/grpc-js';
import { grpcServerOptions } from '@peaket/platform';

/** 닫을 때 처리 중인 호출을 기다리는 시간. 넘으면 끊는다 [가정] */
const DRAIN_MS = 10_000;

export interface GrpcServiceBinding {
  definition: grpc.ServiceDefinition;
  handlers: grpc.UntypedServiceImplementation;
}

/** port 0이면 빈 포트를 잡고 돌려준다(시험). close는 처리 중인 호출을 10초 [가정]까지 기다리고 넘으면 끊는다 */
export async function startPurchaseGrpcServer(o: { host: string; port: number; services: GrpcServiceBinding[] }): Promise<{ port: number; close(): Promise<void> }> {
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
