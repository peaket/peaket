// 관리 경로의 역할 판정(ADR-0172, identity.proto AdminAuthzService.GetAdminAuthz, identity §6 '관리 계정 비밀번호만 맞은 로그인 알림과 비밀번호 바꾸기의 첫 구현', BUILD_ORDER BOT-123).
// 그 세션이 끝나지 않았고 유휴·절대 만료 전이며 그 계정의 관리 세션이고 계정이 활성이면 valid. 역할과 파트너 테넌트(promoter_id)를 준다.
// identity-svc 안의 가드 포트이자 다른 서비스가 부르는 gRPC의 처리다. 원본 DB에서 읽는다. 보호 잠금 중인 계정의 열린 세션은 이어진다(auth-controls §3.2).
import { Inject, Injectable } from '@nestjs/common';
import { type AdminAuthz, type AdminAuthzPort, CLOCK, type Clock } from '@peaket/platform';
import { ADMIN_SECOND_STEP_STORE, ADMIN_SESSION_STORE, type AdminSecondStepStore, type AdminSessionStore, ROLES_OF_AUD } from '../domain/ports.js';

const INVALID: AdminAuthz = { valid: false, role: '' };

@Injectable()
export class GetAdminAuthz implements AdminAuthzPort {
  constructor(
    @Inject(ADMIN_SESSION_STORE) private readonly sessions: AdminSessionStore,
    @Inject(ADMIN_SECOND_STEP_STORE) private readonly accounts: AdminSecondStepStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    const now = this.clock.now();
    const s = await this.sessions.findSession(q.sessionId);
    if (!s || s.accountId !== q.adminAccountId || s.terminatedAt !== null || s.idleExpiresAt <= now || s.absoluteExpiresAt <= now) return INVALID;
    const a = await this.accounts.findLoginById(q.adminAccountId);
    if (!a || a.status !== 'ACTIVE' || !ROLES_OF_AUD[s.aud].includes(a.role)) return INVALID;
    return a.promoterId ? { valid: true, role: a.role, tenantId: a.promoterId } : { valid: true, role: a.role };
  }
}
