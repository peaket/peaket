// SLO 지연 초과 표시 시험(slo-exceeded.test.ts)의 시험 서비스. 시험 대상이 아니다.
// 처리기가 주입한 가짜 시계를 ms만큼 앞으로 돌려 '처리에 걸린 시간'을 만든다(실제로 기다리지 않는다).
// 텔레메트리를 먼저 띄우는 시험이 이 파일을 동적으로 읽는다(node:http를 계측하기 전에 읽히지 않게)
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import { CLOCK, LogPolicy, Roles, createService, fakeClock, type FakeClock } from '../src/index.js';

/** 경로에 단 SLO 지연(ms). 서비스 기본값(시험이 PEAKET_LOG_SLO_LATENCY_MS로 준다)·코드 기본값 500과 다르게 고른다 */
export const ROUTE_SLO_MS = 250;

@Controller('v1/slo')
@Roles(['public'])
export class SloController {
  constructor(@Inject(CLOCK) private readonly clock: FakeClock) {}

  @Get('with-policy')
  @LogPolicy({ sloLatencyMs: ROUTE_SLO_MS })
  withPolicy(@Query('ms') ms: string) {
    this.clock.advance(Number(ms));
    return { ok: true };
  }

  @Get('default')
  withDefault(@Query('ms') ms: string) {
    this.clock.advance(Number(ms));
    return { ok: true };
  }
}

@Module({ controllers: [SloController] })
export class SloModule {}

export async function startSloService(env: Record<string, string>) {
  const clock = fakeClock();
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  return createService({ name: 'slo-svc', module: SloModule, env, clock, logDestination: sink });
}
