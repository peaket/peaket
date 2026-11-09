// 위험 판정의 값(docs/features/bot-defense.md §3·§4, docs/api/proto/peaket/trust/v1/trust.proto).
export const SCORER_NAMES = ['HumanCheck', 'DeviceTrust', 'BehaviorScore', 'NetworkScore', 'AgeScore', 'ConsistencyScore'] as const;
export type ScorerName = (typeof SCORER_NAMES)[number];

export const SCORE_CONTEXTS = ['LOBBY_ENTRY', 'PREVERIFY', 'LOGIN', 'VERIFICATION'] as const;
export type ScoreContext = (typeof SCORE_CONTEXTS)[number];

/** 정렬 방식: 로비 셔플 켬·끔. NONE은 로그인·추가 검증 제출(trust.proto LOBBY_SHUFFLE_UNSPECIFIED) */
export type ShuffleMode = 'ON' | 'OFF' | 'NONE';

/** 명령 5의 강도(완화·기본·강화) */
export const INTENSITIES = ['RELAXED', 'BASE', 'STRICT'] as const;
export type Intensity = (typeof INTENSITIES)[number];

export const REASONS = ['RAPID_REQUESTS', 'DEVICE_HISTORY', 'NETWORK', 'INTERACTION', 'HUMAN_CHECK'] as const;
export type ReasonCategory = (typeof REASONS)[number];

export type Verdict = 'ALLOW' | 'CHALLENGE';

/** 사람 확인 결과. PENDING은 검증 보류(검증 API 장애), ABSENT는 원래 토큰이 없는 맥락(로그인) */
export type HumanCheckResult = 'PASSED' | 'FAILED' | 'PENDING' | 'ABSENT';

export type HumanAction = 'lobby' | 'preverify' | 'verify';

export type NetClass = 'HOSTING' | 'PROXY' | 'OTHER';

/** 확정 신호(docs/features/bot-defense.md §4.3) */
export type HardSignal = 'NONE' | 'BLOCK_LIST' | 'HONEYPOT';

/** openapi BehaviorSummary와 같은 칸. 원시 좌표·키 값은 받지 않는다 */
export interface BehaviorSummary {
  v: number;
  windowMs: number;
  pointerMoves?: number;
  pointerEntropy?: number;
  inputIntervalMeanMs?: number;
  inputIntervalStdMs?: number;
  scrollEvents?: number;
  scrollDistancePx?: number;
}

export interface ClientSignals {
  ip: string;
  userAgent: string;
  clientHints: Record<string, string>;
  /** CloudFront-Viewer-ASN. 없으면 0이고 NetworkScore는 '그 밖'으로 본다 */
  asn: number;
}

export interface ScoreRequest {
  context: ScoreContext;
  /** 로그인이면 비운다 */
  eventId: string;
  /** 로그인 전이면 비운다 */
  pid: string;
  accountId: string;
  /** 로그인이면 비운다 */
  humanCheckToken: string;
  deviceId: string;
  behavior?: BehaviorSummary | undefined;
  client: ClientSignals;
  firstVisitAtMs?: number | undefined;
  sessionCreatedAtMs?: number | undefined;
  shuffle: ShuffleMode;
  /** 조사용 추적 ID. 점수에 쓰지 않고 기록에만 옮긴다 */
  journeyId: string;
  /** 부르는 쪽이 건 데드라인(밀리초) */
  deadlineAtMs: number;
}

export interface ScoreResult {
  verdict: Verdict;
  /** CHALLENGE일 때만 */
  reason?: ReasonCategory;
  degraded: boolean;
}

export interface DeviceHistory {
  sent: number;
  passed: number;
  failed: number;
}
