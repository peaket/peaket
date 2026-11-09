// 뿌리 모듈: 컨텍스트 모듈을 모은다. 지금은 payment뿐이다(BUILD_ORDER PRF-180).
import { type DynamicModule, Module } from '@nestjs/common';
import { PaymentModule, type PaymentModuleDeps } from './modules/payment/server.js';

@Module({})
export class AppModule {
  static register(deps: PaymentModuleDeps): DynamicModule {
    return { module: AppModule, imports: [PaymentModule.register(deps)] };
  }
}
