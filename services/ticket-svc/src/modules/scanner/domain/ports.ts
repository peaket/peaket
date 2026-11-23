// 스캐너 기기 원장·등록 코드·DPoP jti·목록/스캔/이상 표시 저장소의 포트(BUILD_ORDER GAT-170·GAT-180).
import type {
  GateFlagPage,
  GateFlagStatus,
  GateFlagView,
  ScanBatchResult,
  ScanEventInput,
  ScannerChangesView,
  ScannerPackageView,
  ScannerVersionVector,
} from './scanner-gate.js';
import type { EntryCloseReason } from './entry-close.js';
import type { ScannerDeviceRecord } from './scanner-device.js';
import type { ScannerPlacementMode, ScannerPlacementRecord, ScannerReadinessRecord } from './scanner-shift.js';

export interface ScannerDeviceListInput {
  readonly cursor?: string;
  readonly limit: number;
}

export interface ScannerDeviceListResult {
  readonly devices: readonly ScannerDeviceRecord[];
  readonly nextCursor?: string;
}

export interface ScannerDeviceStore {
  list(i: ScannerDeviceListInput): Promise<ScannerDeviceListResult>;
  findById(deviceId: string): Promise<ScannerDeviceRecord | undefined>;
  register(i: { deviceId: string; name: string; promoterId: string; enrolledBy: string; atMs: number }): Promise<ScannerDeviceRecord>;
  revoke(i: { deviceId: string; reason: string; atMs: number }): Promise<ScannerDeviceRecord | undefined>;
  /** ACTIVE 기기에 기기 키 지문을 묶는다(재등록은 덮어쓴다). 없거나 ACTIVE가 아니면 undefined */
  bindCredential(i: { deviceId: string; jkt: string; atMs: number; credentialType?: 'DEVICE_KEY' | 'MTLS_CERT'; thumbprint?: string }): Promise<ScannerDeviceRecord | undefined>;
  /** platform ScannerGuard의 기기 찾기. 없으면 null, 있으면 상태와 파트너를 준다 */
  byThumbprint(jkt: string): Promise<ScannerDeviceRecord | null>;
  /** 마지막 연락 시각(관측용). 없거나 실패해도 요청을 막지 않는다 */
  touch(deviceId: string, atMs: number): Promise<void>;
  /** 마지막 변경분 수신 시각(O-T20 신선도 경보). 없거나 실패해도 요청을 막지 않는다 */
  touchChanges(deviceId: string, atMs: number): Promise<void>;
}

export const SCANNER_DEVICE_STORE = Symbol('ticket.ScannerDeviceStore');

/** ops-svc 기기 명령 한 번(request_id 멱등, ADR-0148). 같은 요청이 다시 오면 기기를 또 만들지 않는다 */
export interface ScannerDeviceCommand {
  readonly requestId: string;
  readonly action: 'REGISTER' | 'REVOKE' | 'REISSUE';
  readonly deviceId: string;
  readonly atMs: number;
}

export interface ScannerDeviceCommandStore {
  get(requestId: string): Promise<ScannerDeviceCommand | undefined>;
  put(command: ScannerDeviceCommand): Promise<void>;
}

export const SCANNER_DEVICE_COMMAND_STORE = Symbol('ticket.ScannerDeviceCommandStore');

/** 등록 코드 저장소. 원문은 넘기지 않고 SHA-256 해시만 다룬다 */
export interface EnrollmentCodeStore {
  /** 새 코드 해시를 기기에 묶는다. 같은 기기의 옛 코드는 무효가 된다 */
  put(i: { codeHash: string; deviceId: string; ttlMs: number }): Promise<void>;
  /**
   * 코드 해시를 한 번만 꺼낸다(원자적). 기기 ID와 처음 만료 시각(발급 + 10분을 넘지 않음)을 준다.
   * 없으면 undefined(만료·사용됨·그 기기의 지금 코드가 아님)
   */
  take(codeHash: string): Promise<{ deviceId: string; expiresAtMs: number } | undefined>;
  /**
   * 꺼낸 코드를 처음 만료 시각 그대로 되살린다(기기 키 저장의 일시 오류 뒤, O-T42 ⑤).
   * 만료됐거나(남은 시간 1ms 미만) 그 기기의 지금 코드가 다른 코드면 되살리지 않고 false
   */
  restore(i: { codeHash: string; deviceId: string; expiresAtMs: number }): Promise<boolean>;
}

