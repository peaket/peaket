// 스캐너 기기 원장 쓰임새(BUILD_ORDER GAT-170, offline-gate §6.1). 등록·목록·폐기·등록 코드 소비.
import type { Clock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import type { EnrollmentCodeStore, ScannerDeviceStore } from '../domain/ports.js';
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
    const device = await this.d.store.revoke({ deviceId, reason, atMs: this.d.clock.now() });
    if (!device) throw new ScannerDeviceNotFound();
    return deviceView(device);
  }

  /** 등록 코드(정규화·SHA-256)를 한 번만 꺼내 ACTIVE 기기에 jkt를 묶는다 */
  async enroll(q: { code: unknown; jkt: unknown }): Promise<{ deviceId: string }> {
    const code = normalizeEnrollmentCode(q.code);
    if (!code) throw new EnrollmentCodeRejected('INVALID');
    const jkt = assertJkt(q.jkt);
    const deviceId = await this.d.codes.take(enrollmentCodeHash(code));
    if (!deviceId) throw new EnrollmentCodeRejected('USED');
    try {
      const device = await this.d.store.bindCredential({ deviceId, jkt, atMs: this.d.clock.now() });
      if (!device) throw new EnrollmentCodeRejected('DEVICE');
      return { deviceId: device.deviceId };
    } catch (e) {
      if (e instanceof ScannerDeviceKeyConflict) throw new EnrollmentCodeRejected('KEY_IN_USE');
      throw e;
    }
  }
}
