// 관제 스캐너 기기 쓰임새(ADR-0148, BAT-450). 권한은 받는 층 RolesGuard가 보고,
// 이 클래스는 ticket-svc gRPC 호출과 감사 체인 기록을 한 자리에서 묶는다.
import type { Clock } from '@peaket/platform';
import type { AuditChain } from '../../audit/index.js';
import type { ScannerDeviceEnrollmentCode, ScannerDevicePage, ScannerDeviceRegistration, ScannerDeviceRevocation, TicketScannerDevices } from '../domain/scanner-devices.js';

export interface OpsScannerDevicesDeps {
  readonly devices: TicketScannerDevices;
  readonly audit?: AuditChain;
  readonly clock: Clock;
}

export class OpsScannerDevices {
  constructor(private readonly d: OpsScannerDevicesDeps) {}

  list(q: { cursor?: string; limit: number }): Promise<ScannerDevicePage> {
    return this.d.devices.list(q);
  }

  async register(q: { requestId: string; name: string; promoterId: string; actedBy: string }): Promise<ScannerDeviceRegistration> {
    const r = await this.d.devices.register(q);
    await this.#audit('REGISTER', q.requestId, r.device.deviceId, q.actedBy, { name: q.name, promoterId: q.promoterId, alreadyDone: r.alreadyDone });
    return r;
  }

  async revoke(q: { requestId: string; deviceId: string; reason: string; actedBy: string }): Promise<ScannerDeviceRevocation> {
    const r = await this.d.devices.revoke(q);
    await this.#audit('REVOKE', q.requestId, q.deviceId, q.actedBy, { reason: q.reason });
    return r;
  }

  async reissue(q: { requestId: string; deviceId: string; actedBy: string }): Promise<ScannerDeviceEnrollmentCode> {
    const r = await this.d.devices.reissue(q);
    await this.#audit('REISSUE', q.requestId, q.deviceId, q.actedBy, { alreadyDone: r.alreadyDone });
    return r;
  }

  /** 감사 기록이 실패하면 명령도 실패로 답한다(감사 없는 기기 변경을 남기지 않는다) */
  async #audit(action: 'REGISTER' | 'REVOKE' | 'REISSUE', requestId: string, deviceId: string, actedBy: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.d.audit) return;
    await this.d.audit.append({
      recordType: 'scanner_device_command',
      recordId: requestId,
      payload: { action, deviceId, actedBy, ...detail },
      nowMs: this.d.clock.now(),
    });
  }
}
