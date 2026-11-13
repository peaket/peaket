// ticket-svc 조립(BUILD_ORDER HOT-160). main.ts와 서비스 묶음(services/bundle)이 같은 함수를 부른다.
// gRPC 포트는 서비스 안에서 따로 열고, health/management HTTP는 플랫폼 createService가 연다.
import 'reflect-metadata';
import type { Writable } from 'node:stream';
import { createDatabase, createService, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { loadTicketServiceConfig, TICKET_DB_POOL_MAX } from './config.js';
import { startGrpcServer } from './grpc-server.js';
import { DrizzleTicketStore } from './modules/ticket/adapters/db/drizzle-ticket-store.js';
import { TicketService } from './modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from './modules/ticket/inbound/ticket.grpc.js';

const SERVICE = 'ticket-svc';

export interface StartOptions {
  env: Record<string, string | undefined>;
  logDestination?: Writable;
}

export interface StartedService {
  close(): Promise<void>;
  ports: { appPort: number; managementPort: number; grpcPort: number };
}

export async function start(o: StartOptions): Promise<StartedService> {
  const { env } = o;
  const config = loadTicketServiceConfig(env);
  const database = createDatabase({ url: config.databaseUrl, profile: 'hot', max: TICKET_DB_POOL_MAX, applicationName: SERVICE });
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let grpc: Awaited<ReturnType<typeof startGrpcServer>> | undefined;
  try {
    const store = new DrizzleTicketStore({ database });
    const ticket = new TicketService({ store, clock: systemClock });
    service = await createService({
      name: SERVICE,
      env,
      module: AppModule,
      ...(o.logDestination ? { logDestination: o.logDestination } : {}),
    });
    service.readiness.register('grpc');
    const httpPorts = await service.listen();
    grpc = await startGrpcServer({
      host: config.grpcHost,
      port: config.grpcPort,
      services: [
        {
          definition: ticketPackage().TicketService.service,
          handlers: ticketServiceHandlers({ ticket, nowMs: () => systemClock.now() }, (method, err, orderId) => {
            service!.logger.error({ method, ...(orderId ? { orderId } : {}), err }, 'TicketService 처리 실패');
          }),
        },
      ],
    });
    service.readiness.complete('grpc');
    service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

    const started = service;
    const startedGrpc = grpc;
    const ports = { appPort: httpPorts.port, managementPort: httpPorts.managementPort, grpcPort: grpc.port };
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      started.readiness.register('shutting-down');
      return (closing ??= (async () => {
        try {
          await startedGrpc.close();
          await started.close();
        } finally {
          await database.close();
        }
      })());
    };
    return { close, ports };
  } catch (err) {
    await grpc?.close().catch(() => {});
    await service?.close().catch(() => {});
    await database.close().catch(() => {});
    throw err;
  }
}
