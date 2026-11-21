// 받는 층: 저장하지 않는 dry-run 미리보기(POST /v1/ops/command-dry-runs, ADR-0340 결정 2).
// 본문은 명령 접수와 같고, 접수와 같은 검사(유형별 역할 403, 꼴 422, 안전 한계 422)를 한 뒤 CommandDryRun을 준다.
// 재인증·Idempotency-Key가 없고, 명령 행·사건·감사 기록을 남기지 않는다(읽기만 한다).
import { Controller, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { CLOCK, type Clock, ContractBody, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { PreviewCommand } from '../application/create-command.js';
import { noCommandSecurityEvents, type CommandSecurityEvents } from '../domain/ports.js';
import { COMMAND_SECURITY_EVENTS } from '../tokens.js';
import { CommandBody, CommandDryRunView } from './command-view.js';

@Controller('v1/ops/command-dry-runs')
export class CommandDryRunsController {
  readonly #security: CommandSecurityEvents;

  constructor(
    private readonly preview: PreviewCommand,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(COMMAND_SECURITY_EVENTS) security?: CommandSecurityEvents,
  ) {
    this.#security = security ?? noCommandSecurityEvents;
  }

  @Post()
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ body: CommandBody, responses: { 200: CommandDryRunView } })
  async create(@ContractBody(CommandBody) body: z.output<typeof CommandBody>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CommandDryRunView>> {
    try {
      const dryRun = await this.preview.execute({ type: body.type, reason: body.reason, params: body.params ?? {}, requestedRole: me.role ?? 'operator', nowMs: this.clock.now() });
      return dryRun as z.output<typeof CommandDryRunView>;
    } catch (e) {
      if (e instanceof ProblemError && e.status === 403) this.#security.authzDenied({ role: me.role ?? 'unknown', reason: e.slug, action: 'dry-run' });
      throw e;
    }
  }
}