export const ENROLLMENT_CODE_STORE = Symbol('ticket.EnrollmentCodeStore');
/** 스캐너 PWA 출처(PEAKET_SCANNER_PWA_ORIGIN). 기기 등록·스캔 올리기의 Origin과 정확히 같아야 한다(O-T35) */
export const SCANNER_PWA_ORIGIN = Symbol('ticket.ScannerPwaOrigin');
/** 게이트웨이 mTLS 신뢰 머리 비밀 값(없으면 인증서 등록 경로를 열지 않는다) */
export const SCANNER_MTLS_SECRET = Symbol.for('peaket.ticket.scanner-mtls-secret');

/** DPoP jti 저장소(platform DpopReplayStore와 같은 모양) */
export interface DpopReplayStore {
  claim(jti: string, ttlMs: number): Promise<boolean>;
}

export const DPOP_REPLAY_STORE = Symbol('ticket.DpopReplayStore');

/** 스캐너 목록·변경분·스캔·이상 표시 저장소. 판정과 일련번호 매기기는 저장소 트랜잭션 안에서 끝낸다. */
export interface ScannerGateStore {
  package(i: { eventId: string; nowMs: number }): Promise<ScannerPackageView>;
  /**
   * 회차 입장 정책 사본(scanner_event_policy)을 core 값과 견준다. 사본이 없으면 만들기만 하고,
   * 다르면 조건부로 바꾸면서 POLICY 변경을 같은 트랜잭션에 적는다(offline-gate §6.3).
   * DB 오류는 던지지 않고 사본 값 그대로 돌려준다. 사본도 없으면 빈 값이다.
   */
  syncPolicy(i: { eventId: string; coreReentryAllowed?: boolean; atMs: number }): Promise<{ reentryAllowed?: boolean; changedSeq?: number }>;
  /** 회차의 지금 버전 벡터(근무 준비 응답용, GAT-160). 변경 종류별 마지막 일련번호 */
  versionVector(eventId: string, nowMs: number): Promise<ScannerVersionVector>;
  changes(i: { eventId: string; after: number; limit: number; nowMs?: number }): Promise<ScannerChangesView>;
  acceptScans(i: {
    eventId: string;
    deviceId: string;
    /** 스태프 토큰의 지금 계정. 기기 단독 업로드는 세션 조회로 기록마다 정한다(C1-11) */
    staffAccountId?: string;
    sessionId?: string;
    /** 기기 배치(offline-gate §7.1). 없으면 구역·모드 재판정을 하지 않는다(시험 기본값) */
    placement?: { gateZone: string; mode: 'IN' | 'OUT' };
    /** 회차 입장 정책. 재입장 허용이면 IN 다음 IN을 NO_EXIT로 표시한다 */
    reentryAllowed?: boolean;
    /** 입장 기록 마감 시각(event.entry_closed_at). 이 뒤 기록은 받고 AFTER_CLOSE 표시 */
    entryClosesAtMs?: number;
    /** 스캔의 scannerSessionId로 찾은 세션 계정·유효 창(C1-11). 없으면 세션 ID만 대조한다 */
    sessions?: Readonly<Record<string, { accountId?: string; validFromMs?: number; validUntilMs?: number }>>;
    scans: readonly ScanEventInput[];
    nowMs: number;
    /** 낡은 버전 벡터로 판정한 기록 ID(GAT-160). STALE_VERSION 이상 표시를 만든다 */
    staleVersionIds?: readonly string[];
  }): Promise<ScanBatchResult>;
  /**
   * 이상 표시 목록(offline-gate §7.2 '책임자 이상 표시 목록 거르기'). gateZone은 요청한 기기의 그 회차 배치 구역이고,
   * 그 구역과 티켓 구역이 같은 표시만 주고 사후 검토 표시(OVERRIDE_REVIEW)는 넣지 않는다. 처리 상태로는 거르지 않는다.
   * gateZone이 없으면(배치를 모르는 단위 조립) 예전처럼 거르지 않는다. HTTP 경로는 배치가 없으면 409라 늘 값이 있다.
   */
  listFlags(i: { eventId: string; gateZone?: string; cursor?: string; limit: number }): Promise<GateFlagPage>;
  /** 이상 표시의 회차. 없으면 undefined. 다른 회차면 403으로 닫는 데 쓴다 */
  flagEventId(flagId: string): Promise<string | undefined>;
  resolveFlag(i: { eventId: string; flagId: string; status: GateFlagStatus; note?: string; resolvedBy: string; nowMs: number }): Promise<GateFlagView | undefined>;
}

