// 뿌리 모듈(BUILD_ORDER HOT-090). HTTP 경로는 두지 않는다: 앱 포트는 좌석 델타 WebSocket 업그레이드만 받고,
// 업그레이드가 아닌 요청은 모두 404, TRACE는 405로 답한다(docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '지표와 로그', ASVS v5.0.0-13.4.3~13.4.5).
// 업그레이드 처리기는 앱 HTTP 서버에 붙인다(v0 delta-socket.ts의 HttpAdapterHost 꼴).
import { type BeforeApplicationShutdown, type DynamicModule, Inject, Injectable, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import type { StreamGateway } from './modules/stream/index.js';

export const STREAM_GATEWAY = Symbol.for('peaket.realtime-gw.streamGateway');

@Injectable()
class StreamUpgradeBinding implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(STREAM_GATEWAY) private readonly gateway: StreamGateway,
  ) {}

  onModuleInit(): void {
    // 경로를 붙이기(listen) 전에 건다. TRACE는 경로가 없어도 405다(그 밖의 업그레이드 아닌 요청은 경로가 없어 404)
    const http = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();
    http.addHook('onRequest', (request, reply, done) => {
      if (request.method === 'TRACE') {
        void reply.status(405).header('content-length', '0').send();
        return;
      }
      done();
    });
  }

  onApplicationBootstrap(): void {
    this.adapterHost.httpAdapter.getHttpServer().on('upgrade', this.gateway.onUpgrade);
  }

  /** HTTP 서버가 닫히기 전에 연결을 닫는다(서버 닫기는 업그레이드된 소켓이 끊기기를 기다린다) */
  async beforeApplicationShutdown(): Promise<void> {
    this.adapterHost.httpAdapter.getHttpServer().off('upgrade', this.gateway.onUpgrade);
    await this.gateway.shutdown();
  }
}

@Module({})
export class AppModule {
  static register(o: { gateway: StreamGateway }): DynamicModule {
    return {
      module: AppModule,
      providers: [{ provide: STREAM_GATEWAY, useValue: o.gateway }, StreamUpgradeBinding],
    };
  }
}
