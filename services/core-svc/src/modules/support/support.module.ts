// core-svc support 모듈(F-06-4). 소명·화면용 사본·내부 API·gRPC 사본 수신을 한 벌로 묶는다.
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { CLOCK, type Clock, type Database, INTERNAL_TOKEN } from '@peaket/platform';
import { Appeals } from './application/appeals.js';
import type { AppealStore, FanNotifier, FraudAppealClient, FraudAppealViewStore, RestrictionViewStore } from './domain/ports.js';
import { MemoryAppealStore, MemoryFraudAppealViewStore, MemoryRestrictionViewStore } from './adapters/memory-support.js';
import { DrizzleAppealStore } from './adapters/db/drizzle-appeals.js';
import { HttpFraudAppealClient, type HttpFraudAppealOptions } from './adapters/http-fraud-appeals.js';
import { SupportController } from './inbound/support.controller.js';
import { InternalAppealsController } from './inbound/internal-appeals.controller.js';
import { supportGrpcHandlers } from './inbound/support.grpc.js';

export const SUPPORT_KIT = Symbol.for('peaket.core.support-kit');

export interface SupportWiring {
  readonly store?: AppealStore;
  readonly views?: { readonly restriction?: RestrictionViewStore; readonly fraud?: FraudAppealViewStore };
  /** 이미 만든 클라이언트나 시작 조립이 읽은 주소 설정(시험 조립) */
  readonly fraudAppeals?: FraudAppealClient | HttpFraudAppealOptions;
  readonly notifier?: FanNotifier;
}

const isFraudClient = (v: SupportWiring['fraudAppeals']): v is FraudAppealClient => typeof (v as FraudAppealClient | undefined)?.send === 'function';

export interface SupportKit {
  readonly outbox: { rows(): Array<Record<string, unknown>> };
  readonly views: { restriction: RestrictionViewStore; fraud: FraudAppealViewStore };
  readonly appeals: { find(id: string): Promise<Record<string, unknown> | undefined> };
  failNext(op: 'saveAppeal' | 'saveResult'): void;
  dispatchOnce(nowMs: number): Promise<void>;
  readonly grpcHandlers: Record<string, unknown>;
}

export interface SupportModuleOptions {
  readonly storage: 'memory' | 'database';
  readonly database?: Database;
  readonly wiring?: SupportWiring;
}

@Global()
@Module({})
export class SupportModule {
  static register(o: SupportModuleOptions): DynamicModule {
    const wiring = o.wiring ?? {};
    const memoryStore = o.storage === 'memory' ? ((wiring.store as MemoryAppealStore | undefined) ?? new MemoryAppealStore()) : undefined;
    const store: AppealStore = wiring.store ?? memoryStore ?? new DrizzleAppealStore(o.database!);
    const restrictionViews: RestrictionViewStore = wiring.views?.restriction ?? new MemoryRestrictionViewStore();
    const fraudViews: FraudAppealViewStore = wiring.views?.fraud ?? new MemoryFraudAppealViewStore();
    const fraudAppeals: FraudAppealClient | undefined = isFraudClient(wiring.fraudAppeals)
      ? wiring.fraudAppeals
      : wiring.fraudAppeals
        ? new HttpFraudAppealClient(wiring.fraudAppeals)
        : undefined;
    return {
      module: SupportModule,
      controllers: [SupportController, InternalAppealsController],
      providers: [
        {
          provide: Appeals,
          inject: [CLOCK],
          useFactory: (clock: Clock) =>
            new Appeals({
              store,
              restrictionViews,
              fraudViews,
              clock,
              ...(fraudAppeals ? { fraudAppeals } : {}),
              ...(wiring.notifier ? { notifier: wiring.notifier } : {}),
            }),
        },
        {
          provide: SUPPORT_KIT,
          inject: [Appeals, INTERNAL_TOKEN],
          useFactory: (appeals: Appeals, internalToken: string): SupportKit => {
            const grpc = supportGrpcHandlers({ restrictionViews, fraudViews, ...(internalToken ? { internalToken } : {}) });
            return {
              outbox: { rows: () => (memoryStore ? memoryStore.outbox.map((r) => ({ ...r })) : []) },
              views: { restriction: restrictionViews, fraud: fraudViews },
              appeals: {
                async find(id: string) {
                  const r = await store.find(id);
                  return r ? { ...r } : undefined;
                },
              },
              failNext: (op) => {
                if (memoryStore) memoryStore.failNext(op);
              },
              dispatchOnce: async (nowMs: number) => {
                await appeals.dispatchOnce(nowMs);
              },
              grpcHandlers: {
                bookingRestrictionView: { SetBookingRestrictionView: grpc.SetBookingRestrictionView },
                fraudAppealView: { SetFraudAppealView: grpc.SetFraudAppealView },
              },
            };
          },
        },
      ],
      exports: [SUPPORT_KIT],
    };
  }
}
