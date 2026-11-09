// 뿌리 모듈: trust-svc의 업무 호출은 gRPC(시작 파일이 잇는다)다. 앱 포트에는 뼈대의 공통 경로와 허니팟 기록 처리기가 있다(BUILD_ORDER BOT-055, ADR-0249).
import { type DynamicModule, Module } from '@nestjs/common';
import type { RecordHoneypot } from './modules/scoring/application/record-honeypot.js';
import { HONEYPOT_RECORDER, HoneypotController } from './modules/scoring/inbound/honeypot.controller.js';

@Module({})
export class AppModule {
  static register(o: { honeypot: RecordHoneypot }): DynamicModule {
    return { module: AppModule, controllers: [HoneypotController], providers: [{ provide: HONEYPOT_RECORDER, useValue: o.honeypot }] };
  }
}
