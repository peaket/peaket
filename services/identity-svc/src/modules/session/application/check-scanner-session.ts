// 받는 층: gRPC ScannerSessionCheckService.CheckScannerSession(identity.proto, docs/features/identity.md §6.1 '스캐너 세션 확인',
// docs/features/offline-gate.md §6 흐름도, ADR-0051 결정 4, BUILD_ORDER GAT-170).
// ticket-svc의 스캐너 경로 가드가 스태프 토큰 요청마다 묻는다. 세션이 끝나지 않았고·만료 전이고·그 기기의 지금 세션이며·
// 이어진 배정이 ASSIGNED이고 역할 유효 시간 안일 때만 valid=true다. 결과 캐시(5초)는 부르는 쪽 가드가 한다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { STAFF_ASSIGNMENT_STORE, type ScannerSessionAnswer, type StaffAssignmentStore } from '../domain/staff.js';

@Injectable()
export class CheckScannerSession {
  constructor(
    @Inject(STAFF_ASSIGNMENT_STORE) private readonly store: StaffAssignmentStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { scannerSessionId: string; deviceId: string }): Promise<ScannerSessionAnswer> {
    if (!i.scannerSessionId || !i.deviceId) return { valid: false };
    const row = await this.store.findScannerSession(i.scannerSessionId);
    if (!row) return { valid: false };
    const now = this.clock.now();
    if (row.deviceId !== i.deviceId) return { valid: false };
    const valid =
      row.terminatedAt === null &&
      row.expiresAt > now &&
      row.assignmentStatus === 'ASSIGNED' &&
      row.validFrom <= now &&
      row.validUntil >= now;
    if (valid) await this.store.touchScannerSession(row.scannerSessionId, now);
    // 끝났거나 시간 밖인 세션도 역할·유효 창·계정을 돌려준다. 가드는 valid만 보고 401로 닫고,
    // ticket-svc는 기기 단독 업로드의 기록 시각이 그 창 안인지 다시 판정한다(C1-11).
    return {
      valid,
      role: row.role,
      eventId: row.eventId,
      assignmentId: row.assignmentId,
      validFromMs: row.validFrom,
      validUntilMs: row.validUntil,
      proxy: row.proxy,
      ...(row.accountId !== undefined ? { accountId: row.accountId } : {}),
    };
  }
}
