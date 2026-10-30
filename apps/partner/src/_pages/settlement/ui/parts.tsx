// SCR-027 화면 조각(서버): 회차 고르기 · 잠금·빈 상태 카드 · 시간대별 누적 판매 그래프(보드 SVG를 데이터로 다시 그림).
import type { ReactNode } from 'react';
import { clockAfterOpen, cumulativeSales } from '../model/settlement';

/** 시트(휴대폰)에서 버튼을 세로로: 주 버튼이 위(보드 SCR-027-m 이의 제기 시트) */
export const SHEET_ACTIONS = 'dialog-actions max-md:flex-col-reverse max-md:[&>*]:w-full';
export const SHEET_PRIMARY = 'max-md:min-h-[52px] max-md:rounded-[var(--r-lg)] max-md:text-base';

/** 회차 고르기. 폭: 휴대폰 꽉 참 · 태블릿 240 · 데스크톱 280(보드 m·t·d) */
export function RoundSelect({ id, rounds, className }: { id: string; rounds: readonly string[]; className?: string }) {
  return (
    <div className={`field ${className ?? 'md:w-[240px] lg:w-[280px]'}`}>
      <label className="label" htmlFor={id}>
        회차
      </label>
      <div className="input-group md:h-10 md:[&>select]:text-sm">
        <select id={id} defaultValue={rounds[0]}>
          {rounds.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <i className="ic ic-chevron-down" aria-hidden="true" />
      </div>
    </div>
  );
}

/** 가운데 상태 카드(확정 전·잠금·보유 기간 끝·기록 없음) */
export function StateCard({
  icon,
  title,
  children,
  status = true,
  titleClass = 't-md fw-b md:text-[20px] md:leading-[27px]',
}: {
  icon: string;
  title: ReactNode;
  children?: ReactNode;
  status?: boolean;
  /** 제목 글자(휴대폰 t-md 굵게, 태블릿부터 t-lg가 기본) */
  titleClass?: string;
}) {
  return (
    <div className="card">
      <div className="state px-5 py-10 md:px-6 md:py-12" role={status ? 'status' : undefined}>
        <span className="state-icon">
          <i className={`ic ${icon}`} aria-hidden="true" />
        </span>
        <h3 className={`${titleClass} md:max-w-[560px] lg:max-w-[640px]`}>
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

/* ---------- 시간대별 누적 판매 그래프 ---------- */

interface ChartSpec {
  w: number;
  h: number;
  x0: number;
  x1: number;
  top: number;
  base: number;
  yTicks: readonly number[];
  /** x축 눈금 간격(분) */
  xStep: number;
  axisX: number;
  labelY: number;
  r: number;
  mid: { dx: number; y: number; text: string };
  end: { dx: number; y: number; text: string };
}

const MAX = 2400;
const SPAN = 70; // 20:00 ~ 21:10

/** 보드 SCR-027-m(320×180)·t(640×200)·d(920×200) 그래프의 좌표 틀 */
const SPECS: Record<'m' | 't' | 'd', ChartSpec> = {
  m: {
    w: 320,
    h: 180,
    x0: 36,
    x1: 312,
    top: 12,
    base: 146,
    yTicks: [2400, 1200, 0],
    xStep: 20,
    axisX: 30,
    labelY: 164,
    r: 3.5,
    mid: { dx: 7.3, y: 98, text: '20:22 · 1,204매' },
    end: { dx: -4.1, y: 50, text: '21:09 매진' },
  },
  t: {
    w: 640,
    h: 200,
    x0: 40,
    x1: 624,
    top: 12,
    base: 164,
    yTicks: [2400, 1800, 1200, 600, 0],
    xStep: 10,
    axisX: 32,
    labelY: 186,
    r: 4,
    mid: { dx: 8, y: 106, text: '20:22 누적 1,204매' },
    end: { dx: -8, y: 48, text: '21:09 매진 · 2,400매' },
  },
  d: {
    w: 920,
    h: 200,
    x0: 44,
    x1: 900,
    top: 12,
    base: 164,
    yTicks: [2400, 1800, 1200, 600, 0],
    xStep: 10,
    axisX: 36,
    labelY: 186,
    r: 4,
    mid: { dx: 8, y: 106, text: '20:22 누적 1,204매' },
    end: { dx: -8, y: 44, text: '21:09 매진 · 2,400매' },
  },
};

const CHART_LABEL =
  '시간대별 누적 판매 그래프(확정 집계). 10/14(수) 20:00 오픈 뒤 20:22에 누적 1,204매, 21:09에 2,400매로 매진했습니다. 오픈 직후 10분이 가장 가파르고 그 뒤 분당 25매 안팎으로 늘었습니다.';

const r1 = (n: number) => Math.round(n * 10) / 10;

function CumulativeSvg({ size, className }: { size: 'm' | 't' | 'd'; className: string }) {
  const s = SPECS[size];
  const x = (min: number) => r1(s.x0 + (min / SPAN) * (s.x1 - s.x0));
  const y = (v: number) => r1(s.base - (v / MAX) * (s.base - s.top));
  const pts = cumulativeSales.map((p) => `${x(p.min)},${y(p.total)}`).join(' ');
  const last = cumulativeSales[cumulativeSales.length - 1]!;
  const mid = cumulativeSales.find((p) => p.min === 22)!;
  const xTicks = Array.from({ length: Math.floor(SPAN / s.xStep) + 1 }, (_, i) => i * s.xStep);
  const dot = { fill: 'var(--link)', stroke: 'var(--surface)', strokeWidth: 2 };
  return (
    <svg className={`chart ${className}`} viewBox={`0 0 ${s.w} ${s.h}`} role="img" aria-label={CHART_LABEL}>
      {s.yTicks.map((v) => (
        <line key={`g${v}`} className="grid" x1={s.x0} y1={y(v)} x2={s.x1} y2={y(v)} />
      ))}
      {s.yTicks.map((v) => (
        <text key={`y${v}`} className="axis" x={s.axisX} y={y(v) + 4} textAnchor="end">
          {v.toLocaleString('ko-KR')}
        </text>
      ))}
      <polygon className="area" points={`${pts} ${x(last.min)},${s.base}`} />
      <polyline className="line" points={pts} />
      <circle cx={x(mid.min)} cy={y(mid.total)} r={s.r} style={dot} />
      <circle cx={x(last.min)} cy={y(last.total)} r={s.r} style={dot} />
      <text className="axis" x={r1(x(mid.min) + s.mid.dx)} y={s.mid.y} style={{ fill: 'var(--text)' }}>
        {s.mid.text}
      </text>
      <text className="axis" x={r1(x(last.min) + s.end.dx)} y={s.end.y} textAnchor="end" style={{ fill: 'var(--text)' }}>
        {s.end.text}
      </text>
      {xTicks.map((m) => (
        <text key={`x${m}`} className="axis" x={x(m)} y={s.labelY} textAnchor="middle">
          {clockAfterOpen(m)}
        </text>
      ))}
    </svg>
  );
}

/** 휴대폰·태블릿·데스크톱 그래프 셋을 폭에 따라 하나만 보인다 */
export function CumulativeChart() {
  return (
    <>
      <CumulativeSvg size="m" className="md:hidden" />
      <CumulativeSvg size="t" className="max-md:hidden lg:hidden" />
      <CumulativeSvg size="d" className="max-lg:hidden" />
    </>
  );
}

/** 같은 숫자를 표로(그래프 대신) */
export function CumulativeTable() {
  return (
    <div className="table-wrap table-scroll" role="region" aria-label="시간대별 누적 판매 표" tabIndex={0}>
      <table className="table dense">
        <caption className="sr-only">10/14(수) 오픈 20:00 KST부터 시각별 누적 판매 매수(확정 집계, 예시 숫자)</caption>
        <thead>
          <tr>
            <th scope="col">시각(KST)</th>
            <th scope="col" className="r">
              누적 판매
            </th>
          </tr>
        </thead>
        <tbody>
          {cumulativeSales.map((p) => (
            <tr key={p.min}>
              <th scope="row" className="num fw-m">
                {clockAfterOpen(p.min)}
                {p.total === MAX ? ' 매진' : ''}
              </th>
              <td className="r num">{p.total.toLocaleString('ko-KR')}매</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
