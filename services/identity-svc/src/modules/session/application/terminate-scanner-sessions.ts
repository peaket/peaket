// 기기 폐기 때 identity 스캐너 세션을 끝내는 쓰임새(GAT-170 잔여, O-T27, offline-gate §6.1).
// ticket-svc 기기 폐기가 gRPC ScannerSessionCheckService.TerminateScannerSessions로 부른다.
// 세션을 끝내고 같은 트랜잭션에 control.sessions-terminated(reason DEVICE_REVOKED)를 적는다(저장소 몫).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { STAFF_ASSIGNMENT_STORE, type StaffAssignmentStore } from '../domain/staff.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ScannerSessionTerminationInputError extends Error {
  constructor(readonly field: 'device_id' | 'reason') {
    super(`스캐너 세션 종료 입력 오류: ${field}`);
    this.name = 'ScannerSessionTerminationInputError';
  }
}

@Injectable()
export class TerminateScannerSessions {
  constructor(
    @Inject(STAFF_ASSIGNMENT_STORE) private readonly store: StaffAssignmentStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { deviceId: string; reason: string; terminatedAtMs?: number }): Promise<{ terminated: number }> {
    if (!UUID.test(i.deviceId)) throw new ScannerSessionTerminationInputError('device_id');
    const reason = i.reason === '' ? 'DEVICE_REVOKED' : i.reason;
    if (reason !== 'DEVICE_REVOKED') throw new ScannerSessionTerminationInputError('reason');
    const at = i.terminatedAtMs !== undefined && i.terminatedAtMs > 0 ? i.terminatedAtMs : this.clock.now();
    return { terminated: await this.store.terminateScannerSessionsByDevice({ deviceId: i.deviceId.toLowerCase(), reason, nowMs: at }) };
  }
}
