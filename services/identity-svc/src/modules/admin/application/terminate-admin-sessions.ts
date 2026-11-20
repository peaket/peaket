// 관리 세션 강제 종료(AdminSessionService.TerminateAdminSessions, BUILD_ORDER BOT-152, ADR-0322).
// 부르는 쪽은 ops-svc 하나이고, 끊는 쪽의 안전 조치라 identity-svc는 요청자 역할을 다시 보지 않는다.
// request_id로 멱등이며, 계정의 모든 세션 또는 하나를 끝내고 끝낸 세션마다 control.sessions-terminated(reason ADMIN_FORCE)를 낸다.
// 계정 상태는 바꾸지 않는다. 다른 계정의 세션 ID·없는 세션은 NOT_FOUND(gRPC), 이미 끝난 세션은 204(ended_count 0)다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { AdminAccountInputError, AdminAccountNotFound } from './manage-admin-accounts.js';
import { ADMIN_MANAGEMENT_STORE, type AdminManagementStore } from '../domain/ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requireId = (v: string, what: string) => {
  if (!UUID.test(v)) throw new AdminAccountInputError(`${what}가 UUID가 아니다`);
};

@Injectable()
export class TerminateAdminSessions {
  constructor(
    @Inject(ADMIN_MANAGEMENT_STORE) private readonly store: AdminManagementStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(i: { requestId: string; actedBy: string; adminAccountId: string; sessionId?: string }): Promise<{ endedCount: number; alreadyDone: boolean }> {
    if (!i.requestId || i.requestId.length > 128) throw new AdminAccountInputError('request_id가 없거나 길다');
    requireId(i.actedBy, 'acted_by');
    requireId(i.adminAccountId, 'admin_account_id');
    if (i.sessionId !== undefined && i.sessionId !== '') requireId(i.sessionId, 'session_id');
    const sessionId = i.sessionId === '' ? undefined : i.sessionId;
    const now = this.clock.now();
    return this.store.manageTransaction(async (tx) => {
      const prev = await tx.findRequest(i.requestId);
      if (prev) {
        if (prev.kind !== 'TERMINATE_SESSIONS' || prev.accountId !== i.adminAccountId) throw new AdminAccountInputError('같은 request_id로 다른 호출이 왔다');
        return { endedCount: 0, alreadyDone: true };
      }
      const target = await tx.lockAccount(i.adminAccountId);
      if (!target) throw new AdminAccountNotFound();
      let endedCount: number;
      if (sessionId !== undefined) {
        const r = await tx.endSession(target.id, sessionId, now);
        // 다른 계정의 세션이거나 없는 세션은 대상이 없는 것과 같은 404다
        if (r === 'NOT_FOUND') throw new AdminAccountNotFound();
        endedCount = r === 'OK' ? 1 : 0;
      } else {
        endedCount = (await tx.endAllSessions(target.id, 'ADMIN_FORCE', now)).length;
      }
      await tx.recordRequest({ requestId: i.requestId, kind: 'TERMINATE_SESSIONS', accountId: target.id, result: 'OK', at: now });
      return { endedCount, alreadyDone: false };
    });
  }
}
