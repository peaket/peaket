// 글 속 개인정보 꼴 가림(오류 수집 가림 꼴, docs/observability.md §7 '개인정보 2단계 마스킹 통제', ADR-0356 결정 4, 리뷰 RV012-5).
// 칸 이름 가림(redactDeep, 1차)은 값이 글 안에 섞이면 못 잡는다. 오류 사건은 게이트웨이 수집기의 2차 마스킹을 지나지 않으므로
// 오류 글(message·exception value·지문 등)에 이 꼴을 직접 건다. 표시는 1차와 같은 '[REDACTED]'다.
// 2차 마스킹의 정규식 원천(wbs 4.1.4 게이트웨이 수집기)이 생기면 그것과 맞춘다.

const MASK = '[REDACTED]';

/** 차례대로 건다(이메일 → 카드 → 국제 표기 전화 → 국내 휴대폰). 앞 꼴이 가린 자리는 뒤 꼴이 다시 보지 않는다 */
const PATTERNS: readonly RegExp[] = [
  // 이메일(따옴표 안·괄호 안 포함)
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  // 카드 번호: 16자리, 4자리마다 하이픈·빈칸 구분자가 있거나 붙여 씀(앞뒤가 숫자가 아닐 때만)
  /(?<!\d)\d{4}(?:[- ]?\d{4}){3}(?!\d)/g,
  // 국제 표기(E.164): + 와 8~15자리
  /\+[1-9]\d{7,14}(?!\d)/g,
  // 국내 휴대폰: 010·011·016~019, 하이픈 있거나 붙여 씀
  /(?<!\d)01[016-9]-?\d{3,4}-?\d{4}(?!\d)/g,
];

/** 글 속 이메일·카드 번호·전화번호 꼴을 '[REDACTED]'로 바꾼다. 글이 아니면 그대로 돌려준다 */
export function maskPiiText<T>(value: T): T {
  if (typeof value !== 'string') return value;
  let out: string = value;
  for (const re of PATTERNS) out = out.replace(re, MASK);
  return out as T;
}