export const SCANNER_GATE_STORE = Symbol('ticket.ScannerGateStore');

/** 기기 배치·근무 준비 보고 저장소(GAT-170 잔여, offline-gate §6.2). 배치를 바꾸면 PLACEMENT 변경을 같은 트랜잭션에 적는다 */
export interface ScannerShiftStore {
  placementOf(eventId: string, deviceId: string): Promise<ScannerPlacementRecord | undefined>;
  placementsOf(eventId: string): Promise<ScannerPlacementRecord[]>;
  /**
   * 배치를 넣거나 고친다. expectedVersion은 If-Match의 판(새 배치는 0)이고, 다르면 ScannerPlacementConflict를 던진다.
   * 바꾼 배치를 scanner_change(PLACEMENT)에 같은 트랜잭션으로 적는다.
   */
  putPlacement(i: {
    eventId: string;
    deviceId: string;
    gateZone: string;
    mode: ScannerPlacementMode;
    setBy: string;
    atMs: number;
    expectedVersion: number;
  }): Promise<ScannerPlacementRecord>;
  readinessOf(eventId: string, deviceId: string): Promise<ScannerReadinessRecord | undefined>;
  /** 그 회차에 근무 준비를 보고한(로그인했던) 기기 ID. 마감 판단이 '로그인했던 기기'를 고를 때 쓴다(offline-gate §7.3) */
  readinessDevices?(eventId: string): Promise<string[]>;
  reportReadiness(i: { eventId: string; deviceId: string; packageSeq: number; clockOffsetMs: number; pendingUploads: number; reportedBy: string; atMs: number }): Promise<ScannerReadinessRecord>;
  /** 회차의 지금 마지막 변경 일련번호(scanner_seq). 없으면 0 */
  lastSeq(eventId: string): Promise<number>;
  /** 배치가 하나라도 있는 회차 목록(O-T20 신선도 감시가 회차를 돈다) */
  eventsWithPlacements(): Promise<string[]>;
  /** 기기가 배치된 회차 목록(기기 폐기 때 SESSION_TERMINATED 변경분을 남길 곳, O-T27) */
  eventsOfDevice(deviceId: string): Promise<string[]>;
  /**
   * 기기 폐기로 끝난 세션을 그 기기가 배치된 회차마다 scanner_change(SESSION_TERMINATED)로 남긴다.
   * 남긴 회차 ID를 돌려준다. 세션이 없어도 기기 상태가 REVOKED면 다른 스캐너 화면은 알아야 한다.
   */
  appendSessionTerminated(i: { deviceId: string; reason: 'DEVICE_REVOKED'; atMs: number }): Promise<string[]>;
}

export const SCANNER_SHIFT_STORE = Symbol('ticket.ScannerShiftStore');

/** 기기 폐기 때 identity 스캐너 세션을 끝내고 control.sessions-terminated를 남기는 포트 */
export interface ScannerSessionTerminator {
  terminateByDevice(i: { deviceId: string; reason: 'DEVICE_REVOKED'; atMs: number }): Promise<number>;
}

export const SCANNER_SESSION_TERMINATOR = Symbol('ticket.ScannerSessionTerminator');

/** core-svc 회차의 판매·입장 창(offline-gate §6.2). ticket-svc는 core DB에 직접 붙지 않는다 */
export interface ScannerEventPolicy {
  /** 회차 판매자(테넌트). 파트너 배치의 회차 소유 확인에 쓴다 */
  promoterId: string;
  reentryAllowed: boolean;
  salesOpensAtMs?: number;
  salesEndsAtMs?: number;
  entryOpensAtMs?: number;
  entryClosesAtMs?: number;
  endsAtMs?: number;
}

export interface ScannerEventPolicyProvider {
  /** 회차가 없거나 core-svc가 답하지 못하면 undefined. 배치 검사는 undefined를 '모른다'로 닫는다 */
  get(eventId: string): Promise<ScannerEventPolicy | undefined>;
}

export const SCANNER_EVENT_POLICY = Symbol('ticket.ScannerEventPolicy');

