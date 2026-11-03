// SCR-023 [상품 정산] 탭(보드 상태 '상품 정산', POL-039 ②, settlement §4.5). 굿즈와 티켓 연동 부가 상품은 회차 정산서와 따로 상품 정산서로 낸다.
// 이의 제기는 파트너 관리자만(회차 정산서 이의와 같다). 휴대폰에서도 정산서 보기와 이의 제기를 한다(d5 §3.9).
import { AdminOnly } from '@/features/admin-only';
import { PAYOUT_HOLDS, SETTLE_BASIS, productStatements } from '../model/products';

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

function StatusBadges({ disputeBy }: { disputeBy: string }) {
  return (
    <div className="row wrap" style={{ gap: 4 }}>
      <span className="badge badge-primary">통지됨</span>
      <span className="badge">
        <i className="ic ic-clock" aria-hidden="true" />
        이의 기한 {disputeBy}
      </span>
    </div>
  );
}

export function SettlementSection({ isMember }: { isMember: boolean }) {
  return (
    <section className="col" style={{ gap: 16 }} aria-labelledby="h-ps">
      <div className="section-title">
        <h2 id="h-ps">상품 정산</h2>
        <span className="t-xs muted md:text-[14px]">10/14(수) 19:30 KST 기준</span>
      </div>
      <p className="t-sm muted">
        굿즈와 티켓 연동 부가 상품은 회차 정산서와 따로 상품 정산서로 냅니다. 결제 상점마다 한 주(월~일, KST)에 정산 기준일이 든 항목을 매주 첫 영업일에 계산하고,
        계산일로부터 4영업일 뒤 지급합니다.
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="group" aria-label="상품 정산 요약">
        <div className="stat max-md:col-span-2">
          <span className="stat-label">정산 대기</span>
          <span className="t-lg num">₩36,412,000</span>
          <span className="stat-meta">구매 확정이나 반품 기한이 지난 주문부터 다음 주 정산서에 들어갑니다</span>
        </div>
        <div className="stat card is-selected max-md:col-span-2">
          <span className="stat-label">이번 정산서 지급액</span>
          <span className="t-lg num max-md:text-[24px] max-md:leading-8">₩3,882,180</span>
          <span className="stat-meta">10/5(월)~10/11(일) · 결제 상점 2곳 합계</span>
        </div>
        <div className="stat">
          <span className="stat-label">지급 예정일</span>
          <span className="t-lg num max-md:text-[16px] max-md:font-bold">10/16(금)</span>
          <span className="stat-meta">
            <span className="max-md:hidden">계산 10/12(월) 06:00 KST부터 4영업일 뒤</span>
            <span className="md:hidden">계산일부터 4영업일 뒤</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">이의 기한</span>
          <span className="t-lg num max-md:text-[16px] max-md:font-bold">10/14(수)</span>
          <span className="stat-meta">
            통지 뒤 2영업일<span className="max-md:hidden"> · 파트너 관리자</span>
          </span>
        </div>
      </div>
      <div className="toolbar max-lg:grid max-lg:grid-cols-2 max-md:grid-cols-1" style={{ alignItems: 'flex-end', gap: 12 }}>
        <SelectField id="ps-week" label="기간" className="lg:w-[240px]" options={['10/5(월)~10/11(일)']} />
        <SelectField id="ps-store" label="결제 상점" className="max-md:hidden lg:w-[240px]" options={['전체 결제 상점', '토스페이먼츠 일반', '토스페이먼츠 에스크로']} />
      </div>

      <section className="col" style={{ gap: 10 }} aria-labelledby="h-ps-t">
        <div className="row between wrap" style={{ gap: '4px 12px' }}>
          <h3 className="t-md fw-b" id="h-ps-t">
            결제 상점별 상품 정산서
          </h3>
          <span className="t-xs muted">
            통지 뒤 2영업일 안에 이의를 낼 수 있습니다<span className="md:hidden"> · 파트너 관리자</span>
          </span>
        </div>
        <div className="table-wrap table-scroll max-md:hidden" role="region" aria-label="결제 상점별 상품 정산서 표" tabIndex={0}>
          <table className="table dense" style={{ minWidth: 920 }}>
            <caption className="sr-only">10/5(월)~10/11(일) 상품 정산서, 결제 상점별 금액 항목과 지급 상태</caption>
            <thead>
              <tr>
                <th scope="col">결제 상점</th>
                <th scope="col" className="r">
                  판매 대금
                </th>
                <th scope="col" className="r">
                  환급
                </th>
                <th scope="col" className="r">
                  수수료·부가세
                </th>
                <th scope="col" className="r">
                  상계
                </th>
                <th scope="col" className="r">
                  지급액
                </th>
                <th scope="col">지급 예정일</th>
                <th scope="col">상태</th>
              </tr>
            </thead>
            <tbody>
              {productStatements.map((s, i) => (
                <tr key={s.store}>
                  <td className="fw-b">{s.store}</td>
                  <td className="r">{s.sales}</td>
                  <td className="r">{s.refund}</td>
                  <td className="r">{s.fee}</td>
                  <td className="r">{s.offset}</td>
                  <td className="r fw-b">{s.payout}</td>
                  <td>
                    <span className="num">{s.payDate}</span>
                  </td>
                  <td>
                    <div className="col" style={{ gap: 6, alignItems: 'flex-start' }}>
                      <StatusBadges disputeBy={s.disputeBy} />
                      <AdminOnly isMember={isMember} id={`ps-dispute-${i}`} className="btn btn-outline btn-sm">
                        <span aria-hidden="true">이의 제기</span>
                        <span className="sr-only">{s.store} 상품 정산서 이의 제기</span>
                      </AdminOnly>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="col md:hidden" style={{ gap: 12 }} aria-label="10/5(월)~10/11(일) 상품 정산서, 결제 상점별 금액 항목과 지급 상태">
          {productStatements.map((s, i) => (
            <li key={s.store} className="card pad col" style={{ gap: 12 }}>
              <div className="row between" style={{ gap: 8 }}>
                <h4 className="t-md fw-b">{s.store}</h4>
                <span className="badge badge-primary">통지됨</span>
              </div>
              <div className="row between" style={{ gap: 8, alignItems: 'baseline' }}>
                <span className="t-sm muted">지급액</span>
                <span className="t-lg num">{s.payout}</span>
              </div>
              <div className="row between" style={{ gap: 8 }}>
                <span className="t-sm muted">지급 예정일</span>
                <span className="t-sm fw-m num">{s.payDate}</span>
              </div>
              <span className="badge" style={{ alignSelf: 'flex-start' }}>
                <i className="ic ic-clock" aria-hidden="true" />
                이의 기한 {s.disputeBy}
              </span>
              <hr className="divider" />
              <dl className="kv" style={{ rowGap: 6 }}>
                <dt>판매 대금</dt>
                <dd>{s.sales}</dd>
                <dt>환급</dt>
                <dd>{s.refund}</dd>
                <dt>수수료·부가세</dt>
                <dd>{s.fee}</dd>
                <dt>상계</dt>
                <dd>{s.offset}</dd>
              </dl>
              <AdminOnly isMember={isMember} id={`ps-dispute-m-${i}`} className="btn btn-outline btn-block">
                <span aria-hidden="true">이의 제기</span>
                <span className="sr-only">{s.store} 상품 정산서 이의 제기</span>
              </AdminOnly>
            </li>
          ))}
        </ul>
        <p className="t-xs muted">
          지급액 = 판매 대금 − 환급 − 중개수수료와 부가세 − 미수금 상계. 판매 대금에는 구매자가 낸 처음 배송비가 들어갑니다.
          <span className="max-md:hidden"> 수수료율 10%(예시)는 상품을 처음 공개할 때 그 상품에 고정합니다.</span>
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-12" style={{ alignItems: 'start' }}>
        <section className="card-flat pad col lg:col-span-7" style={{ gap: 12 }} aria-labelledby="h-ps-hold">
          <h3 className="t-sm fw-b" id="h-ps-hold">
            지급이 멈추거나 늦어질 때
          </h3>
          <dl className="col gap-3.5 md:gap-2.5">
            {PAYOUT_HOLDS.map((h) => (
              <div key={h.label} className="flex flex-col gap-1 md:flex-row md:items-start md:gap-3">
                <dt className="md:w-[92px] md:flex-none">
                  <span className={h.badge}>{h.label}</span>
                </dt>
                <dd className="t-sm">{h.text}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="card pad col max-lg:-order-1 lg:col-span-5" style={{ gap: 10 }} aria-labelledby="h-ps-day">
          <h3 className="t-sm fw-b" id="h-ps-day">
            정산 기준일
          </h3>
          <dl className="kv max-md:hidden" style={{ rowGap: 8 }}>
            {SETTLE_BASIS.map((b) => (
              <div key={b.dt} className="contents">
                <dt>{b.dt}</dt>
                <dd>{b.dd}</dd>
              </div>
            ))}
          </dl>
          <dl className="col md:hidden" style={{ gap: 8 }}>
            {SETTLE_BASIS.map((b) => (
              <div key={b.dt} className="col" style={{ gap: 2 }}>
                <dt className="t-xs muted">{b.dt}</dt>
                <dd className="t-sm fw-m">{b.dd}</dd>
              </div>
            ))}
          </dl>
          <p className="t-xs muted">반품 요청 중인 항목은 결과가 날 때까지 넣지 않습니다.</p>
        </section>
      </div>
    </section>
  );
}
