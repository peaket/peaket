// 기기 승인 로그인 시작(RFC 8628, identity §6.1, offline-gate §6.1, GAT-220).
// 기기 키 증명을 통과한 스캐너가 1회용 기기 코드와 사용자 확인 코드를 받는다. 기기 원장(ticket-svc)이 ACTIVE일 때만 연다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import {
  DEVICE_CODE_INTERVAL_SEC,
  DEVICE_CODE_TTL_MS,
  hashDeviceCode,
  newDeviceCode,
  newUserCode,
} from '../domain/device-approval.js';
import { DEVICE_APPROVAL_LIMITS, DEVICE_AUTHORIZATIONS, type DeviceApprovalLimits, type DeviceAuthorizationStore, SCANNER_DEVICE_REGISTRY, type ScannerDeviceRegistry } from '../domain/ports.js';

export const SCANNER_APPROVAL_URL_ENV = 'PEAKET_SCANNER_APPROVAL_URL';
const DEFAULT_APPROVAL_URL = 'https://scanner.peaket.example/staff/approve';

export class DeviceAuthorizationError extends Error {
  constructor(readonly code: 'DEVICE_UNREGISTERED' | 'DEVICE_REVOKED' | 'RATE_LIMITED' | 'REGISTRY_UNAVAILABLE') {
    super(`기기 승인 오류: ${code}`);
    this.name = 'DeviceAuthorizationError';
  }
}

export interface DeviceAuthorizationStart {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

@Injectable()
export class StartDeviceAuthorization {
  constructor(
    @Inject(SCANNER_DEVICE_REGISTRY) private readonly registry: ScannerDeviceRegistry,
    @Inject(DEVICE_AUTHORIZATIONS) private readonly store: DeviceAuthorizationStore,
    @Inject(DEVICE_APPROVAL_LIMITS) private readonly limits: DeviceApprovalLimits,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { jkt: string; nowMs?: number }): Promise<DeviceAuthorizationStart> {
    const now = i.nowMs ?? this.clock.now();
    const device = await this.registry.byThumbprint(i.jkt);
    if (!device.found || !device.deviceId) throw new DeviceAuthorizationError('DEVICE_UNREGISTERED');
    if (device.status !== 'ACTIVE') throw new DeviceAuthorizationError('DEVICE_REVOKED');
    const allowed = await this.limits.allowIssue(device.deviceId, now);
    if (!allowed.allowed) throw new DeviceAuthorizationError('RATE_LIMITED');

    const deviceCode = newDeviceCode();
    const userCode = newUserCode();
    await this.store.save({
      deviceCodeHash: hashDeviceCode(deviceCode),
      userCode,
      deviceId: device.deviceId,
      deviceName: device.name ?? '',
      promoterId: device.promoterId ?? '',
      jkt: i.jkt,
      status: 'PENDING',
      createdAtMs: now,
      expiresAtMs: now + DEVICE_CODE_TTL_MS,
      intervalSec: DEVICE_CODE_INTERVAL_SEC,
    });
    const base = (process.env[SCANNER_APPROVAL_URL_ENV] ?? DEFAULT_APPROVAL_URL).replace(/#.*$/, '');
    return {
      deviceCode,
      userCode,
      verificationUriComplete: `${base}#code=${encodeURIComponent(userCode)}`,
      expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
      interval: DEVICE_CODE_INTERVAL_SEC,
    };
  }
}

/** 시험·로컬에서 새 ID를 고정한다. 없으면 UUIDv4 */
export const NEW_SCANNER_SESSION_ID = Symbol('identity.NewScannerSessionId');
export type NewScannerSessionId = () => string;
export const defaultScannerSessionId: NewScannerSessionId = randomUUID;
