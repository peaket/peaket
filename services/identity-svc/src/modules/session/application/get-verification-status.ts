// 본인확인 유효 상태 다시 확인(gRPC IdentityService.GetVerificationStatus, docs/api/proto identity.proto, docs/features/identity.md §5 'pid 키 전환의 첫 구현',
// BUILD_ORDER BOT-025, I-T49 ①). 주문 생성(purchase-svc, PRF-160)이 결제 직전에 부른다. 세션이 그 계정의 살아 있는 세션이고 본인확인 기록이 있으면
// verified와 pid를, pid 키 전환 기간이면 옛 pid(previous_pid)도 준다. 탈퇴 미룸 계정이면 withdrawal_pending을 참으로 준다(ADR-0284, PRF-169). 값은 토큰에 싣는 것과 같은 base64url 글자이고, 토큰의 pid와 견주는 쪽은 부르는 쪽이다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ACCOUNT_CLAIMS, type AccountClaims, SESSION_STORE, type SessionStore } from '../domain/ports.js';
import { sessionAlive } from '../domain/session.js';
import { checkIds } from './end-session.js';

export interface VerificationStatus {
  verified: boolean;
  /** 본인확인 때 저장한 pid. verified가 아니면 빈 글자 */
  pid: string;
  /** pid 키 전환 기간에만 채우는 옛 pid. 아니면 빈 글자 */
  previousPid: string;
  /**
   * verified가 거짓이고 그 계정이 탈퇴 미룸(WITHDRAWAL_PENDING, 정리 사유 WITHDRAWAL) 중이며 세션이 살아 있으면 참(identity.proto withdrawal_pending,
   * identity §8 '미루는 동안', ADR-0284 결정 5). 정리 사유 UNDER_14와 그 밖의 계정, 끝난 세션은 거짓이다
   */
  withdrawalPending: boolean;
}

const NONE: VerificationStatus = { verified: false, pid: '', previousPid: '', withdrawalPending: false };

@Injectable()
export class GetVerificationStatus {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(ACCOUNT_CLAIMS) private readonly claims: AccountClaims,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { accountId: string; sessionId: string }): Promise<VerificationStatus> {
    checkIds(i.sessionId, i.accountId);
    const accountId = i.accountId.toLowerCase();
    const now = this.clock.now();
    // 읽기만 하므로 세션 줄을 잠그지 않는다(주문 생성이 결제 직전마다 부른다, BOT-025가 넘긴 것)
    const s = await this.store.sessionOf(i.sessionId.toLowerCase());
    if (s === null || s.accountId !== accountId || !sessionAlive(s, now)) return NONE;
    const c = await this.claims.of(accountId);
    if (c.pid) return { verified: true, pid: c.pid, previousPid: c.pidPrev ?? '', withdrawalPending: false };
    // 본인확인을 통과하지 못한 답에만 탈퇴 미룸을 본다(탈퇴 유예 계정은 claims에 pid가 없어 여기로 온다). 주문 생성이 이 값으로 403 대신 409를 낸다
    const withdrawalPending = await this.store.transaction((tx) => tx.withdrawalPendingOf(accountId));
    return withdrawalPending ? { ...NONE, withdrawalPending: true } : NONE;
  }
}
