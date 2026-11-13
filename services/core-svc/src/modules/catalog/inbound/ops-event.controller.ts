// 받는 층: 회차 수요 예측 조회와 규모 올리기(openapi GET /v1/ops/events/{eventId}/demand-forecast,
// POST /v1/ops/events/{eventId}/scale-changes, ADR-0078 결정 1, POL-030).
// 조회는 viewer 이상, 올리기는 operator 이상. 간격 예외는 commander만 쓴다.
import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CreateOpsEventScaleChangeBody, GetOpsEventDemandForecastParams, GetOpsEventDemandForecastResponse } from '@peaket/contracts/openapi/ops';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { ChangeEventScale } from '../application/change-event-scale.js';
import { GetDemandForecast } from '../application/demand-forecast.js';
import type { DemandForecast as Forecast } from '../domain/demand-forecast.js';

const ScaleChangeResponse = z.object({ applied: z.literal(true) }).strict();

@Controller('v1/ops/events')
export class OpsEventController {
  constructor(
    private readonly forecast: GetDemandForecast,
    private readonly scaleChange: ChangeEventScale,
  ) {}

  @Get(':eventId/demand-forecast')
  @ContractRouteSchema({ responses: { 200: GetOpsEventDemandForecastResponse } })
  @Roles(['viewer', 'operator', 'commander'])
  async demand(@ContractParams(GetOpsEventDemandForecastParams) params: z.output<typeof GetOpsEventDemandForecastParams>): Promise<Forecast> {
    return this.forecast.get(params.eventId);
  }

  @Post(':eventId/scale-changes')
  @ContractRouteSchema({ responses: { 200: ScaleChangeResponse } })
  @Roles(['operator', 'commander'])
  @HttpCode(200)
  async scale(@ContractParams(GetOpsEventDemandForecastParams) params: z.output<typeof GetOpsEventDemandForecastParams>, @ContractBody(CreateOpsEventScaleChangeBody) body: z.output<typeof CreateOpsEventScaleChangeBody>, @CurrentPrincipal() me: Principal): Promise<{ applied: true }> {
    return this.scaleChange.run({
      eventId: params.eventId,
      scale: body.scale,
      reason: body.reason,
      intervalException: body.intervalException,
      role: me.role,
    });
  }
}
