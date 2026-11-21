// 받는 층: 다른 서비스의 감사 기록 받기(POST /internal/v1/ops/audit-records, 내부 토큰, ADR-0341 결정 7).
// 허용 목록 밖 recordType·payload 칸(개인정보 칸 포함)은 400이고 아무것도 쓰지 않는다. 같은 eventKey는 체인 행 하나이고 처음 seq를 돌려준다.
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { CLOCK, type Clock, ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { AuditRecordIntakeBody, AuditRecordIntakeResponse, AUDIT_INTAKE_PAYLOADS, intakeRecordOf, type AuditIntakeStore } from '../audit-intake.js';
import { AUDIT_INTAKE } from '../tokens.js';

const invalidBody = (): ProblemError => new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });

@Controller('internal/v1/ops/audit-records')
@UseGuards(InternalTokenGuard)
export class InternalAuditRecordsController {
  constructor(
    @Inject(AUDIT_INTAKE) private readonly intake: AuditIntakeStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post()
  @HttpCode(202)
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 202: AuditRecordIntakeResponse } })
  async accept(@Body() body: unknown): Promise<{ accepted: boolean; seq: number }> {
    const parsed = AuditRecordIntakeBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    if (!AUDIT_INTAKE_PAYLOADS[parsed.data.recordType].safeParse(parsed.data.payload).success) throw invalidBody();
    const r = await this.intake.accept(parsed.data.eventKey, intakeRecordOf(parsed.data, this.clock.now()));
    return { accepted: true, seq: r.seq };
  }
}
