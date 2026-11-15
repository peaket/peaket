// 스캐너 목록·변경분·스캔·이상 표시 쓰임새(BUILD_ORDER GAT-180·GAT-190, offline-gate §6.3~§7.2).
// 회차는 스태프 세션의 회차와 같아야 한다. 다른 회차를 경로로 부르면 403으로 닫는다.
import type { Clock, ScannerSessionCheck } from '@peaket/platform';
import type { ScannerDeviceStore, ScannerEventPolicyProvider, ScannerGateStore, ScannerShiftStore } from '../domain/ports.js';
import {
  assertAfter,
  assertChangesLimit,
  assertEventId,
  assertFlagCursor,
  assertFlagLimit,
  assertFlagStatus,
  assertNote,
  assertUuid,
  DEFAULT_SCANNER_MAX_OFFLINE_MS,
  isVersionVectorStale,
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

/** 예외 통과는 현장 책임자(gate_lead) 본인 세션만 한다. 대리 승인·일반 스태프·기기 단독은 403(C1-01) */
export class ScannerGateOverrideForbidden extends Error {
  constructor() {
    super('예외 통과는 현장 책임자 본인 세션에서만 할 수 있다');
    this.name = 'ScannerGateOverrideForbidden';
  }
}

export interface ScannerGateDeps {
  store: ScannerGateStore;
  clock: Clock;
  /** 기기 배치 확인. 운영은 늘 있고, 시험 기본값은 없다 */
  shifts?: Pick<ScannerShiftStore, 'placementOf'>;
  /** 변경분을 받은 기기의 수신 시각(O-T20 신선도 경보). 없으면 세지 않는다 */
  devices?: Pick<ScannerDeviceStore, 'touchChanges'>;
  /** 회차 입장 정책(core-svc). 목록의 reentryAllowed·마감 시각과 재판정에 쓴다 */
  policy?: ScannerEventPolicyProvider;
  /** scannerSessionId로 세션 계정·유효 창을 찾는 포트(기기 단독 업로드, C1-11) */
  sessions?: Pick<ScannerSessionCheck, 'check'>;
  /** 오프라인 허용 최대 시간(ms). 없으면 24시간 [가정] */
  maxOfflineMs?: number;
}

export class ScannerGate {
  readonly #maxOfflineMs: number;

  constructor(private readonly d: ScannerGateDeps) {
    this.#maxOfflineMs = d.maxOfflineMs ?? DEFAULT_SCANNER_MAX_OFFLINE_MS;
  }

  async package(eventIdRaw: unknown, sessionEventId: string | undefined): Promise<ScannerPackageView> {
    const eventId = assertEventId(eventIdRaw);
    this.#sameEvent(eventId, sessionEventId);
    const p = await this.d.store.package({ eventId, nowMs: this.d.clock.now() });
    // 재입장 정책의 원본은 core-svc 회차다. 정책을 못 읽으면 닫힌 쪽(false)으로 둔다(C1-10).
    const policy = await this.#policy(eventId);
    return { ...p, reentryAllowed: policy?.reentryAllowed ?? false, versionVector: { ...p.versionVector, maxOfflineMs: this.#maxOfflineMs } };
  }

  async changes(eventIdRaw: unknown, afterRaw: unknown, limitRaw: unknown, sessionEventId: string | undefined, deviceId?: string): Promise<ScannerChangesView> {
    const eventId = assertEventId(eventIdRaw);
    this.#sameEvent(eventId, sessionEventId);
    const now = this.d.clock.now();
    const c = await this.d.store.changes({ eventId, after: assertAfter(afterRaw), limit: assertChangesLimit(limitRaw), nowMs: now });
    // 신선도 경보(O-T20)의 기준은 '변경분을 실제로 받은 시각'이다. 실패해도 응답을 막지 않는다.
    if (deviceId !== undefined && this.d.devices) await this.d.devices.touchChanges(deviceId, now).catch(() => undefined);
    return { ...c, versionVector: { ...c.versionVector, maxOfflineMs: this.#maxOfflineMs } };
  }

  /** 업로드는 스태프 세션의 회차나(기기 인증만이면) 본문의 회차를 받는다. 다른 회차 기록은 403으로 닫고 저장하지 않는다 */
  async scans(i: {
    eventIdRaw: unknown;
    sessionEventId: string | undefined;
    deviceId: string;
    staffAccountId?: string;
    sessionId?: string;
    /** platform ScannerGuard가 채운 역할·대리 승인·역할 유효 창 */
    role?: string;
    proxy?: boolean;
    sessionValidFromMs?: number;
    sessionValidUntilMs?: number;
    body: unknown;
  }): Promise<ScanBatchResult> {
    const eventId = assertEventId(i.eventIdRaw);
    this.#sameEvent(eventId, i.sessionEventId);
    const scans = normalizeScanBatch(i.body);
    if (scans.some((s) => s.eventId !== eventId)) throw new ScannerGateForbidden();
    // 예외 통과는 책임자 본인 세션만. 기기 단독·일반 스태프·대리 승인은 기록을 받기 전에 403으로 닫는다.
    if (scans.some((s) => s.method === 'OVERRIDE') && (i.role !== 'gate_lead' || i.proxy === true)) throw new ScannerGateOverrideForbidden();
    // 배치가 없는 기기의 기록은 스태프 토큰이 있어도 받지 않는다(offline-gate §6.2). 기기 단독 업로드도 같다.
    const placement = this.d.shifts ? await this.d.shifts.placementOf(eventId, i.deviceId) : undefined;
    if (this.d.shifts && !placement) throw new ScannerGateForbidden();
    const now = this.d.clock.now();
    const policy = await this.#policy(eventId);
    const staleIds = scans
      .filter((s) => s.versionVector !== undefined && isVersionVectorStale(s.versionVector, now, this.#maxOfflineMs))
      .map((s) => s.id);
    // 기록마다 scannerSessionId로 그 세션의 계정·유효 창을 찾는다. 지금 세션이면 가드가 이미 확인한 값을 쓰고,
    // 지난 세션(기기 단독 업로드·교대 전 큐)이면 identity에 한 번 더 묻는다(C1-11).
    const sessions: Record<string, { accountId?: string; validFromMs?: number; validUntilMs?: number }> = {};
    for (const sessionId of new Set(scans.map((s) => s.scannerSessionId))) {
      if (i.sessionId === sessionId) {
        sessions[sessionId] = {
          ...(i.staffAccountId !== undefined ? { accountId: i.staffAccountId } : {}),
          ...(i.sessionValidFromMs !== undefined ? { validFromMs: i.sessionValidFromMs } : {}),
          ...(i.sessionValidUntilMs !== undefined ? { validUntilMs: i.sessionValidUntilMs } : {}),
        };
      } else if (this.d.sessions) {
        try {
          const a = await this.d.sessions.check({ scannerSessionId: sessionId, deviceId: i.deviceId });
          if (a.eventId === undefined || a.eventId === eventId) {
            sessions[sessionId] = {
              ...(a.accountId !== undefined ? { accountId: a.accountId } : {}),
              ...(a.validFromMs !== undefined ? { validFromMs: a.validFromMs } : {}),
              ...(a.validUntilMs !== undefined ? { validUntilMs: a.validUntilMs } : {}),
            };
          }
        } catch {
          // 세션을 못 찾으면 저장소가 세션 ID만 대조해 OUT_OF_SESSION으로 표시한다(버리지 않는다).
        }
      }
    }
    return this.d.store.acceptScans({
      eventId,
      deviceId: i.deviceId,
      ...(i.staffAccountId !== undefined ? { staffAccountId: i.staffAccountId } : {}),
      ...(i.sessionId !== undefined ? { sessionId: i.sessionId } : {}),
      ...(placement ? { placement: { gateZone: placement.gateZone, mode: placement.mode } } : {}),
      ...(policy ? { reentryAllowed: policy.reentryAllowed } : {}),
      ...(policy?.entryClosesAtMs !== undefined ? { entryClosesAtMs: policy.entryClosesAtMs } : {}),
      ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
      scans,
      nowMs: now,
      staleVersionIds: staleIds,
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

  async #policy(eventId: string) {
    try {
      return await this.d.policy?.get(eventId);
    } catch {
      return undefined;
    }
  }

  #sameEvent(eventId: string, sessionEventId: string | undefined): void {
    if (sessionEventId !== undefined && sessionEventId !== eventId) throw new ScannerGateForbidden();
  }
}
