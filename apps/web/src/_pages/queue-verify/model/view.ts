// SCR-009 추가 검증의 화면 글과 고정 경로(d5 §5.9, docs/features/bot-defense.md §5.1 사유 범주 표, ADR-0259).
// 순수 함수만 둔다(node --test가 바로 불러 본다). 서버 값은 표에 있는 코드만 글로 바꾸고, 표에 없는 값은 보이지 않는다.
// 화면은 이 글을 React 글자 자식(글 노드)으로만 그린다. HTML로 넣지 않는다(ASVS 3.2.2, 린트 peaket-web/no-html-injection).

/** 사유 범주 코드 → 화면에 보이는 범주(bot-defense §5.1 표, 문구는 법률 검토 wbs 7.4.1에서 확정 [가정]) */
export const REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  RAPID_REQUESTS: '짧은 시간 많은 요청',
  DEVICE_HISTORY: '이 기기의 이용 기록',
  NETWORK: '접속 환경',
  INTERACTION: '화면 조작 모양',
  HUMAN_CHECK: '사람 확인 결과',
  SHARED_PATTERN: '여러 계정에서 같은 모양',
});

/** 서버가 준 사유 범주 코드 → 글. 표에 없는 값(빈 값·모르는 코드·글자 조각)은 null(범주 줄을 그리지 않는다) */
export function reasonLabel(code: unknown): string | null {
  return typeof code === 'string' && Object.hasOwn(REASON_LABELS, code) ? REASON_LABELS[code]! : null;
}

/**
 * 이 화면이 옮겨 가는 곳. 모두 이 앱의 고정 경로이고 회차 ID만 경로 조각으로 넣는다(ASVS 3.7.2).
 * 주소의 next·returnTo 같은 바깥 값은 읽지 않는다. 로그인 뒤 돌아올 곳도 이 화면의 고정 경로다
 */
export function fixedPaths(eventId: string): { queue: string; seats: string; event: string; verify: string; login: string } {
  const id = encodeURIComponent(eventId);
  const verify = `/queue/${id}/verify`;
  return { queue: `/queue/${id}`, seats: `/booking/${id}/seats`, event: `/events/${id}`, verify, login: `/login?next=${encodeURIComponent(verify)}` };
}

/** 이의 내용 최대 글자 수(NFC 정규화 뒤 grapheme, d5 §5.9 ⑤, d2 §3.1). 서버도 같은 규칙으로 센다 */
export const APPEAL_MAX = 1000;

/**
 * 이의 글에 둘 수 없는 글자: NUL(U+0000), 양방향 제어(U+202A~U+202E, U+2066~U+2069), 0폭(U+200B~U+200D, U+FEFF).
 * 서버도 같은 규칙으로 400이다(bot-defense §12 '접수', openapi QueueVerificationSubmitRequest.appeal). 이모지를 잇는 U+200D도 막힌다
 */
export const APPEAL_FORBIDDEN = /[\u0000\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/u;

/** 이의 글에 둘 수 없는 글자가 있는가 */
export const appealHasForbidden = (text: string): boolean => APPEAL_FORBIDDEN.test(text);

/** NFC 정규화 뒤 grapheme 수(사람이 보는 한 글자) */
export function appealLength(text: string): number {
  const t = text.normalize('NFC');
  let n = 0;
  for (const _ of new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(t)) n += 1;
  return n;
}

/** 화면 글(d5 §5.9 상태 표. '정본 밖' 표시가 붙은 것은 d5에 문구가 없어 이 화면이 둔 글이다) */
export const COPY = {
  intro: '자동으로 확인된 사항이 있어 한 번 더 확인합니다. 통과하면 원래 순번의 차례에 입장합니다',
  appealHint: '설명을 요청하거나 재검토를 신청할 수 있습니다',
  challengeFailed: '확인하지 못했습니다. 다시 시도해 주세요',
  challengeUnavailable: '사람 확인을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요',
  autoRetry: '잠시 뒤 자동으로 다시 시도합니다',
  limited: '확인을 너무 많이 시도했습니다. 잠시 뒤 다시 시도해 주세요',
  /** 정본 밖: 서버가 REVERIFY_REQUIRED로 답함(③으로 돌아간다) */
  reverifyAgain: '휴대폰 본인확인을 다시 해 주세요',
  /** 정본 밖: 서버가 PERSON_MISMATCH로 답함 */
  personMismatch: '이 계정의 본인과 다른 분으로 확인되었습니다. 계정 본인이 다시 확인해 주세요',
  turnNote: '통과하면 원래 순번이 그대로입니다. 차례가 이미 지났다면 통과 즉시 입장합니다',
  passBefore: '원래 순번으로 돌아갑니다',
  passAfter: '바로 입장합니다',
  acceptedBefore: '확인 결과 자동 판정이 잘못되었습니다. 원래 순번으로 돌아갑니다',
  acceptedAfter: '확인 결과 자동 판정이 잘못되었습니다. 바로 입장합니다',
  rejected: '재검토 결과 판정을 유지합니다. 이 대기 참여는 끝납니다',
  rejectedNote: '이 판정은 이번 대기 참여에만 적용되며 계정 제재가 아닙니다',
  received:
    '재검토를 신청했습니다. 티켓 오픈 전후(오픈 10분 전부터 60분 뒤까지)에는 30분 안에 확인하려고 합니다. 결과와 설명은 늦어도 10영업일 안에 이메일로 보내고 웹 푸시로도 알려 드립니다',
  /** 정본 밖: 이의 글에 둘 수 없는 글자(서버 400과 같은 규칙) */
  appealBadChars: '보이지 않는 글자나 글의 방향을 바꾸는 글자는 보낼 수 없습니다. 지운 뒤 다시 보내 주세요',
  /** 정본 밖: 이의를 보내지 못함(400 등) */
  appealFailed: '보내지 못했습니다. 다시 시도해 주세요',
  /** 정본 밖: 첫 상태 읽기 실패 */
  loadFailed: '추가 검증 정보를 불러오지 못했습니다',
} as const;
