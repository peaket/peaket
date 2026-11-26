// ops 예매 제한 모듈(F-06-4). 저장소·사본·엔진을 만들고 승인 수명주기에 실행기·대상을 꽂는다.
// CS 소명 연결은 같은 저장소·엔진 참조를 CasesModule이 쓴다(engineRef).
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { CLOCK, type Clock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import type { AuditChain } from '../audit/index.js';
import { ApprovalLifecycle } from '../approvals/index.js';
import { BookingRestrictions } from './application/booking-restrictions.js';
import type { RestrictionRow } from './domain/booking-restriction.js';
import type { OpsRestrictionsWiring, RestrictionCopies } from './domain/ports.js';
import { MemoryBookingRestrictionStore } from './adapters/memory-restrictions.js';
import { DrizzleBookingRestrictionStore } from './adapters/db/drizzle-restrictions.js';

export const RESTRICTION_KIT = Symbol.for('peaket.ops.restriction-kit');

export interface RestrictionKitSeed {
  restrictionId?: string;
  approvalId?: string | null;
  accountId: string;
  reasonCode?: string;
  fraudCaseId?: string | null;
  confirmedBy?: string | null;
  startsAtMs?: number;
  endsAtMs?: number;
  appealDueAtMs?: number;
  status?: RestrictionRow['status'];
  version?: number;
  deliveryDone?: boolean;
  copyNextAtMs?: number | null;
  copyAttempts?: number;
}

export interface RestrictionKit {
  readonly engine: BookingRestrictions;
  rows(): RestrictionRow[];
  seed(row: RestrictionKitSeed): void;
  tick(nowMs?: number): Promise<void>;
}

const unavailableCopies: RestrictionCopies = {
  async queue() { throw new Error('restriction copies not wired'); },
  async purchase() { throw new Error('restriction copies not wired'); },
  async view() { throw new Error('restriction copies not wired'); },
};

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RestrictionsModuleOptions {
  readonly storage: 'memory' | 'database';
  readonly database?: Database;
  readonly deps?: OpsRestrictionsWiring;
  readonly audit?: AuditChain;
}

@Global()
@Module({})
export class RestrictionsModule {
  static register(o: RestrictionsModuleOptions): DynamicModule {
    const deps = o.deps;
    const memory = deps?.store instanceof MemoryBookingRestrictionStore ? deps.store : o.storage === 'memory' ? new MemoryBookingRestrictionStore() : undefined;
    const store = deps?.store ?? memory ?? new DrizzleBookingRestrictionStore(o.database!);
    return {
      module: RestrictionsModule,
      providers: [
        {
          provide: RESTRICTION_KIT,
          inject: [ApprovalLifecycle, CLOCK],
          useFactory: (lifecycle: ApprovalLifecycle, clock: Clock): RestrictionKit => {
            const engine = new BookingRestrictions({ store, copies: deps?.copies ?? unavailableCopies, clock, ...(o.audit ? { audit: o.audit } : {}) });
            if (deps?.engineRef) deps.engineRef.current = engine;
            lifecycle.configure({
              targets: {
                basis: async (kind, targetRef) => {
                  if (kind !== 'BOOKING_RESTRICTION') return undefined;
                  if (!uuidRe.test(targetRef)) return undefined;
                  return { targetAccountId: targetRef };
                },
                changed: async (kind) => (kind === 'BOOKING_RESTRICTION' ? 'OK' : 'TARGET_CHANGED'),
              },
              executors: {
                restriction: async (i) => engine.execute(i),
              },
            });
            return {
              engine,
              rows: () => (memory ? [...memory.rowsById.values()].map((r) => ({ ...r })) : []),
              seed: (input) => {
                const now = clock.now();
                const row: RestrictionRow = {
                  restrictionId: input.restrictionId ?? randomUUID(),
                  approvalId: input.approvalId ?? null,
                  accountId: input.accountId,
                  reasonCode: input.reasonCode ?? 'ABUSE_CANCEL',
                  fraudCaseId: input.fraudCaseId ?? null,
                  confirmedBy: input.confirmedBy ?? null,
                  startsAtMs: input.startsAtMs ?? now - 3_600_000,
                  endsAtMs: input.endsAtMs ?? now + 30 * 86_400_000,
                  appealDueAtMs: input.appealDueAtMs ?? now + 86_400_000,
                  status: input.status ?? 'ACTIVE',
                  version: input.version ?? 1,
                  deliveryDone: input.deliveryDone ?? true,
                  copyNextAtMs: input.copyNextAtMs ?? null,
                  copyAttempts: input.copyAttempts ?? 0,
                };
                void store.seed(row);
              },
              tick: async () => {
                await lifecycle.tick();
                await engine.expireDue();
                await engine.resyncIfDue();
              },
            };
          },
        },
      ],
      exports: [RESTRICTION_KIT],
    };
  }
}
