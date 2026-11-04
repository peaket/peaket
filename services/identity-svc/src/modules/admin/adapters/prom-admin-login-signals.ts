// 관리 계정 로그인의 운영 신호(Prometheus, identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
// identity_admin_login_failures_total{aud,reason}(전체 실패, auth-controls §3.1)와 identity_admin_security_alerts_total{kind}(SEV3 보안 경보, 경보 규칙은 관측 단계).
// 관리 토큰 갱신은 팬과 같은 identity_refresh_total·identity_refresh_retry_reuse_total·identity_refresh_reuse_detected_total에 aud partner·ops로 낸다(BOT-130, identity §10.1).
import { Counter, type Registry } from '@prometheus-io/client';
import type { AdminAud, AdminLoginFailureReason, AdminLoginSignals, AdminSecurityAlertKind } from '../domain/ports.js';

export class PromAdminLoginSignals implements AdminLoginSignals {
  /** refreshTo: 팬 갱신 지표를 내는 쪽(PromSessionSignals). 관리 갱신도 같은 지표에 aud partner·ops로 낸다 */
  constructor(private readonly refreshTo?: { refreshed(aud: string, result: string): void }) {}

  readonly #failures = new Counter({ name: 'identity_admin_login_failures_total', help: '관리 계정 로그인 실패(사유: 비밀번호·2단계 코드·잠김·사람 확인)', labelNames: ['aud', 'reason'] as const, registers: [] });
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

  refreshed(aud: AdminAud, result: 'rotated' | 'retried' | 'reused' | 'invalid'): void {
    this.refreshTo?.refreshed(aud, result);
  }
}
