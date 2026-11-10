// 라벨 반영(ApplyLabel)의 값과 규칙(docs/features/bot-defense.md §9 '첫 구현', trust.proto TrustLabelService, BUILD_ORDER BOT-065, ADR-0258).
// 사람이 확인한 판정(표본 검토, CS의 부정구매 확인, 이의 인정, 부정 예매 조치·소명 인정)만 차단 기기 목록을 바꾼다. 자동 신호로는 이 길이 없다(§9 '올리는 조건').
// 저장소를 부르지 않는 순수 규칙이다. 오류 문구에는 칸 이름만 싣고 받은 값을 싣지 않는다.
import { createHash } from 'node:crypto';
import type { HardSignal } from './types.js';

export const LABEL_SOURCES = ['SAMPLE_REVIEW', 'FRAUD_CONFIRMED', 'APPEAL_ACCEPTED', 'FRAUD_ACTIONED', 'FRAUD_APPEAL_ACCEPTED'] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];
export type Label = 'BOT' | 'HUMAN';
export type ReviewBatch = 'PASSED' | 'SHADOW_CHALLENGED';
/** 표본 검토 세션의 적용 판 판정(trust.proto Verdict 가운데 ALLOW·CHALLENGE만 받는다) */
export type AppliedVerdict = 'ALLOW' | 'CHALLENGE';
/** 받는 층이 계약에 없는 enum 값을 받았을 때. 검사가 INVALID_ARGUMENT로 막는다 */
export const UNKNOWN = 'UNKNOWN' as const;
type Raw<T> = T | typeof UNKNOWN | undefined;

/** 차단 기기 목록에 생긴 일(trust.proto BlockListChange) */
export type BlockListChange = 'NONE' | 'ADDED' | 'REMOVED' | 'DEVICE_NOT_FOUND';

export interface LabelRequest {
  sourceRef: string;
  sourceVersion: number;
  source: Raw<LabelSource>;
  label: Raw<Label>;
  eventId: string;
  pid: string;
  /** 없으면 '' */
  queueEntryId: string;
  actedBy: string;
  /** 부정 예매 출처만. 없으면 '' */
  deviceRef: string;
  reviewBatch: Raw<ReviewBatch>;
  appliedVerdict: Raw<AppliedVerdict | 'BLOCK'>;
  /** 표본 검토만: 뽑힌 판정의 적용 판 판정 기록 사건 키(UUID). 없으면 '' */
  verdictEventKey: string;
}

/** 검사를 지난 요청 */
export interface ValidLabel extends LabelRequest {
  source: LabelSource;
  label: Label;
  reviewBatch: ReviewBatch | undefined;
  appliedVerdict: AppliedVerdict | undefined;
}

export interface LabelResult {
  changed: boolean;
  blockList: BlockListChange;
}

/** 건 ID: 영문·숫자·_·- 1~64자(§9 '받는 값') */
const SOURCE_REF = /^[A-Za-z0-9_-]{1,64}$/;
/** 회차 ID·pid·대기 기록 ID: 판정 키와 같은 모양(Redis 해시 태그 안에 들어간다) */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** 기기 가명: 'k' + 판 번호 + '.' + base64url 43자(invRef, §3.2) */
export const DEVICE_REF = /^k([1-9][0-9]{0,8})\.[A-Za-z0-9_-]{43}$/;
/** 사건 키(UUID 모양). 판 번호와 변형은 보지 않는다 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTED_BY_MAX = 64;

/** 부정 예매 조사에서 오는 출처 둘: 멱등 키가 (건 ID, pid, 출처)이고 요청의 device_ref를 받으며 판정 기록으로 내지 않는다(§9 표) */
export const isFraudSource = (s: LabelSource): boolean => s === 'FRAUD_ACTIONED' || s === 'FRAUD_APPEAL_ACCEPTED';

