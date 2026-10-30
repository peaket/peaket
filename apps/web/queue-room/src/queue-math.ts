// 앞 인원·진행 막대·예상 대기 계산(docs/frontend.md §3.4 아래 식, POL-007). 서버가 사람마다 계산하지 않는다(§2.6).
import type { QueueStatusFile } from './fixtures';

/** 앞 인원 = (내 순번 − serving − 1) − (그 사이 빠진 번호). 음수면 0 */
export function aheadCount(myNumber: number, f: QueueStatusFile): number {
  return Math.max(0, myNumber - f.serving - 1 - f.removedBetween);
}

/** 진행률(%) = (처음 앞 인원 − 지금 앞 인원) ÷ 처음 앞 인원, 0~100으로 자른다. 처음 값이 0이면 100 */
export function progressPercent(initialAhead: number, ahead: number): number {
  if (initialAhead <= 0) return 100;
  return Math.min(100, Math.max(0, ((initialAhead - ahead) / initialAhead) * 100));
}

/** 예상 대기 글. 속도가 0이거나 일시정지면 숫자를 보이지 않는다(null) */
export function etaText(ahead: number, f: QueueStatusFile): string | null {
  if (f.servingRate <= 0 || f.saleStatus === 'PAUSED') return null;
  const minutes = Math.max(1, Math.round(ahead / f.servingRate / 60));
  if (minutes < 60) return `약 ${minutes}분`;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `약 ${hh}시간 ${mm}분` : `약 ${hh}시간`;
}

export const fmt = (n: number): string => n.toLocaleString('ko-KR');

/** 진행 막대 aria-valuetext와 1분 낭독 문장(d5 §5.8) */
export function queueSentence(ahead: number, eta: string | null, allHeld: boolean): string {
  if (allHeld) return `앞에 ${fmt(ahead)}명, 좌석이 풀리길 기다리는 중`;
  return eta ? `앞에 ${fmt(ahead)}명, ${eta} 남음` : `앞에 ${fmt(ahead)}명, 잠시 멈춤`;
}

/** 남은 초를 m:ss(한 시간 넘으면 h:mm:ss)로. 카운트다운 숫자 자리에 쓴다 */
export function clock(totalSeconds: number, padMinutes = true): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (hh > 0) return `${hh}:${String(mm).padStart(2, '0')}:${ss}`;
  return `${padMinutes ? String(mm).padStart(2, '0') : mm}:${ss}`;
}
