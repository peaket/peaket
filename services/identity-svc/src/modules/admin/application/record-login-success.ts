// 관리 계정 로그인 성공 처리(비밀번호와 2단계를 모두 통과, docs/security/auth-controls.md §3.1 '0으로 돌리는 때', BUILD_ORDER BOT-111).
// 계정 실패 수·2단계 실패 수·비밀번호 연속 실패 누계를 0으로, 그 출발지 묶음 실패 수를 지우고 last_login_at을 쓴다. 2단계(BOT-120)가 부른다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ADMIN_LOGIN_STORE, type AdminLoginStore, LOGIN_COUNTERS, type LoginCounters } from '../domain/ports.js';
import { pairRefOf, sourceAddressOf } from './login-password-step.js';

@Injectable()
export class RecordAdminLoginSuccess {
  constructor(
    @Inject(ADMIN_LOGIN_STORE) private readonly store: AdminLoginStore,
    @Inject(LOGIN_COUNTERS) private readonly counters: LoginCounters,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** pair는 로그인 단계 행의 묶음 값이거나(2단계) 출발지(IP·기기) */
  async run(i: { accountId: string; pair: string | { ip: string; deviceId: string } }): Promise<void> {
    // 1단계와 같은 출발지 주소 맞추기를 거친다(IPv4를 적은 IPv6·/64, 재리뷰 2026-11-05)
    const pair = typeof i.pair === 'string' ? i.pair : pairRefOf(sourceAddressOf(i.pair.ip), i.pair.deviceId);
    await this.store.recordLoginSuccess(i.accountId, this.clock.now());
    await this.counters.clearPair(i.accountId, pair);
  }
}
