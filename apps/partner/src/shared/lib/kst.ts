// KST 표시(파트너 콘솔). 서버가 준 ISO 시각을 화면 문구로만 바꾼다.
// 모든 시각은 Asia/Seoul(+09:00) 고정이고, 실행 환경 시간대에 기대지 않는다.
const OFFSET_MS = 9 * 3_600_000;
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'] as const;

function parts(value: string | Date | null | undefined) {
  if (value === null || value === undefined) return undefined;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  const d = new Date(at + OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: WEEKDAY[d.getUTCDay()]!,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** '10/14(수) 20:00 KST'. 값이 없거나 모양이 틀리면 '—' */
export function kstStamp(value: string | Date | null | undefined): string {
  const p = parts(value);
  return p ? `${p.month}/${p.day}(${p.weekday}) ${pad(p.hour)}:${pad(p.minute)} KST` : '—';
}

/** '16:30 KST'(KST 시각만) */
export function kstTime(value: string | Date | null | undefined): string {
  const p = parts(value);
  return p ? `${pad(p.hour)}:${pad(p.minute)} KST` : '—';
}

/** '2026-11-15'(KST 날짜) */
export function kstDate(value: string | Date): string {
  const p = parts(value);
  return p ? `${p.year}-${pad(p.month)}-${pad(p.day)}` : '—';
}

/** '10/15(목)'(KST 날짜) */
export function kstDayText(value: string | Date): string {
  const p = parts(value);
  return p ? `${p.month}/${p.day}(${p.weekday})` : '—';
}
