// 운영 경보 모듈 조립(BAT-425 GAT-130).
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, CLOCK, INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import { RecordOpsAlert } from './application/record-alert.js';
import type { OpsAlertStore } from './domain/ops-alert.js';
import { MemoryOpsAlertStore } from './adapters/memory-ops-alert-store.js';
import { DrizzleOpsAlertStore } from './adapters/db/drizzle-ops-alert-store.js';
import { InternalAlertsController } from './inbound/internal-alerts.controller.js';

export const OPS_ALERT_STORE = Symbol.for('peaket.ops.alert-store');

@Module({})
export class AlertsModule {
  static register(store: OpsAlertStore): DynamicModule {
    const providers: Provider[] = [
      { provide: OPS_ALERT_STORE, useValue: store },
      {
        provide: RecordOpsAlert,
        useFactory: (s: OpsAlertStore, clock: Clock) => new RecordOpsAlert(s, () => clock.now()),
        inject: [OPS_ALERT_STORE, CLOCK],
      },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
    ];
    return { module: AlertsModule, controllers: [InternalAlertsController], providers };
  }

  static memory(): DynamicModule {
    return AlertsModule.register(new MemoryOpsAlertStore());
  }
}
