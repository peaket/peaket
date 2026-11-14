// 시험·로컬용 스캐너 기기 원장. 운영은 DrizzleScannerDeviceStore다.
import type { ScannerDeviceListInput, ScannerDeviceListResult, ScannerDeviceStore } from '../domain/ports.js';
import { type ScannerDeviceRecord, ScannerDeviceInputError, ScannerDeviceKeyConflict } from '../domain/scanner-device.js';

export class MemoryScannerDeviceStore implements ScannerDeviceStore {
  readonly devices = new Map<string, ScannerDeviceRecord>();

  async list(i: ScannerDeviceListInput): Promise<ScannerDeviceListResult> {
    const ids = [...this.devices.keys()].sort();
    const start = i.cursor === undefined ? 0 : ids.findIndex((id) => id > i.cursor!);
    const from = start < 0 ? ids.length : start;
    const page = ids.slice(from, from + i.limit);
    return { devices: page.map((id) => structuredClone(this.devices.get(id)!)), ...(from + i.limit < ids.length ? { nextCursor: page.at(-1) } : {}) };
  }

  async findById(deviceId: string): Promise<ScannerDeviceRecord | undefined> {
    const d = this.devices.get(deviceId);
    return d ? structuredClone(d) : undefined;
  }

  async register(i: { deviceId: string; name: string; promoterId: string; enrolledBy: string; atMs: number }): Promise<ScannerDeviceRecord> {
    const d: ScannerDeviceRecord = {
      deviceId: i.deviceId,
      name: i.name,
      promoterId: i.promoterId,
      status: 'ACTIVE',
      credentialType: 'DEVICE_KEY',
      enrolledBy: i.enrolledBy,
      enrolledAtMs: i.atMs,
    };
    this.devices.set(d.deviceId, d);
    return structuredClone(d);
  }

  async revoke(i: { deviceId: string; reason: string; atMs: number }): Promise<ScannerDeviceRecord | undefined> {
    const d = this.devices.get(i.deviceId);
    if (!d || d.status !== 'ACTIVE') return undefined;
    const next: ScannerDeviceRecord = { ...d, status: 'REVOKED', revokedAtMs: i.atMs, revokeReason: i.reason };
    this.devices.set(i.deviceId, next);
    return structuredClone(next);
  }

  async bindCredential(i: { deviceId: string; jkt: string; atMs: number }): Promise<ScannerDeviceRecord | undefined> {
    const d = this.devices.get(i.deviceId);
    if (!d || d.status !== 'ACTIVE') return undefined;
    for (const other of this.devices.values()) {
      if (other.deviceId !== i.deviceId && other.credentialThumbprint === i.jkt) throw new ScannerDeviceKeyConflict();
    }
    const next: ScannerDeviceRecord = { ...d, credentialType: 'DEVICE_KEY', credentialThumbprint: i.jkt };
    this.devices.set(i.deviceId, next);
    return structuredClone(next);
  }

  async byThumbprint(jkt: string): Promise<ScannerDeviceRecord | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(jkt)) throw new ScannerDeviceInputError('JKT');
    for (const d of this.devices.values()) if (d.credentialThumbprint === jkt) return structuredClone(d);
    return null;
  }

  async touch(deviceId: string, atMs: number): Promise<void> {
    const d = this.devices.get(deviceId);
    if (d) this.devices.set(deviceId, { ...d, lastSeenAtMs: atMs });
  }
}