/** 등록 시도 IP 실패 제한(offline-gate §6.1, O-T42). 성공은 세지 않는다 */
export interface EnrollmentAttemptLimiter {
  /** 지금 이 IP가 막히지 않았는가. false면 코드를 꺼내기 전에 429로 닫는다 */
  allowed(ip: string): Promise<boolean>;
  /** 실패 한 번을 세고, 전체 실패가 SEV3 경보 경계를 넘었는지 알린다 */
  failed(ip: string): Promise<{ globalAlert: boolean; globalFailures: number }>;
}

export const ENROLLMENT_ATTEMPT_LIMITER = Symbol('ticket.EnrollmentAttemptLimiter');

/** ops-svc internal /internal/v1/ops-alerts의 몸통과 같은 경보 한 건(SEV1~SEV3) */
export interface ScannerOpsAlert {
  readonly eventKey: string;
  readonly kind: string;
  readonly severity: 'SEV1' | 'SEV2' | 'SEV3';
  readonly source: string;
  readonly reason: string;
  readonly detail: Record<string, unknown>;
  readonly atMs: number;
}

/** O-T20 신선도 경보 한 건. 같은 경로를 쓰지만 등급은 SEV2다 */
export interface ScannerFreshnessAlert extends ScannerOpsAlert {
  readonly severity: 'SEV2';
}

export interface ScannerOpsAlertSink {
  open(alert: ScannerOpsAlert): Promise<void>;
}

export interface ScannerFreshnessResolution {
  readonly eventKey: string;
  readonly kind: string;
  readonly reason: string;
  readonly atMs: number;
}

/** ops-svc 기존 경보 경로를 부르는 포트(어댑터가 구현한다) */
export interface ScannerFreshnessAlertSink extends ScannerOpsAlertSink {
  open(alert: ScannerFreshnessAlert): Promise<void>;
  resolve(resolution: ScannerFreshnessResolution): Promise<void>;
}

// ---- 입장 기록 마감(offline-gate §7.3 'GAT-180 마감 규칙', BUILD_ORDER GAT-180) ----

/** 마감 판단이 읽고 쓰는 저장소. 마감 행·미보고 건 행은 한 트랜잭션(회차 잠금) 안에서 쓴다 */
export interface EntryCloseStore {
  /** 배치가 없으면 'no_placement'(저장 안 함). 받은 시각은 nowMs. 기기·회차마다 마지막 보고 하나를 덮어쓴다 */
  putQueueReport(i: { eventId: string; deviceId: string; pendingUploads: number; nowMs: number }): Promise<'stored' | 'no_placement'>;
  /**
   * 마감 행이 없고 ticket.event_starts_at ≤ nowMs인 회차를 (event_starts_at, 회차 ID) 차례로 limit개까지 준다.
   * afterEventId가 있으면 그 회차 다음부터(돌아가며 보기, §7.3 '판단').
   */
  candidates(i: { nowMs: number; limit: number; afterEventId?: string }): Promise<string[]>;
  /**
   * 회차 잠금(배타) 안에서 기기·보고를 다시 읽어 decideEntryClose(경계는 nowMs) → 마감 행·미보고 건 행.
   * 이미 마감했으면 closed false. 마감 시각은 잠금을 잡은 뒤 읽은 clockNow다.
   */
  close(i: { eventId: string; nowMs: number; endsAtMs: number; clockNow: () => number }): Promise<{ closed: boolean; reason?: EntryCloseReason; closedAtMs?: number; unreported: number }>;
  closedAt(eventId: string): Promise<number | undefined>;
  pendingCoreSync(limit: number): Promise<{ eventId: string; closedAtMs: number }[]>;
  markCoreSynced(eventId: string, nowMs: number): Promise<void>;
  pendingCases(limit: number): Promise<{ eventId: string; deviceId: string; eventKey: string; createdAtMs: number }[]>;
  markCaseOpened(eventId: string, deviceId: string, nowMs: number): Promise<void>;
}

export const ENTRY_CLOSE_STORE = Symbol('ticket.EntryCloseStore');

/** core-svc 내부 입구 PUT /internal/v1/events/{eventId}/entry-closed. 2xx면 ok */
export interface EntryCloseCoreSink {
  notify(eventId: string, closedAtMs: number): Promise<{ ok: true; storedAtMs: number } | { ok: false; status?: number }>;
}

/** ops-svc CS 처리함 POST /internal/v1/cs-cases. 2xx ∧ accepted true만 true */
export interface ScannerCaseSink {
  open(c: { eventKey: string; kind: 'SCANNER_UNREPORTED'; sourceId: string; category: string; createdAt: string; dueBaseAt: string }): Promise<boolean>;
}