/** 출처마다 받는 라벨. 두 라벨을 다 받는 출처는 판이 커지며 라벨이 바뀔 수 있다 */
const LABELS: Record<LabelSource, readonly Label[]> = {
  SAMPLE_REVIEW: ['BOT', 'HUMAN'],
  FRAUD_CONFIRMED: ['BOT', 'HUMAN'],
  APPEAL_ACCEPTED: ['HUMAN'],
  FRAUD_ACTIONED: ['BOT'],
  FRAUD_APPEAL_ACCEPTED: ['HUMAN'],
};

export class LabelInvalid extends Error {
  constructor(readonly field: string) {
    // 칸 이름만 싣는다(값을 싣지 않는다)
    super(`라벨 반영 요청의 ${field} 칸이 틀렸다`);
    this.name = 'LabelInvalid';
  }
}

/** §9 '받는 값'. 틀리면 LabelInvalid(받는 층이 INVALID_ARGUMENT로 바꾼다) */
export function validateLabel(r: LabelRequest): ValidLabel {
  if (!SOURCE_REF.test(r.sourceRef)) throw new LabelInvalid('source_ref');
  if (!(Number.isSafeInteger(r.sourceVersion) && r.sourceVersion >= 1)) throw new LabelInvalid('source_version');
  const source = r.source;
  if (source === undefined || source === UNKNOWN || !LABEL_SOURCES.includes(source)) throw new LabelInvalid('source');
  const label = r.label;
  if (label === undefined || label === UNKNOWN || !LABELS[source].includes(label)) throw new LabelInvalid('label');
  if (!KEY_PART.test(r.eventId)) throw new LabelInvalid('event_id');
  if (!KEY_PART.test(r.pid)) throw new LabelInvalid('pid');
  if (r.queueEntryId !== '' && !KEY_PART.test(r.queueEntryId)) throw new LabelInvalid('queue_entry_id');
  const actedBy = [...r.actedBy].length;
  if (actedBy < 1 || actedBy > ACTED_BY_MAX) throw new LabelInvalid('acted_by');
  if (r.deviceRef !== '') {
    if (!isFraudSource(source)) throw new LabelInvalid('device_ref');
    if (!DEVICE_REF.test(r.deviceRef)) throw new LabelInvalid('device_ref');
  }
  // 표본 검토면 묶음 표시·적용 판 판정·뽑힌 판정의 사건 키가 모두 있어야 하고, 다른 출처면 모두 비어야 한다(trust.proto review_batch·applied_verdict·verdict_event_key)
  if (source === 'SAMPLE_REVIEW') {
    if (r.reviewBatch !== 'PASSED' && r.reviewBatch !== 'SHADOW_CHALLENGED') throw new LabelInvalid('review_batch');
    if (r.appliedVerdict !== 'ALLOW' && r.appliedVerdict !== 'CHALLENGE') throw new LabelInvalid('applied_verdict');
    // 첫째 묶음은 적용 판이 통과시킨 세션이다
    if (r.reviewBatch === 'PASSED' && r.appliedVerdict !== 'ALLOW') throw new LabelInvalid('applied_verdict');
    if (!UUID.test(r.verdictEventKey)) throw new LabelInvalid('verdict_event_key');
    return { ...r, source, label, reviewBatch: r.reviewBatch, appliedVerdict: r.appliedVerdict, verdictEventKey: r.verdictEventKey.toLowerCase() };
  }
  if (r.reviewBatch !== undefined) throw new LabelInvalid('review_batch');
  if (r.appliedVerdict !== undefined) throw new LabelInvalid('applied_verdict');
  if (r.verdictEventKey !== '') throw new LabelInvalid('verdict_event_key');
  return { ...r, source, label, reviewBatch: undefined, appliedVerdict: undefined };
}

/** 글의 SHA-256 앞 32자(16진). 멱등 기록·판 가드의 칸 이름에 pid 원문을 쓰지 않으려는 것이다(§9 '멱등 기록') */
export const hashField = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

