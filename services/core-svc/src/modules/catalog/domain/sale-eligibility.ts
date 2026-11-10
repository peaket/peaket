// 도메인 층: 판매 정책 규칙·판매 자격 명단의 순수 판정(ADR-0261 결정 3~7, docs/features/queue-admission.md §3 '판매 자격 명단', BUILD_ORDER HOT-250).
// 규칙의 읽기·평가는 @peaket/validation/sale-policy의 공개 함수 넷만 쓰고, 여기는 명단 줄 해석·잠금·파기 시각·명단 키가 걸리는 회차를 둔다.
import { evaluateSalePolicy, type Condition, type RefundBand, type SalePolicyRule } from '@peaket/validation/sale-policy';
import { type EventStatus, SALE_END_BEFORE_START_MS } from './production.js';

/** 명단 키(영문 소문자·숫자·하이픈 3~32자, 규칙의 buyer.lists 값) */
export const LIST_KEY = /^[a-z0-9-]{3,32}$/;
/** 공연당 명단 수 [가정](ADR-0261 결정 6) */
export const MAX_LISTS_PER_PRODUCTION = 10;
/** 명단 파일 상한 8MiB [가정](50만 줄 × 한 줄 16바이트 [가정]) */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
/** multipart 봉투 몫(이미지 올리기와 같은 64KB [가정]) */
export const UPLOAD_ENVELOPE_BYTES = 64 * 1024;
/** 명단 하나의 줄 상한 [가정] */
export const MAX_LINES = 500_000;
/** 결과에 싣는 행 번호 상한(형식 오류·없는 코드 각각) [가정] */
export const MAX_REPORTED_LINES = 1_000;
/** 잠금: 그 키를 쓰는 규칙의 가장 이른 판매 시작 − 24시간 [가정] */
export const LOCK_BEFORE_SALE_MS = 24 * 60 * 60_000;
/** 파기: 마지막 판매 종료 + 1일 [가정] */
export const DESTROY_AFTER_SALE_END_MS = 24 * 60 * 60_000;
/** 회원 코드 변환 한 번의 개수와 데드라인 [가정](ADR-0261 결정 6) */
export const RESOLVE_BATCH = 10_000;
export const RESOLVE_DEADLINE_MS = 2_000;
/** 구성원 넣기·지우기 한 문장의 행 수 [가정] */
export const MEMBER_CHUNK = 5_000;
/** 변환 실패의 Retry-After(초) [가정] */
export const LOOKUP_RETRY_AFTER_S = 10;
/** 올리기 경로 시한 [가정]: 요청 시한 100초 안에서 50만 줄 변환·넣기를 끝낸다(docs/verification.md 판매 자격 명단 올리기 행) */
export const UPLOAD_ROUTE_DEADLINE_MS = 95_000;
/** 트랜잭션(구성원 50만 행 넣기)을 시작하려면 남아 있어야 하는 시간 [가정]. 모자라면 504이고 아무것도 저장하지 않는다(리뷰 C6) */
export const UPLOAD_TX_MIN_REMAINING_MS = 20_000;
/** 커밋 뒤 사본 넘기기를 하려면 남아 있어야 하는 시간 [가정]. 모자라면 넘기지 않고 정비 일이 넘긴다(리뷰 C6) */
export const COPY_MIN_REMAINING_MS = 5_000;
/** 공연마다 올리기 횟수 한도와 창 [가정](회원 코드 대량 떠보기 막기, 리뷰 S5) */
export const UPLOADS_PER_WINDOW = 20;
export const UPLOAD_WINDOW_MS = 60 * 60_000;
/** 올리기 기록을 지우는 나이 [가정](창보다 넉넉히) */
export const UPLOAD_LOG_KEEP_MS = 2 * 60 * 60_000;
/** 공개 요약 refundFees 상한(openapi maxItems, 리뷰 A1) */
export const MAX_REFUND_FEES = 20;

/** 표시 이름에 둘 수 없는 글자: 제어 문자(C0·DEL·C1, 줄바꿈 포함)·줄·문단 구분·양방향 제어 문자(좌석맵 이름 규칙과 같다, 리뷰 S3)·짝이 깨진 서로게이트 */
const NAME_FORBIDDEN = /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/** 명단 표시 이름: 1~40자(코드 포인트)이고 둘 수 없는 글자가 없다 */
export const listNameOk = (s: string) => [...s].length >= 1 && [...s].length <= 40 && !NAME_FORBIDDEN.test(s);

