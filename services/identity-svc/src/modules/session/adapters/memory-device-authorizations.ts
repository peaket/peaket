// 시험·로컬용 기기 승인 요청 저장소. 운영은 RedisDeviceAuthorizations다.
import type { ApprovedScannerSession, DeviceAuthorizationPoll, DeviceAuthorizationRecord } from '../domain/device-approval.js';
import type { DeviceAuthorizationStore } from '../domain/ports.js';

export class MemoryDeviceAuthorizations implements DeviceAuthorizationStore {
  readonly byHash = new Map<string, DeviceAuthorizationRecord>();
  readonly byUserCode = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  async save(r: DeviceAuthorizationRecord): Promise<void> {
    this.byHash.set(r.deviceCodeHash, structuredClone(r));
    this.byUserCode.set(r.userCode, r.deviceCodeHash);
  }

  async findByUserCode(userCode: string): Promise<DeviceAuthorizationRecord | null> {
    const hash = this.byUserCode.get(userCode);
    return hash === undefined ? null : this.get(hash);
  }

  async get(deviceCodeHash: string): Promise<DeviceAuthorizationRecord | null> {
    const r = this.byHash.get(deviceCodeHash);
    if (!r) return null;
    if (r.expiresAtMs <= this.now()) {
      this.byHash.delete(deviceCodeHash);
      this.byUserCode.delete(r.userCode);
      return null;
    }
    return structuredClone(r);
  }

  async approve(i: { deviceCodeHash: string; approved: ApprovedScannerSession; nowMs: number }): Promise<boolean> {
    const r = this.byHash.get(i.deviceCodeHash);
    if (!r || r.status !== 'PENDING' || r.expiresAtMs <= i.nowMs) return false;
    this.byHash.set(i.deviceCodeHash, { ...r, status: 'APPROVED', approved: structuredClone(i.approved) });
    return true;
  }

  async deny(deviceCodeHash: string, nowMs: number): Promise<boolean> {
    const r = this.byHash.get(deviceCodeHash);
    if (!r || r.status !== 'PENDING' || r.expiresAtMs <= nowMs) return false;
    this.byHash.set(deviceCodeHash, { ...r, status: 'DENIED' });
    return true;
  }

  async notePoll(deviceCodeHash: string, nowMs: number): Promise<DeviceAuthorizationPoll> {
    const r = this.byHash.get(deviceCodeHash);
    if (!r || r.expiresAtMs <= nowMs) return { result: 'EXPIRED' };
    if (r.lastPolledAtMs !== undefined && nowMs - r.lastPolledAtMs < r.intervalSec * 1000) {
      return { result: 'SLOW_DOWN', retryAfterMs: r.intervalSec * 1000 - (nowMs - r.lastPolledAtMs) };
    }
    this.byHash.set(deviceCodeHash, { ...r, lastPolledAtMs: nowMs });
    if (r.status === 'APPROVED' && r.approved) return { result: 'APPROVED', approved: structuredClone(r.approved) };
    if (r.status === 'DENIED') return { result: 'DENIED' };
    return { result: 'PENDING' };
  }
}

export class MemoryDeviceApprovalLimits {
  readonly #issued = new Map<string, number[]>();
  readonly #approvals = new Map<string, number[]>();

  private static allow(map: Map<string, number[]>, key: string, nowMs: number, windowMs: number, max: number): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const since = nowMs - windowMs;
    const kept = (map.get(key) ?? []).filter((t) => t > since);
    if (kept.length >= max) {
      const oldest = kept[0]!;
      return { allowed: false, retryAfterMs: Math.max(0, oldest + windowMs - nowMs) };
    }
    kept.push(nowMs);
    map.set(key, kept);
    return { allowed: true };
  }

  async allowIssue(deviceId: string, nowMs: number): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
    return MemoryDeviceApprovalLimits.allow(this.#issued, deviceId, nowMs, 60 * 60_000, 10);
  }

  async allowApproval(accountId: string, nowMs: number): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
    return MemoryDeviceApprovalLimits.allow(this.#approvals, accountId, nowMs, 10 * 60_000, 5);
  }
}
