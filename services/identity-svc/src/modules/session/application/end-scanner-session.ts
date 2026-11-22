// 내 스캐너 세션 끝내기(openapi DELETE /v1/identity/scanner-sessions/{sessionId}, docs/features/identity.md §6.1 '휴대폰 화면 실제 연결' ④, BUILD_ORDER F-05-7 = GAT-230,
// ADR-0362 결정 6, I-T89, ASVS v5.0.0-7.5.2·10.4.9). 다른 기기 로그아웃(end-device-session.ts)과 같은 차례다: 재인증 토큰(같은 세션·FAN_SENSITIVE·op SCANNER_SESSION_END, ADR-0293)을
// 먼저 확인해 틀리면 REAUTH_REQUIRED, 이 계정의 살아 있는 스캐너 세션이 아니면 SESSION_NOT_FOUND(토큰을 쓰지 않는다), 맞으면 한 트랜잭션에서 토큰을 한 번 쓰고
// terminated_at과 control.sessions-terminated(사유 LOGOUT)를 적는다. 스캐너 경로 가드의 CheckScannerSession이 다음 요청부터 거절한다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { REAUTH_VERIFIER, ReauthRejected, type ReauthVerifier, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore } from '../domain/ports.js';
import { sessionAlive, WITHDRAWAL_REAUTH_ACT } from '../domain/session.js';
import { STAFF_ASSIGNMENT_STORE, type StaffAssignmentStore } from '../domain/staff.js';
import { AccountError } from './account-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class EndScannerSession {
  constructor(
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(STAFF_ASSIGNMENT_STORE) private readonly staff: StaffAssignmentStore,
    @Inject(REAUTH_VERIFIER) private readonly reauth: ReauthVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(SESSION_SIGNALS) private readonly signals?: Pick<SessionSignals, 'scannerSessionEnded'>,
  ) {}

  /** @throws AccountError REAUTH_REQUIRED·SESSION_NOT_FOUND */
  async run(i: { accountId: string; sessionId: string; reauthToken: string; scannerSessionId: string }): Promise<void> {
    const accountId = i.accountId.toLowerCase();
    const sessionId = i.sessionId.toLowerCase();
    let token: { jti: string; accountId: string; expiresAt: number };
    try {
      token = await this.reauth.verify(i.reauthToken, { sessionId, act: WITHDRAWAL_REAUTH_ACT, op: 'SCANNER_SESSION_END' });
    } catch (e) {
      if (e instanceof ReauthRejected) throw new AccountError('REAUTH_REQUIRED', e.message);
      throw e;
    }
    if (token.accountId.toLowerCase() !== accountId) throw new AccountError('REAUTH_REQUIRED', '재인증 토큰의 계정이 다르다');
    const now = this.clock.now();
    // 부른 팬 세션이 살아 있어야 한다(원격 로그아웃 뒤 남은 액세스 토큰과 재인증 토큰으로 끝내지 못하게)
    const me = await this.sessions.sessionOf(sessionId);
    if (!me || me.accountId !== accountId || !sessionAlive(me, now)) throw new AccountError('REAUTH_REQUIRED', '세션이 끝났다');
    // 재인증을 확인한 뒤에야 대상을 본다(재인증 없이 세션 ID를 떠보지 못하게). 모양이 틀린 ID도 같은 404다
    if (!UUID.test(i.scannerSessionId)) throw new AccountError('SESSION_NOT_FOUND', '세션 ID 모양이 아니다');
    const r = await this.staff.endOwnScannerSession({
      accountId,
      scannerSessionId: i.scannerSessionId.toLowerCase(),
      nowMs: now,
      reauth: { jti: token.jti, expiresAtMs: token.expiresAt },
    });
    if (r === 'NOT_FOUND') throw new AccountError('SESSION_NOT_FOUND', '이 계정의 살아 있는 스캐너 세션이 아니다');
    if (r === 'REAUTH_USED') throw new AccountError('REAUTH_REQUIRED', '이미 쓴 재인증 토큰이다');
    this.signals?.scannerSessionEnded?.('self', 1);
  }
}