/** 회원 코드(ADR-0235 결정 4): XXX-XXXX, 헷갈리는 글자를 뺀 32글자(Crockford base32) */
const MEMBER_CODE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}$/;

export type UploadRejection = 'COMPRESSED' | 'NOT_UTF8' | 'TOO_MANY_LINES';

export interface MemberLines {
  /** 회원 코드 → 그 코드가 나온 행 번호(1부터) */
  codes: Map<string, number[]>;
  /** 형식 오류 줄의 행 번호(전부) */
  invalidLines: number[];
}

/** 앞부분이 gzip(1F 8B)·zip(50 4B 03 04, 빈 zip 50 4B 05 06, 나눈 zip 50 4B 07 08)인가 */
export function isCompressedUpload(b: Uint8Array): boolean {
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return true;
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06) || (b[2] === 0x07 && b[3] === 0x08));
}

/**
 * 명단 파일을 줄로 읽는다(ADR-0261 결정 6): 압축 파일이면 거절, UTF-8로 한 번 디코딩(잘못된 바이트는 거절, 맨 앞 BOM 하나는 버림), 50만 줄을 넘으면 거절.
 * 줄마다 끝의 CR, 앞뒤 공백(스페이스·탭), 겹따옴표 한 쌍을 버리고 대문자로 바꾼 뒤 XXX-XXXX 모양만 받는다. 빈 줄은 건너뛰되 행 번호는 센다(1부터).
 * 마지막 줄바꿈 뒤의 빈 조각은 줄로 세지 않는다
 */
export function readMemberLines(bytes: Uint8Array): MemberLines | UploadRejection {
  if (isCompressedUpload(bytes)) return 'COMPRESSED';
  // 줄 수는 디코딩·나누기 전에 바이트의 줄바꿈(0x0A)으로 센다(큰 파일을 글로 바꾸기 전에 거절, 리뷰 S4). 마지막 줄바꿈 뒤의 글도 한 줄이다
  let breaks = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) breaks++;
  if (breaks + (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? 1 : 0) > MAX_LINES) return 'TOO_MANY_LINES';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return 'NOT_UTF8';
  }
  const lines = text.split('\n');
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_LINES) return 'TOO_MANY_LINES';
  const codes = new Map<string, number[]>();
  const invalidLines: number[] = [];
  lines.forEach((raw, i) => {
    const n = i + 1;
    let s = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    s = s.replace(/^[ \t]+|[ \t]+$/g, '');
    if (s === '') return;
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).replace(/^[ \t]+|[ \t]+$/g, '');
    const code = s.toUpperCase();
    if (!MEMBER_CODE.test(code)) {
      invalidLines.push(n);
      return;
    }
    const seen = codes.get(code);
    if (seen) seen.push(n);
    else codes.set(code, [n]);
  });
  return { codes, invalidLines };
}

/** 조건이 그 명단 키를 buyer.lists로 쓰는가 */
function conditionUses(c: Condition | undefined, key: string): boolean {
  if (c === undefined) return false;
  if ('fact' in c) return c.fact === 'buyer.lists' && c.has === key;
  if ('not' in c) return conditionUses(c.not, key);
  return ('all' in c ? c.all : c.any).some((x) => conditionUses(x, key));
}

/** 그 명단 키를 buyer.lists로 쓰는 rule 규칙 */
export const rulesUsing = (rules: readonly SalePolicyRule[], key: string) => rules.filter((r) => r.rule !== undefined && conditionUses(r.rule.if, key));

/** 잠금 시각 계산에 쓰는 회차(취소된 회차는 보지 않는다) */
export interface LockRound {
  eventId: string;
  openAt: Date;
  status: EventStatus;
}

/**
 * 잠금 시각(ADR-0261 결정 7, 리뷰 D1): 그 키를 쓰는 규칙마다 판매 시작을 정하고 그 가운데 가장 이른 값 − 24시간 [가정]이다. 판매 시작은 창이 있는 규칙이면 during.from,
 * 창이 없는 규칙이면 그 규칙이 걸리는 회차(rounds, ALL이면 모든 회차, 취소된 회차 제외) 가운데 가장 이른 오픈 시각이다. 쓰는 규칙이 없으면 NULL.
 * 이미 지난 잠금 시각(지금 ≥ 앞 값)은 규칙이 바뀌어도 늦추지 않는다
 */
