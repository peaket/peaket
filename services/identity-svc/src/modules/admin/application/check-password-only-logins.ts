// 비밀번호만 맞은 로그인 알림(docs/security/auth-controls.md §2.1 C7·§3.5, identity §6 '관리 계정 비밀번호만 맞은 로그인 알림과 비밀번호 바꾸기의 첫 구현', BUILD_ORDER BOT-123, AC-T4).
// 익숙하지 않은 출발지에서 비밀번호가 맞았는데 10분 [가정] 안에 2단계를 끝내지 않은 로그인 단계를 찾아, 계정의 비밀번호 바꾸기 필요를 켜고 계정 주인에게 알린다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import type { AdminAuthConfig } from '../domain/auth-config.js';
import { ADMIN_SESSION_STORE, type AdminSessionStore } from '../domain/ports.js';
import { ADMIN_AUTH_CONFIG } from './set-admin-password.js';

/** 한 번에 보는 단계 수 [가정] */
const BATCH = 20;
/**
 * 알림 기준이 지난 뒤 이만큼 안의 행만 본다 [가정]: 마이그레이션 0020 전에 만든 옛 행(known_source가 false로 채워짐)을 잡지 않는다(BOT-123이 넘긴 것).
 * 찾기가 하루 넘게 멈추면 그 사이 알림은 늦게라도 가지 않는다(정비가 2일 뒤 지운다)
 */
const LOOKBACK_MS = 24 * 60 * 60_000;

@Injectable()
export class CheckPasswordOnlyLogins {
  constructor(
    @Inject(ADMIN_SESSION_STORE) private readonly store: AdminSessionStore,
    @Inject(ADMIN_AUTH_CONFIG) private readonly cfg: AdminAuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 알린 수 */
  async run(): Promise<number> {
    const now = this.clock.now();
    let n = 0;
    const before = now - this.cfg.passwordOnlyNoticeAfterMs;
    for (const s of await this.store.findPasswordOnlySteps(before, before - LOOKBACK_MS, BATCH)) {
      if (await this.store.markPasswordOnly(s.id, s.accountId, now)) n++;
    }
    return n;
  }
}
