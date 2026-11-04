// 관리 계정 로그아웃(openapi DELETE /v1/partner/auth/sessions/me·/v1/ops/auth/sessions/me, docs/features/identity.md §6 '관리 계정 토큰 갱신과 로그아웃의 첫 구현', BUILD_ORDER BOT-130).
// 지금 세션을 끝내고 같은 트랜잭션에 세션 종료 사건(control.sessions-terminated, 이유 LOGOUT)을 적는다. 쿠키 지우기는 받는 층이 한다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ADMIN_REFRESH_STORE, type AdminRefreshStore } from '../domain/ports.js';

@Injectable()
export class EndAdminSession {
  constructor(
    @Inject(ADMIN_REFRESH_STORE) private readonly store: AdminRefreshStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 끝냈으면 true(이미 끝났거나 그 계정의 세션이 아니면 false) */
  run(i: { accountId: string; sessionId: string }): Promise<boolean> {
    return this.store.endSession(i.accountId, i.sessionId, 'LOGOUT', this.clock.now());
  }
}
