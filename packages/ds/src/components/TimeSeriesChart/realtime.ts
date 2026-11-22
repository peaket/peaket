// CMP-033 실시간 방식의 Chart.js 설정(docs/frontend.md §5.7 '그래프와 들고 있는 양', ADR-0091 결정 4, ADR-0361 결정 11).
// x축은 linear(밀리초)이고 눈금 글자는 Intl.DateTimeFormat으로 쓴다(시간 축은 날짜 라이브러리·어댑터가 더 필요해 쓰지 않는다).
// 갱신은 animation: false·parsing: false·normalized: true·축 최소·최대 지정·chart.update('none')이고, 점이 캔버스 폭의 4배(플러그인 기본값)를
// 넘으면 Decimation min-max(꼭짓점을 지킨다)로 줄인다. 가져오는 값이 없는 순수 모듈이라 Node 내장 시험 실행기로 그대로 읽는다.

/** 실시간 그래프의 기본 창 15분 [가정](한 선 1초 점 900개) */
export const REALTIME_WINDOW_MS = 15 * 60_000;
/** 실시간 갱신 방식(chart.update 인자) */
export const REALTIME_UPDATE_MODE = 'none';

const hhmmss = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });

/** x축 눈금 글자(밀리초 → 'HH:mm:ss' KST) */
export function realtimeTick(ms: number): string {
  return hhmmss.format(new Date(ms));
}

/** 실시간 방식 Chart.js options(창 끝 now, 창 길이 windowMs) */
export function realtimeChartOptions(o: { now: number; windowMs?: number; grid: string; ink: string; beginAtZero?: boolean }) {
  const windowMs = o.windowMs ?? REALTIME_WINDOW_MS;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    parsing: false as const,
    normalized: true,
    interaction: { mode: 'nearest' as const, axis: 'x' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: true },
      decimation: { enabled: true, algorithm: 'min-max' as const },
    },
    scales: {
      x: {
        type: 'linear' as const,
        min: o.now - windowMs,
        max: o.now,
        grid: { display: false },
        border: { color: o.grid },
        ticks: { color: o.ink, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 16, callback: (v: number | string) => realtimeTick(Number(v)) },
      },
      y: { beginAtZero: o.beginAtZero ?? true, grid: { color: o.grid }, border: { display: false }, ticks: { color: o.ink, font: { size: 11 } } },
    },
  };
}
