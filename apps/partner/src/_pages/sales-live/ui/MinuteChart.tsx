// 분당 판매 그래프(CMP-033 TimeSeriesChart 자리). 보드 SCR-026이 SVG로 그린 그림을 목업 숫자에서 그대로 다시 계산해 그린다.
// 보드마다 viewBox가 달라(휴대폰 320 · 태블릿 640 · 데스크톱 920 · xl 반쪽 520) 크기별로 하나씩 두고 중단점으로 바꾼다.
import { cx } from '@/shared/lib/cx';
import { CHART_SUMMARY, LAST, MINUTE_SALES, PEAK, SOLD_AVG, fmt } from '../model/live';

interface Layout {
  w: number;
  x0: number;
  x1: number;
  /** 세로축 눈금 글자의 오른쪽 끝 */
  yLabelX: number;
  className: string;
}

const LAYOUTS: readonly Layout[] = [
  { w: 320, x0: 32, x1: 308, yLabelX: 26, className: 'md:hidden' },
  { w: 640, x0: 40, x1: 624, yLabelX: 32, className: 'hidden md:block lg:hidden' },
  { w: 920, x0: 44, x1: 900, yLabelX: 36, className: 'hidden lg:block xl:hidden' },
  { w: 520, x0: 40, x1: 506, yLabelX: 32, className: 'hidden xl:block' },
];

const Y_TICKS = [120, 90, 60, 30, 0] as const;
const Y_MAX = 120;
const Y_TOP = 12;
const Y_BASE = 164;
const r1 = (n: number) => Math.round(n * 10) / 10;
const yOf = (v: number) => r1(Y_BASE - (v * (Y_BASE - Y_TOP)) / Y_MAX);

function Chart({ l }: { l: Layout }) {
  const step = (l.x1 - l.x0) / (MINUTE_SALES.length - 1);
  const xOf = (i: number) => r1(l.x0 + i * step);
  const pts = MINUTE_SALES.map((m, i) => `${xOf(i)},${yOf(m.sold)}`).join(' ');
  const peakIdx = MINUTE_SALES.indexOf(PEAK);
  const avgY = yOf(SOLD_AVG);
  const lastY = yOf(LAST.sold);
  return (
    <svg className={cx('chart', l.className)} viewBox={`0 0 ${l.w} 200`} role="img" aria-label={CHART_SUMMARY}>
      {Y_TICKS.map((t) => (
        <line key={`g${t}`} className="grid" x1={l.x0} y1={yOf(t)} x2={l.x1} y2={yOf(t)} />
      ))}
      {Y_TICKS.map((t) => (
        <text key={`t${t}`} className="axis" x={l.yLabelX} y={yOf(t) + 4} textAnchor="end">
          {t}
        </text>
      ))}
      <polygon className="area" points={`${pts} ${l.x1},${Y_BASE} ${l.x0},${Y_BASE}`} />
      <line className="line-base" x1={l.x0} y1={avgY} x2={l.x1} y2={avgY} />
      <polyline className="line" points={pts} />
      <circle cx={l.x1} cy={lastY} r={4} style={{ fill: 'var(--link)', stroke: 'var(--surface)', strokeWidth: 2 }} />
      <text className="axis" x={Math.round(xOf(peakIdx) + 7.5)} y={25} style={{ fill: 'var(--text)' }}>
        최고 {fmt(PEAK.sold)}석({PEAK.at})
      </text>
      <text className="axis" x={l.x1} y={110} textAnchor="end">
        평균 분당 {Math.round(SOLD_AVG)}석
      </text>
      <text className="axis" x={l.x1 - 8} y={150} textAnchor="end" style={{ fill: 'var(--text)' }}>
        {LAST.sold}석
      </text>
      {[0, 5, 10, 15, 20].map((i) => (
        <text key={`x${i}`} className="axis" x={xOf(i)} y={186} textAnchor="middle">
          {MINUTE_SALES[i]?.at}
        </text>
      ))}
    </svg>
  );
}

export function MinuteChart() {
  return (
    <>
      {LAYOUTS.map((l) => (
        <Chart key={l.w} l={l} />
      ))}
    </>
  );
}

/** 표의 행 머리(th scope=row)를 키트 머리 칸 모양이 아니라 본문 칸 글자로 */
export const ROW_HEAD = { background: 'transparent', color: 'var(--text)', fontSize: 13, lineHeight: '18px', fontWeight: 500 } as const;

/** '표로 보기': 시각마다 판매 매수 */
export function MinuteTable({ roundLabel }: { roundLabel: string }) {
  return (
    <div className="table-wrap table-scroll" role="region" aria-label="분당 판매 표" tabIndex={0} style={{ maxHeight: 320, overflowY: 'auto' }}>
      <table className="table dense">
        <caption className="sr-only">{roundLabel} 분당 판매 매수(잠정). 오픈 20:00 KST부터 1분 단위</caption>
        <thead>
          <tr>
            <th scope="col">시각(KST)</th>
            <th scope="col" className="r">
              판매 매수
            </th>
          </tr>
        </thead>
        <tbody>
          {MINUTE_SALES.map((m) => (
            <tr key={m.at}>
              <th scope="row" className="num" style={ROW_HEAD}>
                {m.at}
              </th>
              <td className="r">{fmt(m.sold)}석</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
