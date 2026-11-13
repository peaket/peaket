// 스캐너 목록·변경분·스캔·이상 표시 쓰임새(BUILD_ORDER GAT-180·GAT-190, offline-gate §6.3~§7.2).
// 회차는 스태프 세션의 회차와 같아야 한다. 다른 회차를 경로로 부르면 403으로 닫는다.
import type { Clock } from '@peaket/platform';
import type { ScannerGateStore } from '../domain/ports.js';
import {
  assertAfter,
  assertChangesLimit,
  assertEventId,
  assertFlagCursor,
  assertFlagLimit,
  assertFlagStatus,
  assertNote,
  assertUuid,
  normalizeScanBatch,
  type GateFlagPage,
  type GateFlagStatus,
  type GateFlagView,
  type ScanBatchResult,
  type ScannerChangesView,
  type ScannerPackageView,
} from '../domain/scanner-gate.js';

export class ScannerGateForbidden extends Error {
  constructor() {
    super('스캐너 세션의 회차와 요청 회차가 다르다');
    this.name = 'ScannerGateForbidden';
  }
}

export class ScannerFlagNotFound extends Error {
  constructor() {
    super('이상 표시를 찾을 수 없다');
    this.name = 'ScannerFlagNotFound';
  }
}

export interface ScannerGateDeps {
  store: ScannerGateStore;
  clock: Clock;
}

export class ScannerGate {
  constructor(private readonly d: ScannerGateDeps) {}

  async package(eventIdRaw: unknown, sessionEventId: string | undefined): Promise<ScannerPackageView> {
    const eventId = assertEventId(eventIdRaw);
    this.#sameEvent(eventId, sessionEventId);
    return this.d.store.package({ eventId, nowMs: this.d.clock.now() });
  }

  async changes(eventIdRaw: unknown, afterRaw: unknown, limitRaw: unknown, sessionEventId: string | undefined): Promise<ScannerChangesView> {
    const eventId = assertEventId(eventIdRaw);
    this.#sameEvent(eventId, sessionEventId);
    return this.d.store.changes({ eventId, after: assertAfter(afterRaw), limit: assertChangesLimit(limitRaw) });
  }

  /** 업로드는 현재 스태프 세션의 회차만 받는다. 다른 회차 기록은 403으로 닫고 저장하지 않는다(WRONG_EVENT) */
  async scans(i: {
    eventIdRaw: unknown;
    sessionEventId: string | undefined;
    deviceId: string;
    staffAccountId: string;
    sessionId: string;
    body: unknown;
  }): Promise<ScanBatchResult> {
    const eventId = assertEventId(i.eventIdRaw);
    this.#sameEvent(eventId, i.sessionEventId);
    const scans = normalizeScanBatch(i.body);
    if (scans.some((s) => s.eventId !== eventId)) throw new ScannerGateForbidden();
    return this.d.store.acceptScans({
      eventId,
      deviceId: i.deviceId,
      staffAccountId: i.staffAccountId,
      sessionId: i.sessionId,
      scans,
      nowMs: this.d.clock.now(),
    });
  }

  async listFlags(i: { eventIdRaw: unknown; sessionEventId: string | undefined; cursor: unknown; limit: unknown }): Promise<GateFlagPage> {
    const eventId = assertEventId(i.eventIdRaw);
    this.#sameEvent(eventId, i.sessionEventId);
    const cursor = assertFlagCursor(i.cursor);
    return this.d.store.listFlags({ eventId, ...(cursor !== undefined ? { cursor } : {}), limit: assertFlagLimit(i.limit) });
  }

  async resolveFlag(i: {
    eventIdRaw: unknown;
    sessionEventId: string | undefined;
    flagIdRaw: unknown;
    status: unknown;
    note?: unknown;
    resolvedBy: string;
  }): Promise<GateFlagView> {
    const eventId = assertEventId(i.eventIdRaw);
    this.#sameEvent(eventId, i.sessionEventId);
    const flagId = assertUuid(i.flagIdRaw, 'FLAG');
    const owner = await this.d.store.flagEventId(flagId);
    if (!owner) throw new ScannerFlagNotFound();
    if (owner !== eventId) throw new ScannerGateForbidden();
    const status: GateFlagStatus = assertFlagStatus(i.status);
    const note = assertNote(i.note);
    const flag = await this.d.store.resolveFlag({
      eventId,
      flagId,
      status,
      ...(note !== undefined ? { note } : {}),
      resolvedBy: i.resolvedBy,
      nowMs: this.d.clock.now(),
    });
    if (!flag) throw new ScannerFlagNotFound();
    return flag;
  }

  #sameEvent(eventId: string, sessionEventId: string | undefined): void {
    if (sessionEventId !== undefined && sessionEventId !== eventId) throw new ScannerGateForbidden();
  }
}
