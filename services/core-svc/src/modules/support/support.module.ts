// core-svc support 모듈(F-06-4 소명 + F-06-5 문의). 소명·문의·화면용 사본·내부 API·gRPC를 한 벌로 묶는다.
import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { UntypedServiceImplementation } from '@grpc/grpc-js';
import { CLOCK, type Clock, type Database, INTERNAL_TOKEN } from '@peaket/platform';
import { Appeals } from './application/appeals.js';
import { Inquiries } from './application/inquiries.js';
import type { AppealCaseSink, AppealStore, FanNotifier, FraudAppealClient, FraudAppealViewStore, RestrictionViewStore } from './domain/ports.js';
import type { InquiryFanNotifier, InquiryOrderDirectory, InquiryStore } from './domain/inquiry-ports.js';
import type { Holidays } from './domain/inquiry.js';
import { MemoryAppealStore, MemoryFraudAppealViewStore, MemoryRestrictionViewStore } from './adapters/memory-support.js';
import { MemoryInquiryStore } from './adapters/memory-inquiries.js';
import { DrizzleAppealStore } from './adapters/db/drizzle-appeals.js';
import { DrizzleInquiryStore } from './adapters/db/drizzle-inquiries.js';
import { HttpFraudAppealClient, type HttpFraudAppealOptions } from './adapters/http-fraud-appeals.js';
import { HttpAppealCaseSink } from './adapters/http-appeal-case-sink.js';
import { SupportController } from './inbound/support.controller.js';
import { InternalAppealsController } from './inbound/internal-appeals.controller.js';
import { InternalInquiriesController } from './inbound/internal-inquiries.controller.js';
import { supportGrpcHandlers } from './inbound/support.grpc.js';
import { inquiryGrpcHandlers } from './inbound/inquiry.grpc.js';

export const SUPPORT_KIT = Symbol.for('peaket.core.support-kit');

export interface SupportWiring {
  readonly store?: AppealStore;
  readonly views?: { readonly restriction?: RestrictionViewStore; readonly fraud?: FraudAppealViewStore };
  /** 이미 만든 클라이언트나 시작 조립이 읽은 주소 설정(시험 조립) */
  readonly fraudAppeals?: FraudAppealClient | HttpFraudAppealOptions;
  readonly caseSink?: AppealCaseSink;
  readonly notifier?: FanNotifier;
  /** F-06-5 문의 */
  readonly inquiries?: InquiryStore;
  readonly orders?: InquiryOrderDirectory;
  readonly inquiryNotifier?: InquiryFanNotifier;
  readonly holidays?: string[];
}

const isFraudClient = (v: SupportWiring['fraudAppeals']): v is FraudAppealClient => typeof (v as FraudAppealClient | undefined)?.send === 'function';

export interface SupportKit {
  readonly outbox: { rows(): Array<Record<string, unknown>> };
  readonly views: { restriction: RestrictionViewStore; fraud: FraudAppealViewStore };
  readonly appeals: { find(id: string): Promise<Record<string, unknown> | undefined> };
  readonly inquiries: {
    rows(): Array<Record<string, unknown>>;
    messages(): Array<Record<string, unknown>>;
    outbox(): Array<Record<string, unknown>>;
    failNext(op: 'saveInquiry' | 'saveMessage' | 'saveOutbox' | 'saveReply' | 'saveClose'): void;
    closeIdle(nowMs: number): Promise<number>;
  };
  failNext(op: 'saveAppeal' | 'saveResult'): void;
  dispatchOnce(nowMs: number): Promise<void>;
  readonly grpcHandlers: { bookingRestrictionView: UntypedServiceImplementation; fraudAppealView: UntypedServiceImplementation };
  readonly inquiryGrpcHandlers: UntypedServiceImplementation;
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
    const memoryInquiries = o.storage === 'memory' ? ((wiring.inquiries as MemoryInquiryStore | undefined) ?? new MemoryInquiryStore()) : undefined;
    const store: AppealStore = wiring.store ?? memoryStore ?? new DrizzleAppealStore(o.database!);
    const inquiryStore: InquiryStore = wiring.inquiries ?? memoryInquiries ?? new DrizzleInquiryStore(o.database!);
    const restrictionViews: RestrictionViewStore = wiring.views?.restriction ?? new MemoryRestrictionViewStore();
    const fraudViews: FraudAppealViewStore = wiring.views?.fraud ?? new MemoryFraudAppealViewStore();
    const fraudAppeals: FraudAppealClient | undefined = isFraudClient(wiring.fraudAppeals)
      ? wiring.fraudAppeals
      : wiring.fraudAppeals
        ? new HttpFraudAppealClient(wiring.fraudAppeals)
        : undefined;
    const caseSink: AppealCaseSink | undefined = wiring.caseSink ?? (!isFraudClient(wiring.fraudAppeals) && wiring.fraudAppeals ? new HttpAppealCaseSink(wiring.fraudAppeals) : undefined);
    const holidays: Holidays = new Set(wiring.holidays ?? []);
    return {
      module: SupportModule,
      controllers: [SupportController, InternalAppealsController, InternalInquiriesController],
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
              ...(caseSink ? { caseSink } : {}),
              ...(wiring.notifier ? { notifier: wiring.notifier } : {}),
            }),
        },
        {
          provide: Inquiries,
          inject: [CLOCK],
          useFactory: (clock: Clock) =>
            new Inquiries({
              store: inquiryStore,
              clock,
              holidays,
              ...(wiring.orders ? { orders: wiring.orders } : {}),
              ...(wiring.inquiryNotifier ? { notifier: wiring.inquiryNotifier } : {}),
            }),
        },
        {
          provide: SUPPORT_KIT,
          inject: [Appeals, Inquiries, INTERNAL_TOKEN],
          useFactory: (appeals: Appeals, inquiries: Inquiries, internalToken: string): SupportKit => {
            const grpc = supportGrpcHandlers({ restrictionViews, fraudViews, ...(internalToken ? { internalToken } : {}) });
            const inquiryGrpc = inquiryGrpcHandlers({ inquiries, ...(internalToken ? { internalToken } : {}) });
            return {
              outbox: { rows: () => (memoryStore ? memoryStore.outbox.map((r) => ({ ...r })) : []) },
              views: { restriction: restrictionViews, fraud: fraudViews },
              appeals: {
                async find(id: string) {
                  const r = await store.find(id);
                  return r ? { ...r } : undefined;
                },
              },
              inquiries: {
                rows: () => (memoryInquiries ? [...memoryInquiries.rows.values()].map((r) => ({ ...r })) : []),
                messages: () => (memoryInquiries ? memoryInquiries.messageRows.map((m) => ({ ...m })) : []),
                outbox: () => (memoryInquiries ? memoryInquiries.outbox.map((r) => ({ ...r })) : []),
                failNext: (op) => {
                  if (memoryInquiries) memoryInquiries.failNext(op);
                },
                closeIdle: (nowMs) => inquiries.closeIdle(nowMs),
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
              inquiryGrpcHandlers: inquiryGrpc,
            };
          },
        },
      ],
      exports: [SUPPORT_KIT],
    };
  }
}