export function lockTime(rules: readonly SalePolicyRule[], key: string, previous: Date | null, now: Date, rounds: readonly LockRound[]): Date | null {
  if (previous !== null && now.getTime() >= previous.getTime()) return previous;
  const live = rounds.filter((r) => r.status !== 'CANCELLED');
  const starts = rulesUsing(rules, key).flatMap((r) => {
    if (r.during) return [Date.parse(r.during.from)];
    const opens = live.filter((x) => r.rounds === 'ALL' || r.rounds.includes(x.eventId)).map((x) => x.openAt.getTime());
    return opens.length > 0 ? [Math.min(...opens)] : [];
  });
  return starts.length > 0 ? new Date(Math.min(...starts) - LOCK_BEFORE_SALE_MS) : null;
}

/** 잠겼는가(지금 ≥ 잠금 시각, 경계 포함) */
export const isLocked = (lockedAt: Date | null, now: Date) => lockedAt !== null && now.getTime() >= lockedAt.getTime();

export interface RoundTimes {
  eventId: string;
  startsAt: Date;
  status: EventStatus;
}

/**
 * 파기 시각(ADR-0261 결정 7): 그 공연의 취소되지 않은 회차 가운데 가장 늦은 판매 종료(공연 시작 − 24시간) + 1일 [가정].
 * 회차가 모두 취소됐으면 모든 회차로 본다
 */
export function destroyTime(rounds: readonly RoundTimes[]): Date {
  const live = rounds.filter((r) => r.status !== 'CANCELLED');
  const pick = live.length > 0 ? live : rounds;
  const lastSaleEnd = Math.max(...pick.map((r) => r.startsAt.getTime() - SALE_END_BEFORE_START_MS));
  return new Date(lastSaleEnd + DESTROY_AFTER_SALE_END_MS);
}

/** 사본을 넘길 회차: 그 키를 쓰는 규칙의 rounds에 든 회차(ALL이면 모든 회차). 취소된 회차는 뺀다. 공연의 회차 차례대로 */
export function listEventIds(rules: readonly SalePolicyRule[], key: string, rounds: readonly RoundTimes[]): string[] {
  const using = rulesUsing(rules, key);
  return rounds.filter((r) => r.status !== 'CANCELLED' && using.some((u) => u.rounds === 'ALL' || u.rounds.includes(r.eventId))).map((r) => r.eventId);
}

/** 이 회차에 걸리는 공제율 구간(남은 날이 많은 차례, 20개 [가정]까지). 없으면 빈 목록(화면은 POL-032 기본표). 저장 검사가 20개를 넘는 규칙을 막고 여기는 방어로 자른다(리뷰 A1) */
export function refundBandsFor(rules: readonly SalePolicyRule[], eventId: string): RefundBand[] {
  return rules
    .filter((r) => r.refundFee !== undefined && (r.rounds === 'ALL' || r.rounds.includes(eventId)))
    .flatMap((r) => r.refundFee!.map((b) => ({ daysLeft: { gte: b.daysLeft.gte, lte: b.daysLeft.lte }, rate: b.rate })))
    .sort((a, b) => b.daysLeft.gte - a.daysLeft.gte)
    .slice(0, MAX_REFUND_FEES);
}

/** 매수 범위(1인 한도 상한 10, openapi perPersonLimit) */
const MAX_QUANTITY = 10;

/**
 * 그 계정에게 그 시각에 나올 수 있는 한도 가운데 가장 작은 값(표시용, ADR-0261 결정 5). 공개 함수 evaluateSalePolicy로 등급(배치본의 등급, 배치본이 없으면
 * 어느 등급도 아닌 값)·매수(1~10)를 모두 넣어 보고 허용된 결과의 한도 가운데 가장 작은 값이다. 허용되는 경우가 없으면 undefined
 */
export function smallestAllowedLimit(rules: readonly SalePolicyRule[], o: { at: Date; round: string; lists: readonly string[]; grades: readonly string[]; roundLimit: number }): number | undefined {
  let best: number | undefined;
  for (const grade of o.grades.length > 0 ? o.grades : ['']) {
    for (let quantity = 1; quantity <= MAX_QUANTITY; quantity++) {
      const d = evaluateSalePolicy(rules, { at: o.at, round: o.round, grade, quantity, lists: o.lists }, o.roundLimit);
      if (d.allowed) best = best === undefined ? d.limit : Math.min(best, d.limit);
    }
  }
  return best;
}
