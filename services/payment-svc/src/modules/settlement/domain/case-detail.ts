// CS 건 본문 글(ops cs_case.detail, 1~2,000자) 만들기(F-07-7 계획 §5.1 (파) (나), ADR-0370 결정 7·8).
// 차례: 표시 글('commander 확인 필요'·'실행 멈춤')과 이체 ID를 먼저 싣고, 뺀 정산서를 정산서 ID 오름차순으로 `{정산서 ID}({사유})`씩 ', '로 잇는다.
// 2,000자(코드 포인트)를 넘으면 끝 꼬리 ' 외 {M}건(전체는 SCR-049 묶음 상세)'가 들어갈 때까지만 싣는다. 전체 목록의 정본은 payment(정산서 HELD·사유·감사)다.
// 계좌번호·예금주명·결제사 원문 오류는 싣지 않는다(부르는 쪽이 ID·사유 종류만 넘긴다).

export const CASE_DETAIL_MAX = 2_000;

export type CaseDetailFlag = 'commander 확인 필요' | '실행 멈춤';

const cp = (t: string): number => [...t].length;

/** 결과는 1~2,000자다. 뺀 정산서·표시·이체 ID가 모두 없으면 빈 글(부르는 쪽은 detail을 싣지 않는다) */
export function buildCaseDetail(input: { excluded: readonly { statementId: string; reason: string }[]; flags: readonly CaseDetailFlag[]; transferIds?: readonly string[] }): string {
  const head: string[] = [...input.flags];
  if (input.transferIds && input.transferIds.length > 0) head.push(`이체 ${input.transferIds.join(', ')}`);
  const prefix = head.length > 0 ? `${head.join(' · ')}. ` : '';
  const items = [...input.excluded].sort((a, b) => (a.statementId < b.statementId ? -1 : a.statementId > b.statementId ? 1 : 0)).map((x) => `${x.statementId}(${x.reason})`);
  if (items.length === 0) return truncate(prefix.trim());
  const listHead = `뺀 정산서 ${items.length}건: `;
  const all = `${prefix}${listHead}${items.join(', ')}`;
  if (cp(all) <= CASE_DETAIL_MAX) return all;
  // 꼬리가 들어갈 때까지만 싣는다(M이 자랄 수록 꼬리도 길어지므로 실을 수를 줄여 가며 맞춘다)
  for (let shown = items.length - 1; shown >= 0; shown -= 1) {
    const tail = ` 외 ${items.length - shown}건(전체는 SCR-049 묶음 상세)`;
    const text = `${prefix}${listHead}${items.slice(0, shown).join(', ')}${tail}`;
    if (cp(text) <= CASE_DETAIL_MAX) return text;
  }
  return truncate(`${prefix}${listHead} 외 ${items.length}건(전체는 SCR-049 묶음 상세)`);
}

function truncate(text: string): string {
  const chars = [...text];
  return chars.length <= CASE_DETAIL_MAX ? text : chars.slice(0, CASE_DETAIL_MAX).join('');
}
