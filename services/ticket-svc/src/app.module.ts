// 뿌리 모듈: 지금은 ticket 모듈의 gRPC 처리기만 조립한다(BUILD_ORDER HOT-160). HTTP는 플랫폼의 health/management 포트다.
import { Module } from '@nestjs/common';

@Module({})
export class AppModule {}
