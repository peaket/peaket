// 내 스캐너 세션 목록(openapi GET /v1/identity/scanner-sessions, docs/features/identity.md §6.1 '휴대폰 화면 실제 연결' ④, BUILD_ORDER F-05-7 = GAT-230,
// ADR-0362 결정 6, I-T89). 세션 계정의 끝나지 않았고 역할 유효 끝이 아직 오지 않은(expires_at > now) 스캐너 세션을 준다. 계정마다 하나뿐이라 많아야 한 줄이다.
// 부른 팬 세션이 이미 끝났으면 SESSION_ENDED(받는 층이 401로 바꾼다, 로그인한 기기 목록과 같다). 스태프 토큰·기기 키·기기 ID는 싣지 않는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { SESSION_STORE, type SessionStore } from '../domain/ports.js';
import { sessionAlive } from '../domain/session.js';
import { STAFF_ASSIGNMENT_STORE, type StaffAssignmentStore, type StaffRole } from '../domain/staff.js';
import { AccountError } from './account-error.js';

/** openapi ScannerSessionSelf */
export interface ScannerSessionSelfView {
  sessionId: string;
  deviceName: string | null;
  eventId: string;
  role: StaffRole;
  proxy: boolean;
  approvedAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
}

@Injectable()
export class ListScannerSessions {
  constructor(
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(STAFF_ASSIGNMENT_STORE) private readonly staff: StaffAssignmentStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws AccountError SESSION_ENDED */
  async run(i: { accountId: string; sessionId: string }): Promise<ScannerSessionSelfView[]> {
    const accountId = i.accountId.toLowerCase();
    const now = this.clock.now();
    const me = await this.sessions.sessionOf(i.sessionId.toLowerCase());
    // 원격 로그아웃 뒤 남은 액세스 토큰(최대 15분)으로 목록을 보지 못하게 한다
    if (!me || me.accountId !== accountId || !sessionAlive(me, now)) throw new AccountError('SESSION_ENDED', '부른 세션이 끝났다');
    const rows = await this.staff.listLiveScannerSessions({ accountId, nowMs: now });
    return rows.slice(0, 1).map((r) => ({
      sessionId: r.scannerSessionId,
      deviceName: r.deviceName,
      eventId: r.eventId,
      role: r.role,
      proxy: r.proxy,
      approvedAt: new Date(r.approvedAtMs).toISOString(),
      expiresAt: new Date(r.expiresAtMs).toISOString(),
      lastSeenAt: r.lastSeenAtMs === null ? null : new Date(r.lastSeenAtMs).toISOString(),
    }));
  }
}
