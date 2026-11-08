// 홀드 타이머 글(d5 §5.10 ④). 화면 첫 묶음에서 쓰므로 예매 흐름 기계와 나눈다.
/** 남은 시간 글(홀드 타이머). 음수는 0:00 */
export function holdClock(remainingMs: number): { text: string; ariaLabel: string; tone: 'normal' | 'warning' } {
  const sec = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return { text: `홀드 ${m}:${String(s).padStart(2, '0')}`, ariaLabel: `홀드 남은 시간 ${m}분 ${s}초`, tone: sec <= 60 ? 'warning' : 'normal' };
}
