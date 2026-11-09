// 차례 알림(CMP-068, docs/frontend.md §5.1 '차례가 가까울 때의 알림', ADR-0212 결정 4).
// - 탭 제목 카운트다운: 버튼과 관계없이 숨긴 탭이고 예상 대기가 5분 [가정] 안이면 남은 시간을 제목 앞에 붙인다
// - 알림음·브라우저 알림: [차례 알림 받기]로 켠 뒤, 예상 대기가 60초 [가정] 안이거나 차례 도래 유예가 되면 한 번

const TITLE_FROM_SEC = 300;
const ALERT_FROM_SEC = 60;

/** 제목 앞에 붙일 남은 시간. 보이는 탭·모르는 예상 대기·5분 넘음이면 빈 글 */
export function titlePrefix(etaSec: number | null | undefined, hidden: boolean): string {
  if (!hidden || etaSec === null || etaSec === undefined || etaSec > TITLE_FROM_SEC) return '';
  const s = Math.max(0, Math.round(etaSec));
  return s <= 60 ? `(${s}초) ` : `(약 ${Math.round(s / 60)}분) `;
}

/** 지금 알릴 때인가(켜 둔 뒤 한 번) */
export function alertDue(v: { state: string; etaSec?: number | null }, alerted: boolean): boolean {
  if (alerted) return false;
  if (v.state === 'grace' || v.state === 'soon') return true;
  return v.state === 'waiting' && typeof v.etaSec === 'number' && v.etaSec <= ALERT_FROM_SEC;
}
