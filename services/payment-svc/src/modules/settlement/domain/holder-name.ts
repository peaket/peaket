// 예금주 이름 비교 규칙(settlement §3 '예금주 이름 비교 규칙' 1~4, ADR-0370 결정 2, J-T8).
// 차례: NFKC(전각·묶음 글자 ㈜를 풀어 씀) → 법인 표기 목록(holder-name-rules.json)을 긴 것부터 지움 → 공백·문장부호 지움 → 소문자.
// 음역(PEAKET ↔ 피켓)은 하지 않는다. 정규화한 글이 비면 무엇과도 같지 않다.
import rules from './holder-name-rules.json' with { type: 'json' };

/** 법인 표기(긴 것부터, 대소문자 무시로 지운다) */
const MARKS: readonly string[] = [...(rules as { corporateMarks: readonly string[] }).corporateMarks].map((m) => m.normalize('NFKC').toLowerCase()).sort((a, b) => b.length - a.length);
/** 공백과 문장부호(괄호·대괄호·점·쉼표·하이픈·가운뎃점) */
const STRIP = /[\s()[\].,\-·・‧]/gu;

export function normalizeHolderName(name: string): string {
  let s = name.normalize('NFKC').toLowerCase();
  for (const m of MARKS) s = s.split(m).join('');
  return s.replace(STRIP, '');
}

/** 예금주가 판매자 상호나 대표자와 같은가(어느 한쪽과 같으면 참) */
export function holderMatches(holderName: string, seller: { legalName: string; representative: string }): boolean {
  const h = normalizeHolderName(holderName);
  if (h === '') return false;
  return [seller.legalName, seller.representative].some((n) => n !== '' && normalizeHolderName(n) === h);
}
