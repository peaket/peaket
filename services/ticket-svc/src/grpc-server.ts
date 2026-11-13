// 업무 gRPC 서버 시작·기다림·종료. payment-svc/identity-svc와 같은 방식(공용 옵션은 packages/platform).
import * as grpc from '@grpc/grpc-js';
import { grpcServerOptions } from '@peaket/platform';

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
