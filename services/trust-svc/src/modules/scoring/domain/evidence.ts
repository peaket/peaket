// 판정 근거 조회(trust.proto TrustEvidenceService.GetVerdictEvidence, docs/features/bot-defense.md §12 '판정에 쓰는 자료', B-T15 ①)의 값과 규칙.
// 이의 심사(ops-svc)가 판정 근거 키(tr:vb:{pid}:E, §3.2)와 그 키의 기기 이력(tr:devhist)을 읽는다. 읽기만 한다.
// 응답에는 사유 범주·확정 신호 종류·판정 출처·판정 시각·프로필 판·그 기기의 지난 30일 추가 검증 수만 싣는다.
// 점수 원값·가중치·기준값·기기 가명·판정 키는 CS에게도 보이지 않으므로 이 층의 값에 두지 않는다(POL-006, SCR-067과 같은 원칙).
// 저장소를 부르지 않는 순수 규칙이다. 오류 문구에는 칸 이름만 싣고 받은 값을 싣지 않는다.
import { DEVICE_REF } from './labels.js';
import { type DeviceHistory, type HardSignal, type ReasonCategory, REASONS } from './types.js';

/** 판정 근거의 사유 범주: 실시간 판정의 다섯과 재평가 R2의 SHARED_PATTERN(trust.proto ReasonCategory, §8 재평가) */
export const EVIDENCE_REASONS = [...REASONS, 'SHARED_PATTERN'] as const;
export type EvidenceReason = ReasonCategory | 'SHARED_PATTERN';

/** 판정을 낸 곳(trust.proto EvidenceSource): 로비 입장·사전 검증의 실시간 판정, 대기 중 재평가의 격리 */
export const EVIDENCE_SOURCES = ['REALTIME', 'REASSESS'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

const HARD_SIGNALS: readonly HardSignal[] = ['NONE', 'BLOCK_LIST', 'HONEYPOT'];

/** 판정 근거 키의 값(docs/data.md tr:vb). source는 재평가 격리만 REASSESS로 쓴다. 없으면 실시간 판정이다(ScoreRisk는 쓰지 않는다) */
export interface StoredVerdictEvidence {
  eventKey: string;
  deviceRef: string | undefined;
  hardSignal: HardSignal;
  reason: EvidenceReason;
  source?: EvidenceSource;
  profileVersion: number;
  decidedAtMs: number;
}

/** 저장소가 근거 키와 그 기기의 이력을 읽어 돌려주는 값. 기기 가명·판정 키를 싣지 않는다(응답으로 새지 않게) */
export interface EvidenceRead {
  reason: EvidenceReason;
  hardSignal: HardSignal;
  source: EvidenceSource;
  profileVersion: number;
  decidedAtMs: number;
  /** 근거 키의 기기(키 회전의 이어 달기를 따라간 값)의 지난 30일 추가 검증 보냄·통과·실패 수. 근거에 기기가 없으면 모두 0 */
  deviceChallenges: DeviceHistory;
}

/** 조회 결과. 근거 키가 없으면(30일이 지났거나 키를 잃음) found false이고 다른 값이 없다 */
export type EvidenceView = { found: false } | ({ found: true } & EvidenceRead);

export interface EvidenceQuery {
  eventId: string;
  pid: string;
}

/** 회차 ID·pid: 판정 키와 같은 모양(Redis 해시 태그 안에 들어간다) */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

export class EvidenceQueryInvalid extends Error {
  constructor(readonly field: 'event_id' | 'pid') {
    // 칸 이름만 싣는다(값을 싣지 않는다)
    super(`판정 근거 조회 요청의 ${field} 칸이 틀렸다`);
    this.name = 'EvidenceQueryInvalid';
  }
}

/** 모양이 틀리면 EvidenceQueryInvalid(유스케이스가 INVALID_ARGUMENT로 바꾼다). 저장소를 읽기 전에 부른다 */
export function validateEvidenceQuery(q: EvidenceQuery): EvidenceQuery {
  if (!KEY_PART.test(q.eventId)) throw new EvidenceQueryInvalid('event_id');
  if (!KEY_PART.test(q.pid)) throw new EvidenceQueryInvalid('pid');
  return { eventId: q.eventId, pid: q.pid };
}

const nonNegativeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * 저장된 판정 근거 키 값(JSON 글)을 읽는다. 읽을 수 없거나 칸이 틀린 값은 근거가 없는 것으로 본다(undefined: 이의 심사는 처리함 건의 사유 범주로 판단한다).
 * 틀린 확정 신호를 NONE으로 고쳐 보이면 CS가 차단 목록 판정을 아니라고 잘못 볼 수 있어 고치지 않고 버린다.
 * 기기 가명만은 모양이 틀리면 기기가 없는 근거로 본다(라벨 반영 저장소와 같다)
 */
export function parseStoredEvidence(raw: string): StoredVerdictEvidence | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (!isOneOf(EVIDENCE_REASONS, o.reason) || !isOneOf(HARD_SIGNALS, o.hardSignal)) return undefined;
  if (o.source !== undefined && !isOneOf(EVIDENCE_SOURCES, o.source)) return undefined;
  if (!nonNegativeInt(o.profileVersion) || !nonNegativeInt(o.decidedAtMs)) return undefined;
  return {
    eventKey: typeof o.eventKey === 'string' ? o.eventKey : '',
    deviceRef: typeof o.deviceRef === 'string' && DEVICE_REF.test(o.deviceRef) ? o.deviceRef : undefined,
    hardSignal: o.hardSignal,
    reason: o.reason,
    ...(o.source !== undefined ? { source: o.source } : {}),
    profileVersion: o.profileVersion,
    decidedAtMs: o.decidedAtMs,
  };
}

/** 저장된 값과 그 기기의 이력에서 조회 값을 만든다. 기기 가명·판정 키는 여기서 떨어진다 */
export function evidenceReadOf(e: StoredVerdictEvidence, deviceChallenges: DeviceHistory): EvidenceRead {
  return {
    reason: e.reason,
    hardSignal: e.hardSignal,
    source: e.source ?? 'REALTIME',
    profileVersion: e.profileVersion,
    decidedAtMs: e.decidedAtMs,
    deviceChallenges: { sent: deviceChallenges.sent, passed: deviceChallenges.passed, failed: deviceChallenges.failed },
  };
}

export const NO_DEVICE_HISTORY: Readonly<DeviceHistory> = Object.freeze({ sent: 0, passed: 0, failed: 0 });
