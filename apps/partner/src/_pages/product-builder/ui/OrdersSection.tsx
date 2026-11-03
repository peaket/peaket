// SCR-023 [굿즈 주문 현황] 탭(보드 상태 '굿즈 주문 현황', '파트너 R(주문 현황)' 권한). 개인정보 없는 집계만 보인다.
// 일자별 주문 막대그래프는 보드가 SVG로 그린 것을 크기별(데스크톱 920·태블릿 640·휴대폰 320 폭)로 그대로 옮겼다.
import { dailyOrders, productOrderRows, productOrderTotals } from '../model/products';
import { ChartOrTable } from './ChartOrTable';

const n = (v: number) => v.toLocaleString('ko-KR');
const CHART_LABEL =
  '일자별 주문 건수 막대그래프. 판매를 시작한 10/7(수)에 420건으로 가장 많고, 그 뒤 하루 64~180건이며 10/14(수)는 19:30 KST까지 80건입니다. 합계 1,204건.';

interface ChartGeom {
  w: number;
  h: number;
  x1: number;
  x2: number;
  yTop: number;
  yBase: number;
  axisX: number;
  bar0: number;
  step: number;
  barW: number;
  labelY: number;
  /** 날짜 눈금을 몇 칸마다 */
  every: number;
  shortDates: boolean;
  peak: { x: number; y: number; text: string };
}

const GEOM: Record<'d' | 't' | 'm', ChartGeom> = {
  d: { w: 920, h: 200, x1: 44, x2: 900, yTop: 12, yBase: 164, axisX: 36, bar0: 65.5, step: 107, barW: 64, labelY: 186, every: 1, shortDates: false, peak: { x: 137, y: 34, text: '최고 420건(10/7)' } },
  t: { w: 640, h: 200, x1: 40, x2: 624, yTop: 12, yBase: 164, axisX: 32, bar0: 54.5, step: 73, barW: 44, labelY: 186, every: 1, shortDates: false, peak: { x: 106, y: 34, text: '최고 420건(10/7)' } },
  m: { w: 320, h: 180, x1: 30, x2: 312, yTop: 12, yBase: 146, axisX: 24, bar0: 36.6, step: 35.26, barW: 22, labelY: 164, every: 2, shortDates: true, peak: { x: 64, y: 30, text: '최고 420건' } },
};

