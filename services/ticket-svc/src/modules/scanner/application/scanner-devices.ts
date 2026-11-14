// 스캐너 기기 원장 쓰임새(BUILD_ORDER GAT-170, offline-gate §6.1). 등록·목록·폐기·등록 코드 소비·재발급.
import type { Clock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import type { EnrollmentAttemptLimiter, EnrollmentCodeStore, ScannerDeviceStore, ScannerSessionTerminator } from '../domain/ports.js';
import {
  assertAccountId,
  assertCursor,
  assertDeviceId,
  assertDeviceName,
  assertJkt,
  assertLimit,
  assertPromoterId,
  assertRevokeReason,
  deviceView,
  ENROLLMENT_CODE_TTL_MS,
  enrollmentCodeHash,
  newEnrollmentCode,
  normalizeEnrollmentCode,
  ScannerDeviceKeyConflict,
  type ScannerDeviceView,
} from '../domain/scanner-device.js';

export class ScannerDeviceNotFound extends Error {
  constructor() {
    super('스캐너 기기를 찾을 수 없다');
    this.name = 'ScannerDeviceNotFound';
  }
}

/** 폐기·퇴역 기기에는 등록 코드를 만들지 않는다 */
export class ScannerDeviceInactive extends Error {
  constructor() {
    super('폐기·퇴역한 스캐너 기기다');
    this.name = 'ScannerDeviceInactive';
  }
}

/** 그 출발지 IP가 등록 실패 한도를 넘었다(429) */
export class EnrollmentRateLimited extends Error {
  constructor() {
    super('등록 시도가 너무 많다');
    this.name = 'EnrollmentRateLimited';
  }
}

export class EnrollmentCodeRejected extends Error {
  constructor(readonly reason: 'INVALID' | 'USED' | 'DEVICE' | 'KEY_IN_USE') {
    super(`등록 코드 거절: ${reason}`);
    this.name = 'EnrollmentCodeRejected';
  }
}

export interface ScannerDevicesDeps {
  store: ScannerDeviceStore;
  codes: EnrollmentCodeStore;
  clock: Clock;
  /** 등록 시도 IP 실패 제한. 없으면 세지 않는다(시험 기본값) */
  limiter?: EnrollmentAttemptLimiter;
  /** 기기 폐기 때 identity 스캐너 세션을 끝내는 포트. 없으면 부르지 않는다 */
  sessions?: ScannerSessionTerminator;
  /** SEV3 경보·세션 종료 실패를 남기는 곳. 없으면 버린다 */
  alert?: (message: string, fields: Record<string, unknown>) => void;
  /** 시험에서 고정 ID를 주입한다. 없으면 UUIDv4 */
  newId?: () => string;
}

export class ScannerDevices {
  constructor(private readonly d: ScannerDevicesDeps) {}

  async list(q: { cursor?: unknown; limit?: unknown }): Promise<{ items: ScannerDeviceView[]; nextCursor?: string }> {
    const cursor = assertCursor(q.cursor);
    const limit = assertLimit(q.limit);
    const r = await this.d.store.list({ ...(cursor !== undefined ? { cursor } : {}), limit });
    return { items: r.devices.map(deviceView), ...(r.nextCursor !== undefined ? { nextCursor: r.nextCursor } : {}) };
  }

  /** 기기를 만들고 1회용 등록 코드를 이 응답에만 싣는다. 코드 원문은 저장하지 않는다 */
  async register(q: { name: unknown; promoterId: unknown; enrolledBy: unknown }): Promise<{ device: ScannerDeviceView; enrollmentCode: string; enrollmentCodeExpiresAt: string }> {
    const name = assertDeviceName(q.name);
    const promoterId = assertPromoterId(q.promoterId);
    const enrolledBy = assertAccountId(q.enrolledBy);
    const deviceId = (this.d.newId ?? randomUUID)();
    const device = await this.d.store.register({ deviceId, name, promoterId, enrolledBy, atMs: this.d.clock.now() });
    const code = newEnrollmentCode();
    await this.d.codes.put({ codeHash: enrollmentCodeHash(code), deviceId, ttlMs: ENROLLMENT_CODE_TTL_MS });
    return { device: deviceView(device), enrollmentCode: code, enrollmentCodeExpiresAt: new Date(this.d.clock.now() + ENROLLMENT_CODE_TTL_MS).toISOString() };
  }

  async revoke(q: { deviceId: unknown; reason: unknown }): Promise<ScannerDeviceView> {
    const deviceId = assertDeviceId(q.deviceId);
    const reason = assertRevokeReason(q.reason);
    const atMs = this.d.clock.now();
    const device = await this.d.store.revoke({ deviceId, reason, atMs });
    if (!device) throw new ScannerDeviceNotFound();
    // 기기 상태가 REVOKED가 된 뒤 identity 스캐너 세션을 끝내고 control.sessions-terminated(DEVICE_REVOKED)를 남긴다.
    // identity에 닿지 못해도 다음 스캐너 요청은 기기 상태 확인에서 403이므로 안전은 유지되고, 실패만 남긴다.
    if (this.d.sessions) {
      try {
        await this.d.sessions.terminateByDevice({ deviceId, reason: 'DEVICE_REVOKED', atMs });
      } catch (e) {
        this.d.alert?.('스캐너 기기 폐기 뒤 identity 세션 종료에 실패했다', { deviceId, err: e instanceof Error ? e.message : String(e) });
      }
    }
    return deviceView(device);
  }

  /** 등록 코드를 새로 만든다. 같은 기기의 옛 코드는 덮어써 무효가 된다(SCR-053 '새 코드 만들기') */
  async issueCode(q: { deviceId: unknown }): Promise<{ enrollmentCode: string; enrollmentCodeExpiresAt: string }> {
    const deviceId = assertDeviceId(q.deviceId);
    const device = await this.d.store.findById(deviceId);
    if (!device) throw new ScannerDeviceNotFound();
    if (device.status !== 'ACTIVE') throw new ScannerDeviceInactive();
    const code = newEnrollmentCode();
    const atMs = this.d.clock.now();
    await this.d.codes.put({ codeHash: enrollmentCodeHash(code), deviceId, ttlMs: ENROLLMENT_CODE_TTL_MS });
    return { enrollmentCode: code, enrollmentCodeExpiresAt: new Date(atMs + ENROLLMENT_CODE_TTL_MS).toISOString() };
  }

  /**
   * 등록 코드(정규화·SHA-256)를 한 번만 꺼내 ACTIVE 기기에 jkt를 묶는다.
   * 출발지 IP 실패 한도는 코드를 꺼내기 전에 본다(막힌 IP가 코드를 소모하지 않게).
   * 실패는 IP·전체 카운터에 세고, 성공은 세지 않는다(O-T42).
   */
  async enroll(q: { code: unknown; jkt: unknown; ip?: string }): Promise<{ deviceId: string }> {
    const ip = q.ip && q.ip.length <= 128 ? q.ip : 'unknown';
    if (this.d.limiter && !(await this.d.limiter.allowed(ip))) throw new EnrollmentRateLimited();
    const fail = async (reason: EnrollmentCodeRejected['reason']): Promise<never> => {
      if (this.d.limiter) {
        const r = await this.d.limiter.failed(ip);
        if (r.globalAlert) this.d.alert?.('스캐너 등록 전체 실패가 10분 100회를 넘었다(SEV3, 등록 경로는 닫지 않는다)', { failures: r.globalFailures });
      }
      throw new EnrollmentCodeRejected(reason);
    };
    const code = normalizeEnrollmentCode(q.code);
    if (!code) return fail('INVALID');
    const jkt = assertJkt(q.jkt);
    const deviceId = await this.d.codes.take(enrollmentCodeHash(code));
    if (!deviceId) return fail('USED');
    try {
      const device = await this.d.store.bindCredential({ deviceId, jkt, atMs: this.d.clock.now() });
      if (!device) return fail('DEVICE');
      return { deviceId: device.deviceId };
    } catch (e) {
      if (e instanceof ScannerDeviceKeyConflict) return fail('KEY_IN_USE');
      throw e;
    }
  }
}
