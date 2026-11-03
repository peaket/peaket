// 대기열 진입·입장 처리량(SCR-029 T=0 탭, d5 §7.2 '진입 RPS·p99'·'serving 속도'). 보드 SCR-029-d의 w-entry 마크업.
// 그래프는 보드가 SVG로 그린 그대로다(design.md 결정 8). 선 좌표는 호스트가 최근 창으로 계산해 넘긴다.
import { Fragment } from 'react';
import { Judgement, TableToggle, WidgetFrame, type WidgetBaseProps } from './common';

export interface EntrySeries {
  /** 그림 위 글(지금 값·최고) */
  caption: string;
  /** 화면 낭독기용 요약 */
  aria: string;
  /** polyline points(가로 44~552, 세로 3~48) */
  points: string;
}

export interface EntryThroughputData {
  rps: EntrySeries;
  p99: EntrySeries & { status: string; ok: boolean };
  serving: EntrySeries & { expectedLabel: string; marker?: { x: number; label: string } };
  nowX: number;
  nowLabel: string;
  ticks: { x: number; label: string }[];
}

export interface EntryThroughputWidgetProps extends WidgetBaseProps {
  data: EntryThroughputData;
}

const ID = 'w-entry';
const TITLE = '대기열 진입·입장 처리량';

function Ticks({ ticks }: { ticks: EntryThroughputData['ticks'] }) {
  return (
    <>
      {ticks.map((t) => (
        <text key={t.label} className="axis" x={t.x} y={61} textAnchor="middle">
          {t.label}
        </text>
      ))}
    </>
  );
}

export function EntryThroughputWidget({ data, ...base }: EntryThroughputWidgetProps) {
  const { rps, p99, serving, nowX, ticks } = data;
  return (
    <WidgetFrame
      id={ID}
      title={TITLE}
      base={base}
      actions={<TableToggle />}
      bodyStyle={{ gap: 8 }}
      foldMeta={
        <>
          <span className={p99.ok ? 'slo slo-ok' : 'slo slo-burning'}>{p99.ok ? '정상' : '주의'}</span>
          <span>{rps.caption}</span>
        </>
      }
    >
      <figure className="col" style={{ gap: 2 }}>
        <figcaption className="row between t-xs">
          <span className="fw-b">진입 요청(초당)</span>
          <span className="num muted">{rps.caption}</span>
        </figcaption>
        <svg className="chart" viewBox="0 0 560 64" role="img" aria-label={rps.aria}>
          <line className="grid" x1="44" y1="46" x2="552" y2="46" />
          <line className="grid" x1="44" y1="27.8" x2="552" y2="27.8" />
          <line className="line-base" x1="44" y1="9.6" x2="552" y2="9.6" />
          <text className="axis" x="548" y="21" textAnchor="end">
            설계 피크 20만/초
          </text>
          <text className="axis" x="38" y="49" textAnchor="end">
            0
          </text>
          <text className="axis" x="38" y="31" textAnchor="end">
            10만
          </text>
          <polyline className="line" points={rps.points} />
          <line className="now" x1={nowX} y1="3" x2={nowX} y2="48" />
          <Ticks ticks={ticks} />
        </svg>
      </figure>
      <figure className="col" style={{ gap: 2 }}>
        <figcaption className="row between t-xs">
          <span className="fw-b">진입 응답 p99</span>
          <span className="row" style={{ gap: 8 }}>
            <span className="num muted">{p99.caption}</span>
            <span className={p99.ok ? 'slo slo-ok' : 'slo slo-burning'}>{p99.status}</span>
          </span>
        </figcaption>
        <svg className="chart" viewBox="0 0 560 64" role="img" aria-label={p99.aria}>
          <line className="grid" x1="44" y1="46" x2="552" y2="46" />
          <line className="grid" x1="44" y1="30" x2="552" y2="30" />
          <line className="slo-line" x1="44" y1="14" x2="552" y2="14" />
          <text className="axis" x="548" y="10" textAnchor="end">
            기준 200ms
          </text>
          <text className="axis" x="38" y="49" textAnchor="end">
            0
          </text>
          <text className="axis" x="38" y="33" textAnchor="end">
            100
          </text>
          <polyline className="line" points={p99.points} />
          <line className="now" x1={nowX} y1="3" x2={nowX} y2="48" />
          <Ticks ticks={ticks} />
        </svg>
      </figure>
      <figure className="col" style={{ gap: 2 }}>
        <figcaption className="row between t-xs">
          <span className="fw-b">입장 처리량(serving 전진, 초당)</span>
          <span className="num muted">{serving.caption}</span>
        </figcaption>
        <svg className="chart" viewBox="0 0 560 64" role="img" aria-label={serving.aria}>
          <line className="grid" x1="44" y1="46" x2="552" y2="46" />
          <line className="grid" x1="44" y1="19.4" x2="552" y2="19.4" />
          <line className="line-base" x1="44" y1="38.5" x2="552" y2="38.5" />
          <text className="axis" x="548" y="35" textAnchor="end">
            {serving.expectedLabel}
          </text>
          <text className="axis" x="38" y="49" textAnchor="end">
            0
          </text>
          <text className="axis" x="38" y="22.5" textAnchor="end">
            20
          </text>
          {serving.marker ? (
            <Fragment>
              <line className="grid" x1={serving.marker.x} y1="3" x2={serving.marker.x} y2="48" />
              <text className="axis" x={serving.marker.x + 5} y="30">
                {serving.marker.label}
              </text>
            </Fragment>
          ) : null}
          <polyline className="line" points={serving.points} />
          <line className="now" x1={nowX} y1="3" x2={nowX} y2="48" />
          <Ticks ticks={ticks} />
        </svg>
      </figure>
      <div className="legend" aria-hidden="true">
        <span className="legend-item">
          <span className="swatch" />
          관측
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: 'var(--danger)' }} />
          SLO 기준(점선)
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: 'var(--text-muted)' }} />
          설계 피크·기대치(점선)
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ width: 2, height: 12, background: 'var(--text)' }} />
          {data.nowLabel}
        </span>
      </div>
      <Judgement>진입이 기준 밖이면 진입 Degraded 자동 전환을 확인하고, 한 대역에 몰리면 명령 4. 입장 처리량이 기대와 다르면 명령 1·2</Judgement>
    </WidgetFrame>
  );
}
