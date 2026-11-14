// 뿌리 모듈: 결제 모듈과 정산 모듈을 조립한다(BUILD_ORDER BAT-610 잔여).
import { type DynamicModule, Module } from '@nestjs/common';
import { PaymentModule, type PaymentModuleDeps } from './modules/payment/server.js';
import { SettlementModule, type SettlementModuleDeps } from './modules/settlement/index.js';

@Module({})
export class AppModule {
  static register(deps: PaymentModuleDeps & { settlement?: SettlementModuleDeps }): DynamicModule {
    const { settlement, ...payment } = deps;
    return {
      module: AppModule,
      imports: [PaymentModule.register(payment), ...(settlement ? [SettlementModule.register(settlement)] : [])],
    };
  }
}
