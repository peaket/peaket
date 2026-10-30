// 숫자·시간 표기(d2 §4 '숫자 및 단위 표기': 천 단위 쉼표, 원화 기호, "약 2분")

const numberFormat = new Intl.NumberFormat("ko-KR");

/** 1234567 → "1,234,567" */
export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/** 120000 → "₩120,000" */
export function formatWon(value: number): string {
  return `₩${numberFormat.format(value)}`;
}

/** 초 → "1시간 2분 3초" / "5분 12초" / "10초". 0 이하이면 "0초" */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}시간`);
  if (m > 0) parts.push(`${m}분`);
  if (sec > 0 || parts.length === 0) parts.push(`${sec}초`);
  return parts.join(" ");
}

/** 초 → "05:12" / "1:05:12"(시계 모양, 고정폭 숫자로 쓴다) */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 이름 → 이니셜(한글은 첫 글자, 로마자는 단어 첫 글자 둘까지) */
export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (/^[A-Za-z]/.test(trimmed)) {
    return trimmed
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("");
  }
  return Array.from(trimmed)[0] ?? "";
}

/** 글자 수를 grapheme(사람이 보는 한 글자) 단위로 센다(d2 §3.1) */
export function countGraphemes(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    let n = 0;
    for (const _ of new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text)) n += 1;
    return n;
  }
  return Array.from(text).length;
}
