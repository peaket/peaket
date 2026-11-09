// 모듈 조립 파일: 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다, BUILD_ORDER PRF-180).
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { AcceptPaymentCommand } from './application/accept-payment-command.js';
import { BatchGetPaymentStates } from './application/batch-get-payment-states.js';
import { ReceivePaymentWebhook, type ReceivePaymentWebhookDeps } from './application/receive-payment-webhook.js';
import type { PaymentCommandLog, PaymentCommandSignals, PaymentCommandStore, PaymentStateReader } from './domain/ports.js';
import { PaymentWebhookController } from './inbound/payment-webhook.controller.js';

export interface PaymentModuleDeps {
  readonly store: PaymentCommandStore;
  readonly reader: PaymentStateReader;
  readonly log: PaymentCommandLog;
  readonly signals: PaymentCommandSignals;
  /** 웹훅 받기의 포트(BUILD_ORDER HOT-150). 시계는 플랫폼 CLOCK이다 */
  readonly webhook: Omit<ReceivePaymentWebhookDeps, 'clock'>;
}

@Module({})
export class PaymentModule {
  /** 유스케이스 AcceptPaymentCommand·BatchGetPaymentStates·ReceivePaymentWebhook과 웹훅 경로를 싣는다. 시계는 플랫폼 CLOCK */
  static register(deps: PaymentModuleDeps): DynamicModule {
    return {
      module: PaymentModule,
      controllers: [PaymentWebhookController],
      providers: [
        { provide: AcceptPaymentCommand, inject: [CLOCK], useFactory: (clock: Clock) => new AcceptPaymentCommand({ store: deps.store, clock, log: deps.log, signals: deps.signals }) },
        { provide: BatchGetPaymentStates, useFactory: () => new BatchGetPaymentStates({ reader: deps.reader, signals: deps.signals }) },
        { provide: ReceivePaymentWebhook, inject: [CLOCK], useFactory: (clock: Clock) => new ReceivePaymentWebhook({ ...deps.webhook, clock }) },
      ],
    };
  }
}