function OrdersChart({ size, className }: { size: 'd' | 't' | 'm'; className: string }) {
  const g = GEOM[size];
  const max = 450;
  const span = g.yBase - g.yTop;
  const ticks = [450, 300, 150, 0];
  return (
    <svg className={`chart ${className}`} viewBox={`0 0 ${g.w} ${g.h}`} role="img" aria-label={CHART_LABEL}>
      {ticks.map((t) => {
        const y = g.yBase - (t / max) * span;
        return <line key={`g${t}`} className="grid" x1={g.x1} y1={y} x2={g.x2} y2={y} />;
      })}
      {ticks.map((t) => {
        const y = g.yBase - (t / max) * span;
        return (
          <text key={`a${t}`} className="axis" x={g.axisX} y={y + 4} textAnchor="end">
            {t}
          </text>
        );
      })}
      {dailyOrders.map((d, i) => {
        const hgt = (d.count / max) * span;
        return <rect key={d.date} className="bar" x={g.bar0 + g.step * i} y={g.yBase - hgt} width={g.barW} height={hgt} rx={3} />;
      })}
      <text className="axis" x={g.peak.x} y={g.peak.y} style={{ fill: 'var(--text)' }}>
        {g.peak.text}
      </text>
      {dailyOrders.map((d, i) =>
        i % g.every === 0 ? (
          <text key={`x${d.date}`} className="axis" x={g.bar0 + g.step * i + g.barW / 2} y={g.labelY} textAnchor="middle">
            {g.shortDates ? d.short : d.date}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function DailyTable() {
  return (
    <div className="table-wrap">
      <table className="table dense">
        <caption className="sr-only">일자별 주문 건수, 10/14(수)는 19:30 KST까지</caption>
        <thead>
          <tr>
            <th scope="col">날짜</th>
            <th scope="col" className="r">
              주문
            </th>
          </tr>
        </thead>
        <tbody>
          {dailyOrders.map((d) => (
            <tr key={d.date}>
              <th scope="row" className="fw-m" style={{ background: 'transparent', fontSize: 13, color: 'var(--text)' }}>
                {d.date}
              </th>
              <td className="r">{n(d.count)}건</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="fw-b">합계</td>
            <td className="r fw-b">{n(productOrderTotals.orders)}건</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function SelectField({ id, label, options, className }: { id: string; label: string; options: string[]; className?: string }) {
  return (
    <div className={`field ${className ?? ''}`}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="input-group input-group-sm">
        <select id={id} defaultValue={options[0]}>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
      </div>
    </div>
  );
}

export function OrdersSection() {
  return (
    <section className="col" style={{ gap: 16 }} aria-labelledby="h-orders">
      <div className="section-title">
        <h2 id="h-orders">굿즈 주문 현황</h2>
        <span className="t-xs muted md:text-[14px]">10/14(수) 19:30 KST 기준</span>
      </div>
      <div className="banner banner-info" role="note">
        <i className="ic ic-shield" aria-hidden="true" />
        <div className="banner-body">개인정보 없이 집계만 봅니다. 반품은 판매자가 도착을 확인한 건만 셉니다.</div>
      </div>
      <form className="toolbar max-lg:grid max-lg:grid-cols-2" role="search" aria-label="주문 현황 거르기" action="/products/orders" style={{ alignItems: 'flex-end', gap: 12 }}>
        <SelectField id="o-period" label="기간" className="lg:w-[180px]" options={['최근 30일', '전체']} />
        <SelectField id="o-event" label="공연" className="lg:w-[260px]" options={['전체 공연', 'LUMEN 콘서트 2026 서울']} />
      </form>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4" role="group" aria-label="굿즈 주문 요약, 최근 30일">
        <div className="stat">
          <span className="stat-label">주문</span>
          <span className="stat-value">1,204건</span>
          <span className="stat-meta">상품 4개</span>
        </div>
        <div className="stat">
          <span className="stat-label">판매 수량</span>
          <span className="stat-value">1,890개</span>
          <span className="stat-meta">취소·반품을 뺀 수</span>
        </div>
        <div className="stat">
          <span className="stat-label">수령 방식</span>
          <span className="stat-value text-[18px] leading-6 md:max-lg:text-[22px] md:max-lg:leading-[34px] lg:text-[20px] lg:leading-[26px]">
            택배 62%
            <br className="md:max-lg:hidden" />
            <span className="hidden md:max-lg:inline"> · </span>
            현장 수령 38%
          </span>
          <span className="stat-meta">
            판매 수량 기준<span className="max-md:hidden"> · 현장 수령은 공연 당일</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">취소·반품</span>
          <span className="stat-value">41건</span>
          <span className="stat-meta">취소 32건 · 반품 9건</span>
        </div>
      </div>

      <section className="col" style={{ gap: 10 }} aria-labelledby="h-o-t">
        <div className="row between" style={{ gap: 8 }}>
          <h3 className="t-md fw-b" id="h-o-t">
            상품별 주문
          </h3>
          <span className="t-xs muted">[예시 숫자]</span>
        </div>
        <div className="table-wrap max-md:hidden">
          <table className="table dense">
            <caption className="sr-only">상품별 주문 건수, 판매 수량, 택배와 현장 수령 수량, 취소와 반품 건수, 최근 30일</caption>
            <thead>
              <tr>
                <th scope="col">상품</th>
                <th scope="col" className="r">
                  주문
                </th>
                <th scope="col" className="r">
                  수량
                </th>
                <th scope="col" className="r">
                  택배
                </th>
                <th scope="col" className="r">
                  현장 수령
                </th>
                <th scope="col" className="r">
                  취소
                </th>
                <th scope="col" className="r">
                  반품
                </th>
              </tr>
            </thead>
            <tbody>
              {productOrderRows.map((r) => (
                <tr key={r.name}>
                  <td>
                    {r.soldOut ? (
                      <span className="row wrap" style={{ gap: 6 }}>
                        <span className="fw-b">{r.name}</span>
                        <span className="badge">품절</span>
                      </span>
                    ) : (
                      <span className="fw-b">{r.name}</span>
                    )}
                  </td>
                  <td className="r">{n(r.orders)}</td>
                  <td className="r">{n(r.qty)}</td>
                  <td className="r">{n(r.parcel)}</td>
                  <td className={r.pickup === null ? 'r muted' : 'r'}>{r.pickup === null ? '—' : n(r.pickup)}</td>
                  <td className="r">{n(r.cancels)}</td>
                  <td className="r">{n(r.returns)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="fw-b">합계</td>
                <td className="r fw-b">{n(productOrderTotals.orders)}</td>
                <td className="r fw-b">{n(productOrderTotals.qty)}</td>
                <td className="r fw-b">{n(productOrderTotals.parcel)}</td>
                <td className="r fw-b">{n(productOrderTotals.pickup)}</td>
                <td className="r fw-b">{n(productOrderTotals.cancels)}</td>
                <td className="r fw-b">{n(productOrderTotals.returns)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <ul className="col md:hidden" style={{ gap: 12 }} aria-label="상품별 주문 건수, 판매 수량, 택배와 현장 수령 수량, 취소와 반품 건수, 최근 30일">
          {productOrderRows.map((r, i) => (
            <li key={r.name}>
              <article className="card col" style={{ padding: '14px 16px', gap: 8 }} aria-labelledby={`po-${i}`}>
                <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <h4 className="t-md fw-b" id={`po-${i}`}>
                    {r.name}
                  </h4>
                  {r.soldOut ? <span className="badge">품절</span> : null}
                </div>
                <dl className="kv">
                  <dt>주문 · 수량</dt>
                  <dd>
                    {n(r.orders)}건 · {n(r.qty)}개
                  </dd>
                  <dt>택배 · 현장 수령</dt>
                  <dd>
                    {n(r.parcel)} · {r.pickup === null ? <span className="muted">—</span> : n(r.pickup)}
                  </dd>
                  <dt>취소 · 반품</dt>
                  <dd>
                    {r.cancels} · {r.returns}
                  </dd>
                </dl>
              </article>
            </li>
          ))}
        </ul>
        <p className="t-xs muted">— 칸은 그 상품에 없는 수령 방식입니다. 주문이 있는 상품만 보입니다.</p>
      </section>

      <ChartOrTable
        titleId="h-o-c"
        title="일자별 주문"
        sub={
          <>
            <span className="max-md:hidden">판매를 시작한 </span>10/7(수)부터 하루 주문 건수 · 10/14(수)는 19:30 KST까지 · [예시 숫자]
          </>
        }
        chart={
          <>
            <OrdersChart size="d" className="hidden lg:block" />
            <OrdersChart size="t" className="hidden md:max-lg:block" />
            <OrdersChart size="m" className="md:hidden" />
          </>
        }
        table={<DailyTable />}
      />
    </section>
  );
}
