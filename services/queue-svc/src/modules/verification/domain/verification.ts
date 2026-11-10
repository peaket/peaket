// 추가 검증 컨텍스트의 규칙 값(docs/features/bot-defense.md §5.2·§12, docs/features/queue-admission.md §7, docs/data.md §3, ADR-0259).
// 추가 검증은 봇으로 의심되어 격리된 사람이 심층 사람 확인과 휴대폰 본인확인을 다시 해 원래 순번을 되찾는 절차다(FR-020, POL-006).
// 이의 제기는 그 판정에 설명이나 재검토를 요청하는 것이고, CS 처리함 건 요청(support.cases-requested)으로 간다.

/** 한 대기 참여의 challengeToken 제출 한도: 10분에 5회 [가정](사람 슬롯 카운터 q:vsub, ADR-0259 결정 5) */
export const SUBMIT_LIMIT = 5;
export const SUBMIT_WINDOW_MS = 10 * 60_000;
/** 통과한 대기표의 입장 확정 유예 15분(POL-008). 차례가 이미 지났으면 통과 시각부터 센다(queue-admission §7) */
export const PASSED_GRACE_MS = 15 * 60_000;
/** 이의 글 임시 보관: 그 회차 판매 종료 + 7일 [가정](docs/data.md §3 q:appeal) */
export const APPEAL_KEEP_AFTER_SALE_END_MS = 7 * 86_400_000;
/** 이의 글 상한: NFC 정규화 뒤 grapheme(합친 글자) 1,000자(bot-defense §12, ASVS 2.2.1) */
export const APPEAL_MAX_GRAPHEMES = 1_000;
/** 건 요청 발행 확인을 기다리는 상한 2초 [가정](guidelines §5 '이의 건 요청 발행', ADR-0259 결정 6) */
export const CASE_PUBLISH_TIMEOUT_MS = 2_000;
/** 발행 실패·의존 서비스 무응답 503의 Retry-After(초) [가정] */
export const UNAVAILABLE_RETRY_AFTER_SEC = 2;

/** 바꿀 수 있는 값(시험은 상수와 다른 값을 넣는다) */
export interface VerificationOptions {
  submitLimit: number;
  submitWindowMs: number;
  graceMs: number;
  appealKeepAfterSaleEndMs: number;
  publishTimeoutMs: number;
}
export const DEFAULT_VERIFICATION_OPTIONS: VerificationOptions = Object.freeze({
  submitLimit: SUBMIT_LIMIT,
  submitWindowMs: SUBMIT_WINDOW_MS,
  graceMs: PASSED_GRACE_MS,
  appealKeepAfterSaleEndMs: APPEAL_KEEP_AFTER_SALE_END_MS,
  publishTimeoutMs: CASE_PUBLISH_TIMEOUT_MS,
});

/** 이용자에게 보이는 사유 범주(trust.proto ReasonCategory에서 접두사를 뺀 값, openapi QueueVerificationState.verificationReason) */
export const REASON_CATEGORIES = ['RAPID_REQUESTS', 'DEVICE_HISTORY', 'NETWORK', 'INTERACTION', 'HUMAN_CHECK', 'SHARED_PATTERN'] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];
export const reasonOf = (raw: string): ReasonCategory | null => REASON_CATEGORIES.find((r) => r === raw) ?? null;
/** 건 요청 category·gRPC reason_category에 싣는 trust.proto 이름(예 REASON_CATEGORY_DEVICE_HISTORY). 모르면 UNSPECIFIED */
export const protoReasonOf = (raw: string): string => `REASON_CATEGORY_${reasonOf(raw) ?? 'UNSPECIFIED'}`;

/**
 * q:{event:E}:verify 칸의 값(docs/data.md §3): VERIFYING:{시작 ms}:{사유}, PASSED:{통과 ms}:{사유}, BLOCKED:{기각 ms}:{사유}, ORPHAN:{ms}.
 * 회차 Lua가 VERIFYING일 때만 PASSED나 BLOCKED로 바꾼다. 빠진 번호 비트는 끄지 않는다(입장 확정이 PASSED를 받는다)
 */
export type VerifyValue = { state: 'VERIFYING' | 'PASSED' | 'BLOCKED'; atMs: number; reason: string } | { state: 'ORPHAN'; atMs: number };

const VERIFY_VALUE = /^(VERIFYING|PASSED|BLOCKED|ORPHAN):(\d+)(?::(.*))?$/;
/** 모르는 모양이면 null(추가 검증 중이 아닌 것으로 본다) */
export function parseVerify(v: string | null): VerifyValue | null {
  if (v === null) return null;
  const m = VERIFY_VALUE.exec(v);
  if (!m) return null;
  const atMs = Number(m[2]);
  if (m[1] === 'ORPHAN') return { state: 'ORPHAN', atMs };
  return { state: m[1] as 'VERIFYING' | 'PASSED' | 'BLOCKED', atMs, reason: m[3] ?? '' };
}

/**
 * 사람 키 q:dup:{pid}:E의 기록이 가리키는 대기 참여(대기 취소와 같은 길, ADR-0233). verify 칸의 필드는
 * 번호 기록이면 대기표 해시(기록의 끝 칸), 로비 참가면 참가 토큰 해시, 묶음 참가면 사전 검증 토큰 해시다.
 * 값의 모양은 진입 컨텍스트의 기록(entry domain/queue.ts parseHeld)과 같다. 두 판이 어긋나지 않는지는 시험(verification.test.ts)이 견준다.
 * 선점 값(PENDING)·취소 끝 표지(LEFT)·모르는 모양이면 null(대기 참여가 없다). 취소 중 표지는 원래 기록을 본다
 */