/** 라벨 ID(건 ID·pid·출처)의 칸 이름 */
export const labelField = (l: Pick<ValidLabel, 'sourceRef' | 'pid' | 'source'>): string => hashField(`${l.sourceRef}|${l.pid}|${l.source}`);
/** 부정 예매 출처 둘이 판을 함께 견주는 (건 ID, pid)의 칸 이름 */
export const fraudPairField = (l: Pick<ValidLabel, 'sourceRef' | 'pid'>): string => hashField(`${l.sourceRef}|${l.pid}`);
/** 부정 예매 사건의 칸 이름(그 기기로 아직 조치 상태인 계정 수) */
export const fraudCaseField = (l: Pick<ValidLabel, 'sourceRef'>): string => hashField(`case|${l.sourceRef}`);
/**
 * 같은 건 ID에 처음 받은 사람·회차(§9 '멱등 기록'). 부정 예매 출처는 한 사건에 계정이 여럿이라 회차만 본다
 */
export const labelWho = (l: Pick<ValidLabel, 'source' | 'pid' | 'eventId'>): string => hashField(isFraudSource(l.source) ? `*|${l.eventId}` : `${l.pid}|${l.eventId}`);

/** 기기 가명의 키 판(모양이 틀리면 undefined) */
export const deviceRefVersion = (ref: string): number | undefined => {
  const m = DEVICE_REF.exec(ref);
  return m ? Number(m[1]) : undefined;
};

/**
 * 차단 키를 바꾸는 방법(§9 '차단 키를 바꾸는 규칙'):
 * ADD 키가 없을 때만 올린다, DEL 지운다, DEL_CASE 값의 건 ID가 이 건일 때만 지운다,
 * FRAUD_RELEASE 부정 예매 이의 인정(판정 근거가 차단 목록이었거나 같은 사건이 올린 키를, 그 사건의 다른 계정이 그 기기로 조치 상태가 아닐 때 지운다), KEEP 바꾸지 않는다(판만 적는다).
 * 부정 예매 조치(FRAUD_ACTIONED)가 올린 키는 그 사건의 이의 인정으로만 지운다(Lua가 값의 출처를 본다)
 */
export type BlockOp = 'ADD' | 'DEL' | 'DEL_CASE' | 'FRAUD_RELEASE' | 'KEEP';

/** 판정 근거 키(tr:vb)에서 이 규칙이 보는 칸 */
export interface LabelEvidence {
  eventKey: string | undefined;
  deviceRef: string | undefined;
  hardSignal: HardSignal;
}

export function blockOp(l: Pick<ValidLabel, 'source' | 'label'>, evidence: LabelEvidence | undefined): BlockOp {
  // 표본 검토·부정구매 확인·부정 예매 조치의 BOT은 키가 없을 때만 올린다
  if (l.label === 'BOT') return 'ADD';
  switch (l.source) {
    // 표본 검토 '사람'은 그 기기의 키를 지운다(부정 예매 조치가 올린 키는 빼고)
    case 'SAMPLE_REVIEW':
      return 'DEL';
    // 이의 인정은 판정 근거의 확정 신호가 차단 목록이었을 때만 지운다
    case 'APPEAL_ACCEPTED':
      return evidence?.hardSignal === 'BLOCK_LIST' ? 'DEL' : 'KEEP';
    case 'FRAUD_APPEAL_ACCEPTED':
      return 'FRAUD_RELEASE';
    // 부정구매 확인을 HUMAN으로 바꾸면 그 건이 올린 키만 지운다
    case 'FRAUD_CONFIRMED':
      return 'DEL_CASE';
    default:
      return 'KEEP';
  }
}

/**
 * 라벨 판정 기록의 사건 키(asyncapi TrustVerdict.eventKey): (건 ID, pid, 출처, 판)의 SHA-256 앞 16바이트를 UUID 모양(RFC 9562 판 8, 변형 10)으로 쓴다.
 * 같은 판을 다시 보내도 같은 값이라 받는 쪽이 하나로 친다(§9 '기록')
 */
export function labelEventKey(l: Pick<ValidLabel, 'sourceRef' | 'pid' | 'source' | 'sourceVersion'>): string {
  const h = createHash('sha256').update(`PEAKET-trust-label-v1|${l.sourceRef}|${l.pid}|${l.source}|${l.sourceVersion}`, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
