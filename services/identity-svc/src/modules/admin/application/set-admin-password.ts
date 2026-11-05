// 관리 계정 비밀번호 정하기(identity §6 '관리 계정 비밀번호 저장과 정책의 첫 구현', docs/security/auth-controls.md §4.3 8·9, BUILD_ORDER BOT-110, I-T14·AC-T6·AC-T7).
// 길이·L1·L3~L5 정책을 먼저 보고(걸리면 유출 목록을 부르지 않는다), 유출 목록(L2)을 본 뒤, PBKDF2 + 페퍼로 저장한다.
// 유출 목록이나 페퍼 키 서비스에 닿지 못하면 저장하지 않고 UNAVAILABLE(503과 Retry-After, 유출 대조 없이 받지 않는다).
// 부르는 곳: 초대 수락(BOT-150), 비밀번호 바꾸기(BOT-121), 보호 잠금 뒤 재초대 수락. 원문은 이 함수 밖으로 나가지 않는다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import type { AdminAuthConfig } from '../domain/auth-config.js';
import { judgePassword, type PasswordContext, type PolicyLists } from '../domain/password-policy.js';
import { ADMIN_ACCOUNT_STORE, ADMIN_PASSWORDS, type AdminAccountStore, type AdminPasswords, BREACH_LIST, type BreachList, BreachListUnavailable, PepperUnavailable } from '../domain/ports.js';
import { AdminPasswordError, type AdminPasswordRejection } from './admin-password-error.js';

export const ADMIN_AUTH_CONFIG = Symbol('identity.AdminAuthConfig');
export const POLICY_LISTS = Symbol('identity.PasswordPolicyLists');

@Injectable()
export class SetAdminPassword {
  constructor(
    @Inject(ADMIN_ACCOUNT_STORE) private readonly store: AdminAccountStore,
    @Inject(ADMIN_PASSWORDS) private readonly passwords: AdminPasswords,
    @Inject(BREACH_LIST) private readonly breaches: BreachList,
    @Inject(POLICY_LISTS) private readonly lists: PolicyLists,
    @Inject(ADMIN_AUTH_CONFIG) private readonly cfg: AdminAuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'warn'>,
  ) {}

  /** 거절은 거절 이유의 종류와 계정 ID만 보안 이벤트(warn 한 줄)로 남긴다. 비밀번호·대조 사본·SHA-1은 싣지 않는다(auth-controls §4.3 10, BOT-110이 넘긴 것) */
  #rejected(accountId: string, reason: AdminPasswordRejection): AdminPasswordError {
    this.logger?.warn({ kind: 'security', event: 'admin_password_rejected', accountId, reason }, '관리 계정 새 비밀번호를 거절했다');
    return new AdminPasswordError('REJECTED', reason === 'BREACHED' ? '유출 목록에 있는 비밀번호다' : '비밀번호 정책에 걸렸다', reason);
  }

  /**
   * 파트너 맥락(L4: 판매자 정보 상호·번호)만 부르는 쪽이 넘긴다. 계정 맥락(L5: 업무 이메일·표시 이름)은 admin_account 행에서 만든다(auth-controls §4.1).
   * @throws AdminPasswordError REJECTED(이유)·UNAVAILABLE·NOT_FOUND
   */
  async run(i: { accountId: string; password: string; partner?: PasswordContext['partner'] }): Promise<void> {
    const row = await this.store.get(i.accountId);
    if (!row || row.status === 'REMOVED') throw new AdminPasswordError('NOT_FOUND', '관리 계정이 없다');
    const ctx: PasswordContext = { email: row.email, displayName: row.displayName, ...(i.partner ? { partner: i.partner } : {}) };
    const v = judgePassword(i.password, ctx, this.lists, this.cfg);
    if (!v.ok) throw this.#rejected(row.id, v.reason);
    let breached: boolean;
    try {
      breached = await this.breaches.isBreached(i.password);
    } catch (e) {
      if (e instanceof BreachListUnavailable) throw new AdminPasswordError('UNAVAILABLE', '유출 비밀번호 목록에 닿지 못했다');
      throw e;
    }
    if (breached) throw this.#rejected(row.id, 'BREACHED');
    let phc: string;
    try {
      phc = await this.passwords.hash(i.accountId, i.password);
    } catch (e) {
      if (e instanceof PepperUnavailable) throw new AdminPasswordError('UNAVAILABLE', '페퍼 키 서비스에 닿지 못했다');
      throw e;
    }
    const now = this.clock.now();
    // 읽은 뒤 삭제된 계정에는 쓰지 않는다(저장소가 삭제하지 않은 행만 고친다)
    if (!(await this.store.setPassword({ id: i.accountId, phc, breachCheckedAt: now, now }))) throw new AdminPasswordError('NOT_FOUND', '관리 계정이 없다');
  }
}
