// 근무 준비(GET /v1/scanner/shift)와 준비 보고(PUT /v1/scanner/shift/readiness) 쓰임새
// (BUILD_ORDER GAT-170, offline-gate §6.2, ADR-0081).
// 응답 하나에 기기·배정·회차·게이트·근무 창·기기 상태·등록 상태·판매/입장 창·목록 동기화 나이·버전 벡터 신선도·기기 인증 방식을 담는다.
import type { Clock } from '@peaket/platform';
import type { ScannerDeviceStore, ScannerEventPolicyProvider, ScannerGateStore, ScannerShiftStore } from '../domain/ports.js';
import type { ScannerDeviceRecord } from '../domain/scanner-device.js';
import {
  assertClockOffsetMs,
  assertGateZone,
  assertPendingUploads,
  assertPlacementMode,
  assertReadinessPackageSeq,
  assertShiftDeviceId,
  assertShiftEventId,
  parsePlacementIfMatch,
  placementEtag,
  ScannerPlacementDeviceInactive,
  ScannerPlacementMissing,
  ScannerPlacementPreconditionRequired,
  ScannerPlacementReentryNotAllowed,
  type ScannerPlacementMode,
  type ScannerPlacementResultView,
  type ScannerShiftEventWindows,
  type ScannerShiftView,
} from '../domain/scanner-shift.js';
import { ScannerDeviceNotFound } from './scanner-devices.js';

/** CheckScannerSession이 확인한 스태프 세션 문맥(platform ScannerGuard가 채운다) */
export interface ScannerSessionContext {
  accountId: string;
  sessionId: string;
  deviceId: string;
  eventId: string;
  role: 'gate_staff' | 'gate_lead';
  proxy: boolean;
  assignmentId: string;
  validFromMs: number;
  validUntilMs: number;
}

export class ScannerPlacementForbidden extends Error {
  constructor() {
    super('다른 파트너의 기기는 배치할 수 없다');
    this.name = 'ScannerPlacementForbidden';
  }
}

export class ScannerPlacementPolicyUnavailable extends Error {
  constructor() {
    super('회차의 재입장 정책을 확인하지 못했다');
    this.name = 'ScannerPlacementPolicyUnavailable';
  }
}

export interface ScannerShiftDeps {
  devices: ScannerDeviceStore;
  shifts: ScannerShiftStore;
  gate: Pick<ScannerGateStore, 'versionVector'>;
  /** core-svc 회차 정책. 없으면 판매/입장 창을 싣지 않고 OUT 배치를 닫는다 */
  policy?: ScannerEventPolicyProvider;
  clock: Clock;
  maxOfflineMs: number;
}

export class ScannerShift {
  constructor(private readonly d: ScannerShiftDeps) {}

  async shift(ctx: ScannerSessionContext): Promise<ScannerShiftView> {
    const eventId = assertShiftEventId(ctx.eventId);
    const deviceId = assertShiftDeviceId(ctx.deviceId);
    const device = await this.#activeDevice(deviceId);
    const placement = await this.d.shifts.placementOf(eventId, deviceId);
    if (!placement) throw new ScannerPlacementMissing();
    const now = this.d.clock.now();
    const vector = { ...(await this.d.gate.versionVector(eventId, now)), maxOfflineMs: this.d.maxOfflineMs };
    const readiness = await this.d.shifts.readinessOf(eventId, deviceId);
    const policy = await this.#policy(eventId);
    const ageMs = readiness === undefined ? undefined : Math.max(0, now - readiness.reportedAtMs);
    const stale =
      readiness !== undefined &&
      (ageMs! > this.d.maxOfflineMs || readiness.packageSeq > vector.seq);
    return {
      serverTime: new Date(now).toISOString(),
      eventId,
      reentryAllowed: policy?.reentryAllowed ?? false,
      placement: { gateZone: placement.gateZone, mode: placement.mode },
      packageSeq: vector.seq,
      role: ctx.role,
      proxy: ctx.proxy,
      device: {
        deviceId: device.deviceId,
        name: device.name,
        status: device.status,
        credentialType: device.credentialType,
        enrolled: device.credentialThumbprint !== undefined,
        ...(device.lastSeenAtMs !== undefined ? { lastSeenAt: new Date(device.lastSeenAtMs).toISOString() } : {}),
        mtls: device.credentialType === 'MTLS_CERT',
      },
      assignment: {
        assignmentId: ctx.assignmentId,
        role: ctx.role,
        validFrom: new Date(ctx.validFromMs).toISOString(),
        validUntil: new Date(ctx.validUntilMs).toISOString(),
        proxy: ctx.proxy,
      },
      ...(this.#windows(policy) !== undefined ? { eventWindows: this.#windows(policy)! } : {}),
      package: {
        seq: vector.seq,
        issuedAt: vector.issuedAt,
        maxOfflineMs: this.d.maxOfflineMs,
        ...(readiness !== undefined
          ? {
              reportedAt: new Date(readiness.reportedAtMs).toISOString(),
              ageMs,
              reportedPackageSeq: readiness.packageSeq,
              clockOffsetMs: readiness.clockOffsetMs,
              pendingUploads: readiness.pendingUploads,
            }
          : {}),
        stale,
      },
      versionVector: vector,
      auth: { deviceProof: device.credentialType === 'MTLS_CERT' ? 'MTLS' : 'DPOP', staffSession: true },
    };
  }

  async reportReadiness(ctx: ScannerSessionContext, body: unknown): Promise<void> {
    const eventId = assertShiftEventId(ctx.eventId);
    const deviceId = assertShiftDeviceId(ctx.deviceId);
    await this.#activeDevice(deviceId);
    const placement = await this.d.shifts.placementOf(eventId, deviceId);
    if (!placement) throw new ScannerPlacementMissing();
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    await this.d.shifts.reportReadiness({
      eventId,
      deviceId,
      packageSeq: assertReadinessPackageSeq(b.packageSeq),
      clockOffsetMs: assertClockOffsetMs(b.clockOffsetMs),
      pendingUploads: assertPendingUploads(b.pendingUploads),
      reportedBy: ctx.accountId,
      atMs: this.d.clock.now(),
    });
  }

  async #activeDevice(deviceId: string): Promise<ScannerDeviceRecord> {
    const device = await this.d.devices.findById(deviceId);
    if (!device) throw new ScannerDeviceNotFound();
    if (device.status !== 'ACTIVE') throw new ScannerPlacementDeviceInactive();
    return device;
  }

