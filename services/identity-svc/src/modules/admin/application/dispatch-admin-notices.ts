// 계정 주인 알림 발송 고리(identity §6 '관리 계정 본인 해제 링크와 2단계 보호 잠금의 첫 구현', docs/security/auth-controls.md §3.3·§3.4, BUILD_ORDER BOT-121).
// 보내지 않은 admin_security_notice를 몇 개씩 잠가 메일 포트로 보낸다. TIMED_LOCK·UNLOCK_LINK는 보낼 때 아직 시간 잠금 중이고 보호 잠금이 아니면 새 해제 링크(32바이트, 30분)를 만들어 싣는다.
// 이미 풀렸거나 보호 잠금이면 링크 없이 닫는다. 삭제한 계정은 닫는다. 메일을 보내지 못하면 남겨 다음에 다시 한다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import type { AdminAuthConfig } from '../domain/auth-config.js';
import { activeLock } from '../domain/login-rules.js';
import { ADMIN_MAILER, ADMIN_UNLOCK_STORE, type AdminMailer, type AdminSecondStepStore, type AdminUnlockStore, ROLES_OF_AUD } from '../domain/ports.js';
import { ADMIN_AUTH_CONFIG } from './set-admin-password.js';

export const CONSOLE_ORIGINS = Symbol('identity.ConsoleOrigins');
export type ConsoleOrigins = { partner: string; ops: string };
/** 한 번에 보내는 알림 수 [가정] */
const BATCH = 20;
/** 메일 한 통의 시간 제한 [가정]. 넘으면 보내지 못한 것으로 보고 미룬다 */
const MAIL_TIMEOUT_MS = 10_000;

@Injectable()
export class DispatchAdminNotices {
  constructor(
    @Inject(ADMIN_UNLOCK_STORE) private readonly store: AdminUnlockStore & AdminSecondStepStore,
    @Inject(ADMIN_MAILER) private readonly mailer: AdminMailer,
    @Inject(CONSOLE_ORIGINS) private readonly origins: ConsoleOrigins,
    @Inject(ADMIN_AUTH_CONFIG) private readonly cfg: AdminAuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 보낸(닫은) 알림 수와 보내지 못해 미룬 수 */
  async run(): Promise<{ done: number; failed: number }> {
    const now = this.clock.now();
    return this.store.dispatchNotices(BATCH, now, async (n) => {
      // 이 안의 예외는 저장소가 그 행만 되돌리고 다음 행으로 간다(KEEP과 같다)
      const account = await this.store.findLoginById(n.accountId);
      if (!account || account.status === 'REMOVED') return 'CLOSE';
      let link: string | undefined;
      if (n.kind === 'TIMED_LOCK' || n.kind === 'UNLOCK_LINK') {
        // 보낼 때의 잠금을 본다: 이미 풀렸거나 보호 잠금이면 링크를 만들지 않고 닫는다(§3.2 보호 잠금은 해제 링크를 보내지 않는다)
        if (activeLock(account.state, now)?.kind !== 'TIMED') return 'CLOSE';
        const token = randomBytes(32).toString('base64url');
        await this.store.createUnlockLink({ id: randomUUID(), accountId: account.id, tokenHash: createHash('sha256').update(token).digest(), createdAt: now, expiresAt: now + this.cfg.unlockLinkTtlMs });
        const origin = ROLES_OF_AUD.partner.includes(account.role) ? this.origins.partner : this.origins.ops;
        link = `${origin.replace(/\/+$/, '')}/unlock#token=${token}`;
      }
      try {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          this.mailer.send({ to: account.email, kind: n.kind === 'TIMED_LOCK' ? 'UNLOCK_LINK' : n.kind, ...(link ? { link } : {}), at: now }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('메일 시간 제한')), MAIL_TIMEOUT_MS);
            timer.unref();
          }),
        ]).finally(() => clearTimeout(timer));
        return 'SENT';
      } catch {
        // 보내지 못했다: 행을 남겨 다음 고리에서 다시 한다(만든 링크는 다음 링크가 무효로 한다)
        return 'KEEP';
      }
    });
  }
}
