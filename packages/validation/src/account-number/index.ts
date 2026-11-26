// 글 속 계좌번호 꼴 찾기·가림(F-06-5, docs/security/data-classification.md '고객 문의', ASVS support 14.2.6).
// 하이픈·공백을 뺀 10~14자리 [가정]. 휴대폰(01x)·예매번호(20으로 시작하는 13자리)·주문번호(ord- 뒤)는 뺀다.
// 찾기는 안내·표시용이다(서버 판정 아님). 저장값은 바꾸지 않는다(저장 전 가림은 법률 검토 wbs 7.4.1).
const CANDIDATE = /\d[\d -]{8,20}\d/g;

export interface AccountNumberMatch {
  readonly index: number;
  readonly text: string;
}

export function findAccountNumbers(text: string): AccountNumberMatch[] {
  const found: AccountNumberMatch[] = [];
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

/** 찾은 숫자열을 '(계좌번호 지움)'으로 바꾼다. 나머지 글은 그대로 둔다 */
export function maskAccountNumbers(text: string): string {
  const matches = findAccountNumbers(text);
  let out = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const m = matches[i]!;
    out = `${out.slice(0, m.index)}(계좌번호 지움)${out.slice(m.index + m.text.length)}`;
  }
  return out;
}
