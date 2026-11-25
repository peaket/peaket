// 스캐너 목록·변경분·스캔·이상 표시 쓰임새(BUILD_ORDER GAT-180·GAT-190, offline-gate §6.3~§7.2).
// 회차는 스태프 세션의 회차와 같아야 한다. 다른 회차를 경로로 부르면 403으로 닫는다.
import type { Clock, ScannerSessionCheck } from '@peaket/platform';
import { assertQueueReport } from '../domain/entry-close.js';
import type { EntryCloseStore, ScannerDeviceStore, ScannerEventPolicyProvider, ScannerGateStore, ScannerShiftStore } from '../domain/ports.js';
import { ScannerPlacementMissing } from '../domain/scanner-shift.js';
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
  type ScannerFreshnessDeviceView,
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
  /** 처음 저장한 기록의 판정·중복 지표(scanner_scans_received_total). 없으면 세지 않는다 */
  onScanStored?: (result: 'PASS' | 'REJECT' | 'CHECK' | 'duplicate') => void;
  /** POLICY 변경분을 적었을 때(로그 줄·지표, offline-gate §10.2) */
  onPolicyChanged?: (i: { eventId: string; reentryAllowed: boolean; seq: number }) => void;
  /** 큐 비움 보고 결과(ticket_scanner_queue_reports_total{result}: empty·pending·no_placement, §7.4) */
  onQueueReport?: (result: 'empty' | 'pending' | 'no_placement') => void;
  /** 입장 기록 마감 저장소(큐 비움 보고). 없으면 보고 경로가 503이다 */
  entryClose?: Pick<EntryCloseStore, 'putQueueReport'>;
  /** 현장 책임자 변경분에 실을 같은 구역 지연 기기(O-T20). 없으면 gate_lead에게 빈 목록 */
  freshness?: { staleDevices(i: { eventId: string; gateZone?: string; selfDeviceId?: string; nowMs: number }): Promise<ScannerFreshnessDeviceView[]> };
}

export class ScannerGate {
  readonly #maxOfflineMs: number;

  constructor(private readonly d: ScannerGateDeps) {
    this.#maxOfflineMs = d.maxOfflineMs ?? DEFAULT_SCANNER_MAX_OFFLINE_MS;
  }

