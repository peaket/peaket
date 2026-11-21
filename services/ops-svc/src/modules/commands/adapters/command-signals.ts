// 운영 명령 지표와 보안 사건 로그 어댑터(BAT-355 계획 8.5).
// 지표 ops_command_dry_run_unavailable_total{type,key}: dry-run에서 세지 못한 값마다 하나. 등록은 시작 조립이 서비스 레지스트리에 한다(register).
// 보안 사건 로그 ops_block_protected_range(ADR-0339 결정 5)·ops_command_authz_denied(ASVS 16.3.2): 정규 로그 한 줄, 관리 계정 ID·이름 없음.
import { Counter, type PlatformLogger, type Registry } from '@peaket/platform';
import type { CommandType } from '../domain/command.js';
import type { CommandSecurityEvents, CommandSignals } from '../domain/ports.js';

export class PromCommandSignals implements CommandSignals {
  readonly dryRunUnavailableTotal = new Counter({
    name: 'ops_command_dry_run_unavailable_total',
    help: 'dry-run에서 원천을 세지 못한 값 수(ADR-0340 결정 2). type은 명령 유형, key는 센 값 이름',
    labelNames: ['type', 'key'] as const,
    registers: [],
  });

  dryRunUnavailable(type: CommandType, key: string): void {
    this.dryRunUnavailableTotal.inc({ type, key });
  }

  register(registry: Registry): void {
    registry.registerMetric(this.dryRunUnavailableTotal);
  }
}

export class LogCommandSecurityEvents implements CommandSecurityEvents {
  constructor(private logger?: PlatformLogger) {}

  /** 모듈을 조립한 뒤 서비스 로거를 붙인다(응용 객체는 조립 때 먼저 만들어진다) */
  attach(logger: PlatformLogger | undefined): this {
    if (logger) this.logger = logger;
    return this;
  }

  blockProtectedRange(e: { commandId: string; requesterRole: string; hits: readonly { category: string; label: string }[] }): void {
    this.logger?.warn(
      { security: 'ops_block_protected_range', commandId: e.commandId, requesterRole: e.requesterRole, hits: e.hits.map((h) => ({ category: h.category, label: h.label })) },
      '보호 대역 목록에 걸린 차단 요청(ADR-0339 결정 5)',
    );
  }

  authzDenied(e: { commandId?: string; role: string; reason: string; action: string }): void {
    this.logger?.warn({ security: 'ops_command_authz_denied', ...(e.commandId !== undefined ? { commandId: e.commandId } : {}), role: e.role, reason: e.reason, action: e.action }, '운영 명령 권한 시도 실패(ASVS 16.3.2)');
  }
}
