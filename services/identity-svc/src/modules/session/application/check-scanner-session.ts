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
    if (row.terminatedAt !== null) return { valid: false };
    if (row.expiresAt <= now) return { valid: false };
    if (row.assignmentStatus !== 'ASSIGNED') return { valid: false };
    if (row.validFrom > now || row.validUntil < now) return { valid: false };
    return { valid: true, role: row.role, eventId: row.eventId };
  }
}