  async package(eventIdRaw: unknown, sessionEventId: string | undefined): Promise<ScannerPackageView> {
    const eventId = assertEventId(eventIdRaw);
    this.#sameEvent(eventId, sessionEventId);
    const now = this.d.clock.now();
    // 재입장 정책의 원본은 core-svc 회차다. 사본을 먼저 맞춘 뒤 목록을 읽어 POLICY 번호까지 함께 싣는다(C1-10, §6.3).
    const core = await this.#policy(eventId);
    const synced = await this.d.store.syncPolicy({ eventId, ...(core ? { coreReentryAllowed: core.reentryAllowed } : {}), atMs: now });
    this.#policyChanged(eventId, synced);
    const p = await this.d.store.package({ eventId, nowMs: now });
    return { ...p, reentryAllowed: synced.reentryAllowed ?? false, versionVector: { ...p.versionVector, maxOfflineMs: this.#maxOfflineMs } };
  }

  async changes(eventIdRaw: unknown, afterRaw: unknown, limitRaw: unknown, sessionEventId: string | undefined, deviceId?: string, role?: string): Promise<ScannerChangesView> {
    const eventId = assertEventId(eventIdRaw);
    this.#sameEvent(eventId, sessionEventId);
    const now = this.d.clock.now();
    const core = await this.#policy(eventId);
    const synced = await this.d.store.syncPolicy({ eventId, ...(core ? { coreReentryAllowed: core.reentryAllowed } : {}), atMs: now });
    this.#policyChanged(eventId, synced);
    const c = await this.d.store.changes({ eventId, after: assertAfter(afterRaw), limit: assertChangesLimit(limitRaw), nowMs: now });
    // 신선도 경보(O-T20)의 기준은 '변경분을 실제로 받은 시각'이다. 실패해도 응답을 막지 않는다.
    if (deviceId !== undefined && this.d.devices) await this.d.devices.touchChanges(deviceId, now).catch(() => undefined);
    let staleDevices: ScannerFreshnessDeviceView[] | undefined;
    if (role === 'gate_lead') {
      let gateZone: string | undefined;
      if (deviceId !== undefined && this.d.shifts) {
        try {
          gateZone = (await this.d.shifts.placementOf(eventId, deviceId))?.gateZone;
        } catch {
          gateZone = undefined;
        }
      }
      if (this.d.freshness) {
        try {
          staleDevices = await this.d.freshness.staleDevices({
            eventId,
            ...(gateZone !== undefined ? { gateZone } : {}),
            ...(deviceId !== undefined ? { selfDeviceId: deviceId } : {}),
            nowMs: now,
          });
        } catch {
          staleDevices = [];
        }
      } else {
        staleDevices = [];
      }
    }
    return {
      ...c,
      ...(staleDevices !== undefined ? { staleDevices } : {}),
      versionVector: { ...c.versionVector, maxOfflineMs: this.#maxOfflineMs },
    };
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
    return this.d.store
      .acceptScans({
        eventId,
        deviceId: i.deviceId,
        ...(i.staffAccountId !== undefined ? { staffAccountId: i.staffAccountId } : {}),
        ...(i.sessionId !== undefined ? { sessionId: i.sessionId } : {}),
        ...(placement ? { placement: { gateZone: placement.gateZone, mode: placement.mode } } : {}),
        ...(policy ? { reentryAllowed: policy.reentryAllowed } : {}),
        ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
        scans,
        nowMs: now,
        staleVersionIds: staleIds,
      })
      .then((r) => {
        if (this.d.onScanStored) {
          const dup = new Set(r.duplicateIds ?? []);
          for (const s of scans) this.d.onScanStored(dup.has(s.id) ? 'duplicate' : s.result);
        }
        return r;
      });
  }

  async listFlags(i: { eventIdRaw: unknown; sessionEventId: string | undefined; deviceId?: string; cursor: unknown; limit: unknown }): Promise<GateFlagPage> {
    const eventId = assertEventId(i.eventIdRaw);
    this.#sameEvent(eventId, i.sessionEventId);
    // 그 회차 배치가 없는 기기는 409 no-placement다(offline-gate §7.2). 배치가 있으면 그 구역만 본다
    const placement = this.d.shifts ? await this.d.shifts.placementOf(eventId, i.deviceId ?? '') : undefined;
    if (this.d.shifts && !placement) throw new ScannerPlacementMissing();
    const cursor = assertFlagCursor(i.cursor);
    return this.d.store.listFlags({
      eventId,
      ...(placement ? { gateZone: placement.gateZone } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      limit: assertFlagLimit(i.limit),
    });
  }

  /** 큐 비움 보고(offline-gate §7.3). 기기 인증만으로도 되고, 배치가 없으면 저장하지 않고 409다 */
  async queueReport(i: { eventIdRaw: unknown; sessionEventId: string | undefined; deviceId: string; body: unknown }): Promise<void> {
    const eventId = assertEventId(i.eventIdRaw);
    this.#sameEvent(eventId, i.sessionEventId);
    const { pendingUploads } = assertQueueReport(i.body);
    const placement = this.d.shifts ? await this.d.shifts.placementOf(eventId, i.deviceId) : undefined;
    if (this.d.shifts && !placement) {
      this.d.onQueueReport?.('no_placement');
      throw new ScannerPlacementMissing();
    }
    if (!this.d.entryClose) throw new Error('입장 기록 마감 저장소가 조립되지 않았다');
    const stored = await this.d.entryClose.putQueueReport({ eventId, deviceId: i.deviceId, pendingUploads, nowMs: this.d.clock.now() });
    if (stored === 'no_placement') {
      this.d.onQueueReport?.('no_placement');
      throw new ScannerPlacementMissing();
    }
    this.d.onQueueReport?.(pendingUploads === 0 ? 'empty' : 'pending');
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

  #policyChanged(eventId: string, synced: { reentryAllowed?: boolean; changedSeq?: number }): void {
    if (synced.changedSeq === undefined || synced.reentryAllowed === undefined) return;
    this.d.onPolicyChanged?.({ eventId, reentryAllowed: synced.reentryAllowed, seq: synced.changedSeq });
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
