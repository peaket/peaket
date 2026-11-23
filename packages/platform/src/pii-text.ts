// 글 속 개인정보 꼴 가림(오류 수집 가림 꼴, docs/observability.md §7 '개인정보 2단계 마스킹 통제'·'오류 수집 가림 꼴', ADR-0356 결정 4, 리뷰 RV012-5).
// 칸 이름 가림(redactDeep, 1차)은 값이 글 안에 섞이면 못 잡는다. 오류 사건은 게이트웨이 수집기의 2차 마스킹을 지나지 않으므로
// 오류 글(message·exception value·지문 등)에 이 꼴을 직접 건다.
// 꼴과 표시의 원천은 pii-patterns.json 하나다(§7 '2차 마스킹 정규식 원천', F-01-3). 게이트웨이 수집기의 2차 마스킹 문장도
// 같은 파일에서 만든다(node tools/ci/collector-config.mjs --write). 그래서 같은 글은 두 곳에서 같은 결과가 된다.
import source from './pii-patterns.json' with { type: 'json' };

export interface PiiTextPattern {
  readonly name: string;
  /** RE2(수집기)와 자바스크립트가 똑같이 읽는 정규식(앞뒤 살피기·뒤 참조 없음) */
  readonly pattern: string;
  /** 바꿀 글. 잡은 묶음은 $1처럼 쓴다 */
  readonly replacement: string;
}

/** 원천 그대로의 꼴 목록(차례대로 건다) */
export const PII_TEXT_PATTERNS: readonly PiiTextPattern[] = source.patterns;

/**
 * 꼴마다 같은 문장을 두 번 건다. 앞뒤 살피기가 없어 경계 글자를 잡은 묶음으로 먹으므로, 한 글자로 붙은 두 값의 뒤쪽은
 * 첫 번에 놓친다(앞 값이 그 글자를 먹었다). 놓친 값 바로 앞의 값은 첫 번에 가려졌으므로 둘째 번에는 경계가 남아 잡힌다.
 * 수집기 문장도 같은 횟수로 건다(tools/ci/collector-config.mjs)
 */
export const PII_TEXT_PASSES = 2;

const COMPILED: readonly { re: RegExp; replacement: string }[] = PII_TEXT_PATTERNS.map((p) => ({ re: new RegExp(p.pattern, 'g'), replacement: p.replacement }));

/** 글 속 이메일·카드 번호·전화번호·예금주 조회 경로의 계좌번호 꼴을 '[REDACTED]'로 바꾼다. 글이 아니면 그대로 돌려준다 */
export function maskPiiText<T>(value: T): T {
  if (typeof value !== 'string') return value;
  let out: string = value;
  for (const { re, replacement } of COMPILED) for (let i = 0; i < PII_TEXT_PASSES; i++) out = out.replace(re, replacement);
  return out as T;
}
