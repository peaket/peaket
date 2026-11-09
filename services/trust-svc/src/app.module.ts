// 뿌리 모듈: trust-svc의 업무 호출은 gRPC(시작 파일이 잇는다)다. 앱 포트에는 뼈대의 공통 경로만 있고, 허니팟 기록 경로는 BUILD_ORDER BOT-070이 더한다.
import { Module } from '@nestjs/common';

@Module({})
export class AppModule {}
