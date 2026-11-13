// 뿌리 모듈: ticket 모듈의 gRPC 처리기와 스캐너·기기 키 HTTP 경로를 조립한다(BUILD_ORDER HOT-160·GAT-140·GAT-170).
import { type DynamicModule, Module } from '@nestjs/common';
import { ScannerModule, type ScannerWiring } from './modules/scanner/index.js';
import { TicketModule, type TicketWiring } from './modules/ticket/index.js';

@Module({})
export class AppModule {
  /** HTTP 스캐너·기기 키 경로에 쓸 저장소·등록 코드·DPoP jti·기기 키 포트를 고른다. ticket은 시험에서 생략할 수 있다 */
  static register(o: { scanner: ScannerWiring; ticket?: TicketWiring }): DynamicModule {
    return {
      module: AppModule,
      imports: [ScannerModule.register(o.scanner), ...(o.ticket ? [TicketModule.register(o.ticket)] : [])],
    };
  }
}
