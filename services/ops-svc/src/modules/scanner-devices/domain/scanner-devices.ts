// 관제 스캐너 기기 경계(ADR-0148, BAT-450 GAT-220 잔여).
// 운영자 권한 확인·감사는 ops-svc가 하고, 기기 원장은 ticket-svc ScannerDeviceService gRPC가 가진다.
export type ScannerDeviceStatus = 'ACTIVE' | 'REVOKED' | 'RETIRED';
export type ScannerCredentialType = 'DEVICE_KEY' | 'MTLS_CERT';

export interface ScannerDeviceView {
  deviceId: string;
  name: string;
  promoterId: string;
  status: ScannerDeviceStatus;
  credentialType: ScannerCredentialType;
  certExpiresAt?: string;
  lastSeenAt?: string;
}

export interface ScannerDevicePage {
  items: ScannerDeviceView[];
  nextCursor?: string;
}

export interface ScannerDeviceRegistration {
  device: ScannerDeviceView;
  enrollmentCode?: string;
  enrollmentCodeExpiresAt?: string;
  alreadyDone: boolean;
}

export interface ScannerDeviceRevocation {
  device: ScannerDeviceView;
  alreadyDone: boolean;
}

export interface ScannerDeviceEnrollmentCode {
  enrollmentCode?: string;
  enrollmentCodeExpiresAt?: string;
  alreadyDone: boolean;
}

/** ticket-svc ScannerDeviceService gRPC 클라이언트 포트 */
export interface TicketScannerDevices {
  list(q: { cursor?: string; limit: number }): Promise<ScannerDevicePage>;
  register(q: { requestId: string; name: string; promoterId: string; actedBy: string }): Promise<ScannerDeviceRegistration>;
  revoke(q: { requestId: string; deviceId: string; reason: string; actedBy: string }): Promise<ScannerDeviceRevocation>;
  reissue(q: { requestId: string; deviceId: string; actedBy: string }): Promise<ScannerDeviceEnrollmentCode>;
}

export class ScannerDeviceNotFound extends Error {
  constructor() {
    super('스캐너 기기를 찾을 수 없다');
    this.name = 'ScannerDeviceNotFound';
  }
}

export class ScannerDeviceInactive extends Error {
  constructor() {
    super('폐기·퇴역한 스캐너 기기다');
    this.name = 'ScannerDeviceInactive';
  }
}

export class ScannerDeviceInputRejected extends Error {
  constructor(readonly detail: string) {
    super(`스캐너 기기 입력이 올바르지 않다: ${detail}`);
    this.name = 'ScannerDeviceInputRejected';
  }
}

export class ScannerDeviceKeyInUse extends Error {
  constructor() {
    super('이미 다른 기기에 묶인 기기 키다');
    this.name = 'ScannerDeviceKeyInUse';
  }
}

/** ticket-svc에 닿지 못했다(503). 대역으로 통과시키지 않는다 */
export class ScannerDeviceDependencyUnavailable extends Error {
  constructor(cause?: unknown) {
    super('ticket-svc 기기 원장에 닿지 못했다', { cause });
    this.name = 'ScannerDeviceDependencyUnavailable';
  }
}