  async #policy(eventId: string) {
    try {
      return await this.d.policy?.get(eventId);
    } catch {
      return undefined;
    }
  }

  #windows(policy: Awaited<ReturnType<ScannerEventPolicyProvider['get']>> | undefined): ScannerShiftEventWindows | undefined {
    if (!policy) return undefined;
    const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
    const w: ScannerShiftEventWindows = {
      ...(iso(policy.salesOpensAtMs) !== undefined ? { salesOpensAt: iso(policy.salesOpensAtMs)! } : {}),
      ...(iso(policy.salesEndsAtMs) !== undefined ? { salesEndsAt: iso(policy.salesEndsAtMs)! } : {}),
      ...(iso(policy.entryOpensAtMs) !== undefined ? { entryOpensAt: iso(policy.entryOpensAtMs)! } : {}),
      ...(iso(policy.entryClosesAtMs) !== undefined ? { entryClosesAt: iso(policy.entryClosesAtMs)! } : {}),
      ...(iso(policy.endsAtMs) !== undefined ? { endsAt: iso(policy.endsAtMs)! } : {}),
    };
    return Object.keys(w).length > 0 ? w : undefined;
  }
}

export interface ScannerPlacementsDeps {
  devices: ScannerDeviceStore;
  shifts: ScannerShiftStore;
  policy?: ScannerEventPolicyProvider;
  clock: Clock;
}

/** 기기 배치(파트너 SCR-037·현장 책임자 SCR-052). 배치는 그 회차에서 그 기기의 구역·모드다 */
export class ScannerPlacements {
  constructor(private readonly d: ScannerPlacementsDeps) {}

  async put(i: {
    eventIdRaw: unknown;
    deviceIdRaw: unknown;
    sessionEventId?: string;
    tenantId: string;
    actorId: string;
    ifMatch: unknown;
    body: unknown;
  }): Promise<ScannerPlacementResultView> {
    const eventId = assertShiftEventId(i.eventIdRaw);
    if (i.sessionEventId !== undefined && i.sessionEventId !== eventId) throw new ScannerPlacementForbidden();
    const deviceId = assertShiftDeviceId(i.deviceIdRaw);
    const expectedVersion = parsePlacementIfMatch(i.ifMatch);
    if (expectedVersion === undefined) throw new ScannerPlacementPreconditionRequired();
    const b = i.body && typeof i.body === 'object' ? (i.body as Record<string, unknown>) : {};
    const gateZone = assertGateZone(b.gateZone);
    const mode: ScannerPlacementMode = assertPlacementMode(b.mode);
    const device = await this.d.devices.findById(deviceId);
    if (!device) throw new ScannerDeviceNotFound();
    if (device.status !== 'ACTIVE') throw new ScannerPlacementDeviceInactive();
    if (device.promoterId !== i.tenantId) throw new ScannerPlacementForbidden();
    const partnerPath = i.sessionEventId === undefined;
    if (partnerPath || mode === 'OUT') {
      let policy;
      try {
        policy = await this.d.policy?.get(eventId);
      } catch {
        throw new ScannerPlacementPolicyUnavailable();
      }
      if (!policy) throw new ScannerPlacementPolicyUnavailable();
      if (partnerPath && policy.promoterId !== i.tenantId) throw new ScannerPlacementForbidden();
      if (mode === 'OUT' && !policy.reentryAllowed) throw new ScannerPlacementReentryNotAllowed();
    }
    const placed = await this.d.shifts.putPlacement({
      eventId,
      deviceId,
      gateZone,
      mode,
      setBy: i.actorId,
      atMs: this.d.clock.now(),
      expectedVersion,
    });
    return {
      eventId: placed.eventId,
      deviceId: placed.deviceId,
      gateZone: placed.gateZone,
      mode: placed.mode,
      version: placed.version,
      setBy: placed.setBy,
      setAt: new Date(placed.setAtMs).toISOString(),
    };
  }

  /** 응답 ETag. 컨트롤러가 쓴다 */
  static etagOf(version: number): string {
    return placementEtag(version);
  }
}