export type EntryRef = { kind: 'NUMBER'; seq: number; fieldHash?: string } | { kind: 'LOBBY' | 'BATCH'; fieldHash: string };

const HELD_NUMBER = /^(\d+):(\d+):([^:]+):[^:]*:[^:]*(?::([0-9a-f]*))?$/;
const HELD_BATCH = /^BATCH:1:([0-9a-f]+):([^:]+):[^:]*:[^:]*$/;
const HELD_LOBBY = /^LOBBY:([0-9a-f]+):([^:]+)$/;
const HELD_LEAVING = /^LEAVING:[^:]+:(.+)$/;

export function entryRefOf(value: string | null): EntryRef | null {
  if (value === null) return null;
  const plain = HELD_LEAVING.exec(value)?.[1] ?? value;
  const n = HELD_NUMBER.exec(plain);
  if (n) return { kind: 'NUMBER', seq: Number(n[1]), ...(n[4] ? { fieldHash: n[4] } : {}) };
  const b = HELD_BATCH.exec(plain);
  if (b) return { kind: 'BATCH', fieldHash: b[1]! };
  const l = HELD_LOBBY.exec(plain);
  return l ? { kind: 'LOBBY', fieldHash: l[1]! } : null;
}

const SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' });
/** 이의 글: NFC 정규화(합친 글자를 한 꼴로 맞춘다) */
export const normalizeAppeal = (text: string): string => text.normalize('NFC');
/** NFC 정규화 뒤 grapheme(사람이 한 글자로 보는 묶음) 수. UTF-16 길이로 세지 않는다(이모지·조합 글자가 여러 단위다) */
export function graphemeCount(text: string): number {
  let n = 0;
  for (const _ of SEGMENTER.segment(normalizeAppeal(text))) n++;
  return n;
}
/**
 * 이의 글에 두지 않는 글자(bot-defense §12 '접수', ASVS 2.2.1): NUL, 양방향 제어(U+202A~U+202E, U+2066~U+2069), 0폭(U+200B~U+200D, U+FEFF).
 * CS 화면에서 글 순서를 뒤집어 보이거나 보이지 않는 글자로 내용을 숨기지 못하게 한다. 합친 이모지의 ZWJ(U+200D)도 막는다(정본 그대로)
 */
const FORBIDDEN_IN_APPEAL = /[\u0000\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/u;
/** 받을 수 있는 이의 글: 막는 글자가 없고 NFC 뒤 1,000자 이하 */
export const appealFits = (text: string): boolean => !FORBIDDEN_IN_APPEAL.test(text) && graphemeCount(text) <= APPEAL_MAX_GRAPHEMES;

/** 이의 결과(queue.proto AppealOutcome) → verify 칸에 쓸 상태 */
export type AppealOutcome = 'ACCEPTED' | 'REJECTED';
export const outcomeState = (o: AppealOutcome): 'PASSED' | 'BLOCKED' => (o === 'ACCEPTED' ? 'PASSED' : 'BLOCKED');
/** queue.proto ResolveAppealResult */
export type ResolveResult = 'APPLIED' | 'UNCHANGED' | 'NOT_ISOLATED';

/** 대기열 Redis에 둔 이의(q:appeal:{pid}:E, docs/data.md §3) */
export interface StoredAppeal {
  appealId: string;
  accountId: string;
  /** 그 대기 참여의 verify 칸 필드(대기표·참가 토큰 해시) */
  fieldHash: string;
  /** 격리 때 이용자에게 보인 사유 범주(접두사 없는 이름) */
  reason: string;
  /** NFC 정규화 뒤 0~1,000자. 비면 설명 요구 */
  text: string;
  /** 처리함 건 요청의 eventKey(다시 보내도 같은 값) */
  eventKey: string;
  receivedAtMs: number;
  /** 키 수명(판매 종료 + 7일). q:appealid·q:appealcase도 같다 */
  expireAtMs: number;
  /** 건 요청 발행이 확인됐다(발행 성공 뒤에만 쓴다) */
  sent: boolean;
  /** 결과를 반영한 건 ID·판 번호·결과 */
  caseId?: string;
  caseVersion?: number;
  result?: ResolveResult;
  /** 이 이의의 결과 반영이 verify 칸을 실제로 바꿨을 때(APPLIED)의 결과. 상태 읽기의 passedVia(APPEAL)를 여기서 끌어낸다 */
  appliedOutcome?: AppealOutcome;
}

/** 이의를 처음 둘 때의 값 */
export type AppealDraft = Omit<StoredAppeal, 'sent' | 'caseId' | 'caseVersion' | 'result' | 'appliedOutcome'>;

/** 처리함 건 요청(asyncapi CaseRequested, kind VERIFICATION_APPEAL). 이의 글은 싣지 않는다 */
export interface CaseRequest {
  eventKey: string;
  /** 이의 ID */
  sourceId: string;
  /** trust.proto ReasonCategory 이름 */
  category: string;
  createdAtMs: number;
}
