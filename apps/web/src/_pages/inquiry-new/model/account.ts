// 문의 내용 속 계좌번호처럼 보이는 숫자열 찾기(d5 §5.30, 추천 적용 2026-10-28·기술 검토 낮음-093).
// 하이픈·공백을 뺀 10~14자리 [가정]. 휴대폰 번호(01x로 시작)·예매번호(20으로 시작하는 13자리)·주문번호(ord- 뒤)는 뺀다.
// 찾기는 안내용이다(서버 판정 아님). 담당자 화면(SCR-045)은 같은 패턴을 가려 보인다.
const CANDIDATE = /\d[\d -]{8,20}\d/g;

export interface AccountMatch {
  index: number;
  text: string;
}

export function findAccountNumbers(text: string): AccountMatch[] {
  const found: AccountMatch[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const raw = m[0];
    const index = m.index ?? 0;
    const digits = raw.replace(/[ -]/g, '');
    if (digits.length < 10 || digits.length > 14) continue;
    if (/^01[016789]/.test(digits)) continue;
    if (/^20\d{11}$/.test(digits)) continue;
    if (text.slice(Math.max(0, index - 4), index).toLowerCase() === 'ord-') continue;
    found.push({ index, text: raw });
  }
  return found;
}

/** 찾은 숫자열을 '(계좌번호 지움)'으로 바꾼다 */
export function maskAccountNumbers(text: string): string {
  const matches = findAccountNumbers(text);
  let out = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const m = matches[i]!;
    out = `${out.slice(0, m.index)}(계좌번호 지움)${out.slice(m.index + m.text.length)}`;
  }
  return out;
}
