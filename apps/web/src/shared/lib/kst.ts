// 한국 시각 표시(docs/frontend.md §3.3 '표시': 팬 화면은 공연장 현지 시각, 국내는 KST). 순수 함수만 둔다(node --test가 바로 불러 본다).
// 홈 카드(HOT-300)와 공연 상세(HOT-311)가 같은 글 모양을 쓴다.

const KST_MS = 9 * 60 * 60_000;
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/** 한국 시각의 날짜 부분 */
export function kstParts(ms: number): { m: number; d: number; wd: string; hh: string; mm: string } {
  const k = new Date(ms + KST_MS);
  return {
    m: k.getUTCMonth() + 1,
    d: k.getUTCDate(),
    wd: WEEKDAY[k.getUTCDay()]!,
    hh: String(k.getUTCHours()).padStart(2, '0'),
    mm: String(k.getUTCMinutes()).padStart(2, '0'),
  };
}

/** ISO 시각 → 밀리초. 없거나 틀리면 undefined */
export function parseTime(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** '11/20(금) 20:00' */
export function dateTimeText(ms: number): string {
  const k = kstParts(ms);
  return `${k.m}/${k.d}(${k.wd}) ${k.hh}:${k.mm}`;
}

/** '19:50' */
export function timeText(ms: number): string {
  const k = kstParts(ms);
  return `${k.hh}:${k.mm}`;
}

/** 한국 날짜 'YYYY-MM-DD' */
export function kstDate(ms: number): string {
  return new Date(ms + KST_MS).toISOString().slice(0, 10);
}
