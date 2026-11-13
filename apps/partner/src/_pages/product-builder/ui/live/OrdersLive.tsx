'use client';
// SCR-023 [굿즈 주문 현황] 실제 API 판(openapi listPartnerMerchOrderStats). 개인정보 없는 집계만 본다.
import { useState } from 'react';
import { listMerchOrderStats } from '@/shared/api/partner-live';
import { EmptyCard, ErrorCard, LoadingCard, useAsync } from '@/shared/ui/Async';

const n = (v: number) => v.toLocaleString('ko-KR');

function SelectField({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: readonly { value: string; label: string }[] }) {
  return (
    <div className="field lg:w-[220px]">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="input-group input-group-sm">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
      </div>
    </div>
  );
}

export function LiveOrdersSection() {
  const [period, setPeriod] = useState('30');
  const key = `orders:${period}`;
  const page = useAsync(key, (signal) => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - Number(period) + 1);
    return listMerchOrderStats({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }, signal);
  });

  return (
    <section className="col" style={{ gap: 16 }} aria-labelledby="h-orders">
      <div className="section-title">
        <h2 id="h-orders">굿즈 주문 현황</h2>
        <span className="t-xs muted md:text-[14px]">최근 {period}일</span>
      </div>
      <div className="banner banner-info" role="note">
        <i className="ic ic-shield" aria-hidden="true" />
        <div className="banner-body">개인정보 없이 집계만 봅니다. 반품은 판매자가 도착을 확인한 건만 셉니다.</div>
      </div>
      <div className="toolbar max-lg:grid max-lg:grid-cols-2" role="search" aria-label="주문 현황 거르기" style={{ alignItems: 'flex-end', gap: 12 }}>
        <SelectField
          id="o-period"
          label="기간"
          value={period}
          onChange={setPeriod}
          options={[
            { value: '7', label: '최근 7일' },
            { value: '30', label: '최근 30일' },
            { value: '90', label: '최근 90일' },
          ]}
        />
      </div>

      {page.status === 'loading' ? <LoadingCard label="주문 현황을 불러오는 중입니다" /> : null}
      {page.status === 'error' ? <ErrorCard error={page.error} onRetry={page.reload} fallback="주문 현황을 불러오지 못했습니다" /> : null}
      {page.status === 'ready' && page.data.totals.orderCount === 0 ? <EmptyCard title="아직 주문이 없습니다" /> : null}

      {page.status === 'ready' && page.data.totals.orderCount > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4" role="group" aria-label="굿즈 주문 요약">
            <div className="stat">
              <span className="stat-label">주문</span>
              <span className="stat-value">{n(page.data.totals.orderCount)}건</span>
              <span className="stat-meta">상품 {page.data.items.length}개</span>
            </div>
            <div className="stat">
              <span className="stat-label">판매 수량</span>
              <span className="stat-value">{n(page.data.totals.quantity)}개</span>
              <span className="stat-meta">취소·반품을 뺀 수</span>
            </div>
            <div className="stat">
              <span className="stat-label">수령 방식</span>
              <span className="stat-value text-[18px] leading-6 md:max-lg:text-[22px] md:max-lg:leading-[34px] lg:text-[20px] lg:leading-[26px]">
                택배 {n(page.data.totals.deliveryOrderCount)}
                <br className="md:max-lg:hidden" />
                <span className="hidden md:max-lg:inline"> · </span>
                현장 수령 {n(page.data.totals.pickupOrderCount)}
              </span>
              <span className="stat-meta">주문 건수 기준</span>
            </div>
            <div className="stat">
              <span className="stat-label">취소·반품</span>
              <span className="stat-value">{n(page.data.totals.cancelReturnCount)}건</span>
              <span className="stat-meta">도착을 확인한 반품 포함</span>
            </div>
          </div>

          <section className="col" style={{ gap: 10 }} aria-labelledby="h-o-t">
            <h3 className="t-md fw-b" id="h-o-t">
              상품별 주문
            </h3>
            <div className="table-wrap max-md:hidden">
              <table className="table dense">
                <caption className="sr-only">상품별 주문 건수, 판매 수량, 택배와 현장 수령 수량, 취소와 반품 건수</caption>
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
                  {page.data.items.map((r) => (
                    <tr key={r.productId}>
                      <td className="fw-b">{r.productName}</td>
                      <td className="r">{n(r.orderCount)}</td>
                      <td className="r">{n(r.quantity)}</td>
                      <td className="r">{n(r.deliveryQuantity)}</td>
                      <td className="r">{n(r.pickupQuantity)}</td>
                      <td className="r">{n(r.cancelCount)}</td>
                      <td className="r">{n(r.returnCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="col" style={{ gap: 10 }} aria-labelledby="h-o-d">
            <h3 className="t-md fw-b" id="h-o-d">
              일자별 주문
            </h3>
            <div className="table-wrap">
              <table className="table dense">
                <caption className="sr-only">일자별 주문 건수</caption>
                <thead>
                  <tr>
                    <th scope="col">날짜</th>
                    <th scope="col" className="r">
                      주문
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.data.daily.map((d) => (
                    <tr key={d.date}>
                      <th scope="row" className="fw-m" style={{ background: 'transparent', fontSize: 13, color: 'var(--text)' }}>
                        {d.date}
                      </th>
                      <td className="r">{n(d.orderCount)}건</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
