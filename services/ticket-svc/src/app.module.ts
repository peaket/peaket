// 뿌리 모듈: ticket 모듈의 gRPC 처리기와 스캐너 기기 HTTP 경로를 조립한다(BUILD_ORDER HOT-160·GAT-170).
import { type DynamicModule, Module } from '@nestjs/common';
import { ScannerModule, type ScannerWiring } from './modules/scanner/index.js';

@Module({})
export class AppModule {
  /** HTTP 스캐너 기기 경로의 저장소·등록 코드·DPoP jti 포트를 고른다 */
  static register(o: { scanner: ScannerWiring }): DynamicModule {
    return { module: AppModule, imports: [ScannerModule.register(o.scanner)] };
  }
}
