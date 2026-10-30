'use client';
// CMP-033 TimeSeriesChart. 보드(SCR-026 '분당 판매') 마크업을 바깥 틀로 쓴다:
//   <section class="card pad-lg col" style="gap:12px" aria-labelledby><div class="row between wrap"><div class="col"><h3 class="t-md fw-b">제목</h3>
//   <span class="t-xs muted">설명</span></div><button class="btn btn-outline btn-sm" aria-pressed="false"><i class="ic ic-list"></i>표로 보기</button></div>
//   그래프 · 불러오는 중(.skel) · 빈 상태(가운데 글) · 오류
// - 그래프는 Canvas 2D(Chart.js 4.6)로 그린다. Chart.js는 그래프가 처음 보일 때 늦게 싣는다(dynamic import).
// - 색은 키트 차트 색(13절)을 그 자리의 CSS 변수에서 읽는다: 선 --link, 보조 선 --success, 기준선 --text-muted 점선,
//   SLO 기준선 --danger 점선(6 4), 면 --primary-subtle, 눈금 --border, 축 글자 --text-muted. 라이트·다크가 바뀌면 다시 그린다.
// - Canvas에는 role="img"와 요약 aria-label을 붙이고, [표로 보기]로 같은 데이터를 표(.table.dense)로 바꿔 본다(d2 CMP-033).
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { formatNumber } from '../../lib/format';
import { Icon } from '../../icons';

export type ChartTone = 'primary' | 'success' | 'baseline' | 'warning' | 'danger';

export interface ChartSeries {
  id: string;
  label: string;
  data: readonly (number | null)[];
  tone?: ChartTone;
}

export interface TimeSeriesChartProps {
  title: ReactNode;
  description?: ReactNode;
  /** 가로축 이름표(시각 등, 'HH:mm' KST) */
  labels: readonly string[];
  series: readonly ChartSeries[];
  /** SLO 기준선 */
  threshold?: { value: number; label: string };
  kind?: 'line' | 'area' | 'bar';
  /** 그래프 높이(px). 기본 200 */
  height?: number;
  state?: 'ready' | 'loading' | 'empty' | 'error';
  emptyText?: ReactNode;
  emptyHint?: ReactNode;
  errorText?: ReactNode;
  onRetry?: () => void;
  /** 그래프 요약(낭독기가 읽는다). 필수 */
  summary: string;
  /** 표 칸 값 뒤 단위('석', 'ms') */
  unit?: string;
  /** 표 첫 열 머리. 기본 '시각' */
  labelHeader?: string;
  headingLevel?: 2 | 3;
  /** 카드 틀(.card.pad-lg). false면 틀 없이 */
  framed?: boolean;
  /** 처음부터 표로 보기 */
  defaultTable?: boolean;
  className?: string;
  style?: CSSProperties;
}

type ChartModule = typeof import('chart.js');
let chartModule: Promise<ChartModule> | null = null;
/** Chart.js를 한 번만 싣고 쓰는 부품만 등록한다 */
function loadChart(): Promise<ChartModule> {
  chartModule ??= import('chart.js').then((m) => {
    m.Chart.register(
      m.LineController,
      m.BarController,
      m.LineElement,
      m.BarElement,
      m.PointElement,
      m.LinearScale,
      m.CategoryScale,
      m.Filler,
      m.Tooltip,
    );
    return m;
  });
  return chartModule;
}

const toneVar: Record<ChartTone, string> = {
  primary: '--link',
  success: '--success',
  baseline: '--text-muted',
  warning: '--warning',
  danger: '--danger',
};

/** #RRGGBB에 불투명도를 붙인다(면 색 .7) */
function withAlpha(color: string, alpha: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
  return color;
}

