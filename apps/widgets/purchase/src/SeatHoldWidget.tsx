// 좌석 홀드 p99와 소진 배수(SCR-029 T=0 탭, d5 §7.2 '버짓 소진 배수'). 보드 SCR-029-d의 w-hold 마크업.
// 기준선 위반이면 StatTile 배경을 바꾸고 "경고: 에러 버짓 3.2× 속도로 소진 중"을 글로 적는다(색만으로 말하지 않는다).
import { Judgement, TableToggle, WidgetFrame, type WidgetBaseProps } from './common';

export interface SeatHoldData {
  p99: string;
  /** 'ok' | 'burning'(SEV2 3배 넘음) | 'breached'(SEV1 10배 넘음) */
  level: 'ok' | 'burning' | 'breached';
  status: string;
  meta: string;
  burn: { now: string; aria: string; points: string; alertX?: number; alertY?: number; nowX: number; ticks: { x: number; label: string }[] };
}

export interface SeatHoldWidgetProps extends WidgetBaseProps {
  data: SeatHoldData;
}

export function SeatHoldWidget({ data, ...base }: SeatHoldWidgetProps) {
  const sloClass = data.level === 'ok' ? 'slo slo-ok' : data.level === 'burning' ? 'slo slo-burning' : 'slo slo-breached';
  const statClass = data.level === 'ok' ? 'stat' : data.level === 'burning' ? 'stat is-burning' : 'stat is-breached';
  return (
    <WidgetFrame
      id="w-hold"
      title="좌석 홀드 p99"
      base={base}
      wrapHead
      actions={<TableToggle />}
      foldMeta={
        <>
          <span className={sloClass}>{data.level === 'ok' ? '정상' : `소진 ${data.burn.now}`}</span>
          <span>p99 {data.p99}</span>
        </>
      }
    >
      <div className={statClass}>
        <span className="stat-label">홀드 응답 p99</span>
        <span className="stat-value">{data.p99}</span>
        <span className={sloClass}>{data.status}</span>
        <span className="stat-meta">{data.meta}</span>
      </div>
      <figure className="col" style={{ gap: 2 }}>
        <figcaption className="row between t-xs">
          <span className="fw-b">5분 창 소진 배수</span>
          <span className="num muted">지금 {data.burn.now}</span>
        </figcaption>
        <svg className="chart" viewBox="0 0 260 72" role="img" aria-label={data.burn.aria}>
          <line className="grid" x1="28" y1="50" x2="252" y2="50" />
          <line className="line-base" x1="28" y1="39" x2="252" y2="39" />
          <line className="slo-line" x1="28" y1="13.3" x2="252" y2="13.3" />
          <text className="axis" x="30" y="35">
            SEV2 3×
          </text>
          <text className="axis" x="30" y="10">
            SEV1 10×
          </text>
          <text className="axis" x="22" y="53" textAnchor="end">
            0
          </text>
          <polyline className="line" points={data.burn.points} />
          {data.burn.alertX !== undefined ? <circle className="bar-alt" cx={data.burn.alertX} cy={data.burn.alertY ?? 38} r="3.5" /> : null}
          <line className="now" x1={data.burn.nowX} y1="3" x2={data.burn.nowX} y2="52" />
          {data.burn.ticks.map((t) => (
            <text key={t.label} className="axis" x={t.x} y="67" textAnchor="middle">
              {t.label}
            </text>
          ))}
        </svg>
      </figure>
      <Judgement>판단 순서 ②. 소진이 이어지면 최근 변경이면 되돌리기(RB-23), 명령 1 → 2 → 6 → 3</Judgement>
    </WidgetFrame>
  );
}
