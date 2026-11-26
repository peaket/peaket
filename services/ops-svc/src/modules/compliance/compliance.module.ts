// 통보 모듈 조립(F-07-11). 메모리(단위·local)와 Drizzle(운영) 저장소를 고른다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, CLOCK, type Database } from '@peaket/platform';
import { MemoryComplianceNoticeStore } from './adapters/memory-compliance-notice-store.js';
import { DrizzleComplianceNoticeStore } from './adapters/db/drizzle-compliance-notice-store.js';
import { NoopComplianceAudit } from './adapters/noop-compliance-audit.js';
import { UnavailableComplianceCore } from './adapters/unavailable-compliance-core.js';
import { ComplianceNotices } from './application/compliance-notices.js';
import type { ComplianceAudit, ComplianceCore, ComplianceNoticeStore } from './domain/ports.js';
import { ComplianceNoticeController } from './inbound/compliance-notice.controller.js';

export const COMPLIANCE_STORE = Symbol('peaket.ops.compliance-store');
export const COMPLIANCE_CORE = Symbol('peaket.ops.compliance-core');
export const COMPLIANCE_AUDIT = Symbol('peaket.ops.compliance-audit');

export interface MemoryComplianceWiring {
  readonly store?: ComplianceNoticeStore;
  readonly core?: ComplianceCore;
  readonly audit?: ComplianceAudit;
}
export interface DatabaseComplianceWiring {
  readonly database: Database;
  readonly core?: ComplianceCore;
  readonly audit?: ComplianceAudit;
}

@Module({})
export class ComplianceModule {
  static register(o: ({ storage: 'memory' } & MemoryComplianceWiring) | ({ storage: 'database' } & DatabaseComplianceWiring)): DynamicModule {
    const store = o.storage === 'memory' ? (o.store ?? new MemoryComplianceNoticeStore()) : new DrizzleComplianceNoticeStore(o.database);
    const core = o.core ?? new UnavailableComplianceCore();
    const audit = o.audit ?? new NoopComplianceAudit();
    const providers: Provider[] = [
      { provide: COMPLIANCE_STORE, useValue: store },
      { provide: COMPLIANCE_CORE, useValue: core },
      { provide: COMPLIANCE_AUDIT, useValue: audit },
      {
        provide: ComplianceNotices,
        useFactory: (s: ComplianceNoticeStore, c: ComplianceCore, a: ComplianceAudit, clock: Clock) => new ComplianceNotices({ store: s, core: c, audit: a, clock }),
        inject: [COMPLIANCE_STORE, COMPLIANCE_CORE, COMPLIANCE_AUDIT, CLOCK],
      },
    ];
    return { module: ComplianceModule, controllers: [ComplianceNoticeController], providers };
  }
}