export function TimeSeriesChart({
  title,
  description,
  labels,
  series,
  threshold,
  kind = 'line',
  height = 200,
  state = 'ready',
  emptyText = '아직 기록이 없습니다',
  emptyHint,
  errorText = '그래프를 불러오지 못했습니다',
  onRetry,
  summary,
  unit = '',
  labelHeader = '시각',
  headingLevel = 3,
  framed = true,
  defaultTable = false,
  className,
  style,
}: TimeSeriesChartProps) {
  const titleId = `${useId()}-title`;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showTable, setShowTable] = useState(defaultTable);
  const [themeTick, setThemeTick] = useState(0);
  const H = `h${headingLevel}` as 'h2' | 'h3';

  // 라이트·다크(.pk의 dark 클래스)가 바뀌면 색을 다시 읽어 그린다
  useEffect(() => {
    const root = canvasRef.current?.closest('.pk');
    if (!root) return;
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [state, showTable]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || state !== 'ready' || showTable) return;
    let cancelled = false;
    let chart: { destroy: () => void } | null = null;
    void loadChart().then(({ Chart }) => {
      if (cancelled) return;
      const css = getComputedStyle(canvas);
      const read = (name: string) => css.getPropertyValue(name).trim();
      const grid = read('--border');
      const ink = read('--text-muted');
      const datasets = series.map((s) => {
        const color = read(toneVar[s.tone ?? 'primary']);
        const dashed = s.tone === 'baseline';
        return {
          label: s.label,
          data: [...s.data],
          borderColor: color,
          backgroundColor: kind === 'bar' ? color : withAlpha(read('--primary-subtle'), 0.7),
          borderWidth: dashed ? 1.5 : 2,
          borderDash: dashed ? [3, 3] : [],
          fill: kind === 'area' && !dashed ? 'origin' : false,
          pointRadius: 0,
          tension: 0,
          spanGaps: false,
        };
      });
      if (threshold) {
        datasets.push({
          label: threshold.label,
          data: labels.map(() => threshold.value),
          borderColor: read('--danger'),
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [6, 4],
          fill: false,
          pointRadius: 0,
          tension: 0,
          spanGaps: true,
        });
      }
      chart = new Chart(canvas, {
        type: kind === 'bar' ? 'bar' : 'line',
        data: { labels: [...labels], datasets: datasets as never },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: { enabled: true } },
          scales: {
            x: { grid: { display: false }, border: { color: grid }, ticks: { color: ink, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 16 } },
            y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: ink, font: { size: 11 } } },
          },
        },
      });
    });
    return () => {
      cancelled = true;
      chart?.destroy();
    };
  }, [state, showTable, labels, series, threshold, kind, themeTick]);

  const legend =
    series.length > 1 || threshold ? (
      <ul className="legend" aria-hidden="true">
        {series.map((s) => (
          <li key={s.id} className="legend-item">
            <span className="swatch" style={{ background: `var(${toneVar[s.tone ?? 'primary']})` }} />
            {s.label}
          </li>
        ))}
        {threshold ? (
          <li className="legend-item">
            <span className="swatch" style={{ background: 'var(--danger)' }} />
            {threshold.label}
          </li>
        ) : null}
      </ul>
    ) : null;

  let body: ReactNode;
  if (state === 'loading') {
    body = (
      <div aria-busy="true">
        <span className="sr-only">그래프를 불러오는 중</span>
        <span className="skel" style={{ height }} />
      </div>
    );
  } else if (state === 'empty') {
    body = (
      <div className="col center" style={{ height, gap: 6 }}>
        <span className="t-sm muted">{emptyText}</span>
        {emptyHint ? <span className="t-xs muted">{emptyHint}</span> : null}
      </div>
    );
  } else if (state === 'error') {
    body = (
      <div className="col center" role="alert" style={{ height, gap: 8 }}>
        <span className="row t-sm tx-danger" style={{ gap: 6 }}>
          <Icon name="alert-circle" size={16} />
          {errorText}
        </span>
        {onRetry ? (
          <button className="btn btn-outline btn-sm" type="button" onClick={onRetry}>
            <Icon name="refresh" />
            다시 시도
          </button>
        ) : null}
      </div>
    );
  } else if (showTable) {
    body = (
      <div className="table-wrap table-scroll">
        <table className="table dense">
          <caption className="sr-only">{summary}</caption>
          <thead>
            <tr>
              <th scope="col">{labelHeader}</th>
              {series.map((s) => (
                <th key={s.id} scope="col" className="r">
                  {s.label}
                </th>
              ))}
              {threshold ? (
                <th scope="col" className="r">
                  {threshold.label}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={`${l}-${i}`}>
                <th scope="row" style={{ background: 'transparent', fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
                  {l}
                </th>
                {series.map((s) => {
                  const val = s.data[i];
                  return (
                    <td key={s.id} className="r">
                      {val === null || val === undefined ? '—' : `${formatNumber(val)}${unit}`}
                    </td>
                  );
                })}
                {threshold ? (
                  <td className="r">
                    {formatNumber(threshold.value)}
                    {unit}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else {
    body = (
      <div style={{ position: 'relative', height }}>
        <canvas ref={canvasRef} role="img" aria-label={summary} />
      </div>
    );
  }

  return (
    <section
      className={cx(framed && 'card pad-lg', 'col', className)}
      style={{ gap: 12, ...style }}
      aria-labelledby={titleId}
    >
      <div className="row between wrap" style={{ gap: 12 }}>
        <div className="col" style={{ gap: 2 }}>
          <H className="t-md fw-b" id={titleId}>
            {title}
          </H>
          {description ? <span className="t-xs muted">{description}</span> : null}
        </div>
        {state === 'ready' ? (
          <button className="btn btn-outline btn-sm" type="button" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>
            <Icon name={showTable ? 'chart' : 'list'} />
            {showTable ? '그래프로 보기' : '표로 보기'}
          </button>
        ) : null}
      </div>
      {body}
      {state === 'ready' && !showTable ? legend : null}
    </section>
  );
}
