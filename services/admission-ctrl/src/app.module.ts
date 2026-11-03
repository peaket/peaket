// admission-ctrl 앱 모듈: 리더 루프와 묶음 게시. 앱 포트에 내는 API는 아직 없다(제어 gRPC는 BUILD_ORDER OPS-300).
import { type DynamicModule, Module } from '@nestjs/common';
import { LeaderModule, type LeaderModuleOptions } from './modules/leader/index.js';

@Module({})
export class AppModule {
  static register(o: LeaderModuleOptions): DynamicModule {
    return { module: AppModule, imports: [LeaderModule.register(o)] };
  }
}
