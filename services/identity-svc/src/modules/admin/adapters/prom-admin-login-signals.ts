// 관리 계정 로그인의 운영 신호(Prometheus, identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
// identity_admin_login_failures_total{aud,reason}(전체 실패, auth-controls §3.1)와 identity_admin_security_alerts_total{kind}(SEV3 보안 경보, 경보 규칙은 관측 단계).
import { Counter, type Registry } from '@prometheus-io/client';
import type { AdminAud, AdminLoginFailureReason, AdminLoginSignals, AdminSecurityAlertKind } from '../domain/ports.js';

export class PromAdminLoginSignals implements AdminLoginSignals {
  readonly #failures = new Counter({ name: 'identity_admin_login_failures_total', help: '관리 계정 로그인 실패(사유: 비밀번호·잠김·사람 확인)', labelNames: ['aud', 'reason'] as const, registers: [] });
  readonly #alerts = new Counter({ name: 'identity_admin_security_alerts_total', help: '관리 계정 보안 경보(SEV3)', labelNames: ['kind'] as const, registers: [] });

  register(registry: Registry): void {
    registry.registerMetric(this.#failures);
    registry.registerMetric(this.#alerts);
  }

  failure(aud: AdminAud, reason: AdminLoginFailureReason): void {
    this.#failures.inc({ aud, reason });
  }

  alert(kind: AdminSecurityAlertKind): void {
    this.#alerts.inc({ kind });
  }
}
