// 로그인한 기기 목록(openapi GET /v1/identity/sessions, docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현', BUILD_ORDER BOT-044, ADR-0209 결정 3, I-T74).
// 이 계정의 살아 있는 세션을 기기마다 한 줄로 묶는다. 부른 세션이 이미 끝났으면 SESSION_ENDED(받는 층이 401로 바꾼다). 잠그지 않고 읽는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { SESSION_STORE, type SessionStore } from '../domain/ports.js';
import { deviceRows, sessionAlive } from '../domain/session.js';
import { AccountError } from './account-error.js';

/** openapi FanDeviceSession */
export interface FanDeviceSessionView {
  sessionId: string;
  deviceName: string | null;
  lastActiveAt: string;
  current: boolean;
  /** 그 줄에서 대표 세션 말고 살아 있는 세션 수(같은 기기의 다른 로그인) */
  otherSessions: number;
}

@Injectable()
export class ListSessions {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws AccountError SESSION_ENDED */
  async run(i: { accountId: string; sessionId: string }): Promise<FanDeviceSessionView[]> {
    const accountId = i.accountId.toLowerCase();
    const sessionId = i.sessionId.toLowerCase();
    const now = this.clock.now();
    const me = await this.store.sessionOf(sessionId);
    // 원격 로그아웃 뒤 남은 액세스 토큰(최대 15분)으로 목록을 보지 못하게 한다
    if (!me || me.accountId !== accountId || !sessionAlive(me, now)) throw new AccountError('SESSION_ENDED', '부른 세션이 끝났다');
    const rows = deviceRows(await this.store.liveSessionsOf(accountId, now), sessionId);
    return rows.map((r) => ({ sessionId: r.sessionId, deviceName: r.deviceName, lastActiveAt: new Date(r.lastActiveAt).toISOString(), current: r.current, otherSessions: r.otherSessions }));
  }
}
