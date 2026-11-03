// SCR-023 [상품 목록] 탭(보드 상태 '상품 목록'). 데스크톱 표 · 태블릿 가로 스크롤 표 · 휴대폰 카드 목록과 안내 카드.
import Link from 'next/link';
import { routes } from '@/shared/config/routes';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { PRODUCT_STATUS_BADGE, partnerProducts, type PartnerProduct } from '../model/products';

const NOTE =
  '표시 가격은 굿즈 스토어 목록에 보이는 금액입니다. 택배만 되는 상품은 배송비를 더한 총액을, 현장 수령(무료)도 되는 상품은 상품가와 택배 배송비 별도를 함께 보입니다. 티켓 연동 부가 상품은 유효 티켓을 가진 분만 마이 티켓에서 삽니다. VIP 패키지는 양도 불가가 기본입니다.';

function Thumb({ p, size }: { p: PartnerProduct; size: 40 | 48 }) {
  return (
    <span className="card-flat center muted" style={{ width: size, height: size, flex: 'none', borderRadius: 'var(--r-md)' }} aria-hidden="true">
      <i className={`ic ${p.icon}${size === 48 ? ' ic-24' : ''}`} />
    </span>
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

export function ProductListSection({ newHref }: { newHref: string }) {
  const count = partnerProducts.length;
  return (
    <section className="col" style={{ gap: 16 }} aria-labelledby="h-plist">
      <div className="section-title">
        <div className="row" style={{ gap: 10 }}>
          <h2 id="h-plist">상품 목록</h2>
          <span className="t-sm muted">{count}개 · [예시 숫자]</span>
        </div>
        <Link className="btn btn-primary max-md:hidden" href={newHref}>
          <i className="ic ic-plus" aria-hidden="true" />
          상품 만들기
        </Link>
      </div>
      <BigScreenNotice title="상품 만들기·고치기·게시는 태블릿이나 데스크톱에서 합니다" path={routes.productNew()} />
      <div className="row wrap" style={{ gap: 8 }} role="group" aria-label="상품 유형으로 거르기">
        <button className="chip is-selected" type="button" aria-pressed="true">
          전체
        </button>
        <button className="chip" type="button" aria-pressed="false">
          굿즈
        </button>
        <button className="chip" type="button" aria-pressed="false">
          티켓 연동 부가 상품
        </button>
      </div>
      <form
        className="toolbar max-lg:grid max-lg:grid-cols-3 max-md:grid-cols-2"
        role="search"
        aria-label="상품 찾기"
        action={routes.products()}
        style={{ alignItems: 'flex-end', gap: 12 }}
      >
        <div className="field max-md:col-span-2 lg:w-[280px]">
          <label className="label" htmlFor="pl-q">
            상품 이름
          </label>
          <div className="input-group input-group-sm">
            <i className="ic ic-search ic-16" aria-hidden="true" />
            <input id="pl-q" name="q" type="search" placeholder="상품 이름 찾기" />
          </div>
        </div>
        <SelectField id="pl-status" label="상태" className="lg:w-[180px]" options={['전체 상태', '판매 중', '판매 전', '품절', '숨김']} />
        <SelectField id="pl-event" label="공연" className="lg:w-[260px]" options={['전체 공연', 'LUMEN 콘서트 2026 서울', '연결하지 않음']} />
      </form>

      <div className="table-wrap table-scroll max-md:hidden" role="region" aria-label="상품 목록 표" tabIndex={0}>
        <table className="table dense" style={{ minWidth: 1000 }}>
          <caption className="sr-only">상품 {count}개의 유형, 상태, 굿즈 스토어에 보이는 표시 가격, 남은 재고와 전체 수량, 판매 기간, 연결 공연</caption>
          <thead>
            <tr>
              <th scope="col">상품</th>
              <th scope="col">유형</th>
              <th scope="col">상태</th>
              <th scope="col">표시 가격</th>
              <th scope="col" className="r">
                재고(남은/전체)
              </th>
              <th scope="col">판매 기간(KST)</th>
              <th scope="col">연결 공연</th>
              <th scope="col">
                <span className="sr-only">고치기</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {partnerProducts.map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="row" style={{ gap: 10 }}>
                    <Thumb p={p} size={40} />
                    <span className="fw-b">{p.name}</span>
                  </div>
                </td>
                <td>{p.kind}</td>
                <td>
                  <span className={PRODUCT_STATUS_BADGE[p.status]}>{p.status}</span>
                </td>
                <td>
                  {p.price.sub ? (
                    <div className="col" style={{ gap: 2 }}>
                      <span className="fw-b num">{p.price.main}</span>
                      <span className="t-xs muted num">{p.price.sub}</span>
                    </div>
                  ) : (
                    <span className="fw-b num">{p.price.main}</span>
                  )}
                </td>
                <td className="r nowrap">{p.stock}</td>
                <td>
                  <div className="col" style={{ gap: 2 }}>
                    <span className="num nowrap">{p.saleFrom}</span>
                    <span className="t-xs muted num nowrap">~ {p.saleTo}</span>
                  </div>
                </td>
                <td className={p.event === '연결하지 않음' ? 'muted' : undefined}>{p.event}</td>
                <td>
                  <Link className="btn btn-outline btn-sm" href={routes.product(p.id)} aria-label={`${p.name} 고치기`}>
                    고치기
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="col md:hidden" style={{ gap: 12 }} aria-label={`상품 ${count}개의 유형, 상태, 굿즈 스토어에 보이는 표시 가격, 남은 재고와 전체 수량, 판매 기간`}>
        {partnerProducts.map((p) => (
          <li key={p.id}>
            <article className="card col" style={{ padding: '14px 16px', gap: 10 }} aria-labelledby={`pl-${p.id}`}>
              <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                <Thumb p={p} size={48} />
                <div className="col grow" style={{ gap: 2 }}>
                  <h3 className="t-md fw-b" id={`pl-${p.id}`}>
                    {p.name}
                  </h3>
                  <span className="t-xs muted">
                    {p.kind} · {p.event}
                  </span>
                </div>
                <span className={PRODUCT_STATUS_BADGE[p.status]}>{p.status}</span>
              </div>
              <dl className="kv">
                <dt>표시 가격</dt>
                {p.price.sub ? (
                  <dd>
                    <span className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
                      <span className="fw-b">{p.price.main}</span>
                      <span className="t-xs muted fw-r">{p.price.sub}</span>
                    </span>
                  </dd>
                ) : (
                  <dd className="fw-b">{p.price.main}</dd>
                )}
                <dt>재고(남은/전체)</dt>
                <dd>{p.stock}</dd>
                <dt>판매 기간</dt>
                <dd>
                  {p.saleFrom} ~ {p.saleTo}
                </dd>
              </dl>
            </article>
          </li>
        ))}
      </ul>
      <p className="t-xs muted">{NOTE}</p>
    </section>
  );
}
