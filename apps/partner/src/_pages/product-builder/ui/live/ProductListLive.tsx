'use client';
// SCR-023 [상품 목록] 실제 API 판(openapi listPartnerProducts). 목업 ProductListSection은 ?state= 미리보기에 남긴다.
import Link from 'next/link';
import { useState } from 'react';
import { listProducts, type PartnerProductSummary, type ProductStatus } from '@/shared/api/partner-live';
import { EmptyCard, ErrorCard, LoadingCard, useAsync } from '@/shared/ui/Async';
import { routes } from '@/shared/config/routes';
import { PRODUCT_STATUS_BADGE, PRODUCT_STATUS_LABEL, kstText, priceView, stockText } from '../../model/product-live';

const NOTE =
  '표시 가격은 굿즈 스토어 목록에 보이는 금액입니다. 택배만 되는 상품은 배송비를 더한 총액을, 현장 수령(무료)도 되는 상품은 상품가와 택배 배송비 별도를 함께 보입니다.';

const STATUS_OPTIONS: readonly { value: '' | ProductStatus; label: string }[] = [
  { value: '', label: '전체 상태' },
  { value: 'ON_SALE', label: '판매 중' },
  { value: 'NOT_STARTED', label: '판매 전' },
  { value: 'SOLD_OUT', label: '품절' },
  { value: 'HIDDEN', label: '숨김' },
  { value: 'DRAFT', label: '초안' },
  { value: 'ENDED', label: '판매 끝' },
];

function Thumb() {
  return (
    <span className="card-flat center muted" style={{ width: 40, height: 40, flex: 'none', borderRadius: 'var(--r-md)' }} aria-hidden="true">
      <i className="ic ic-box" />
    </span>
  );
}

function Row({ p }: { p: PartnerProductSummary }) {
  const price = priceView(p);
  return (
    <tr>
      <td>
        <div className="row" style={{ gap: 10 }}>
          <Thumb />
          <span className="fw-b">{p.name}</span>
        </div>
      </td>
      <td>{p.type}</td>
      <td>
        <span className={PRODUCT_STATUS_BADGE[p.status]}>{PRODUCT_STATUS_LABEL[p.status]}</span>
      </td>
      <td>
        {price.sub ? (
          <div className="col" style={{ gap: 2 }}>
            <span className="fw-b num">{price.main}</span>
            <span className="t-xs muted num">{price.sub}</span>
          </div>
        ) : (
          <span className="fw-b num">{price.main}</span>
        )}
      </td>
      <td className="r nowrap">{stockText(p)}</td>
      <td>
        <div className="col" style={{ gap: 2 }}>
          <span className="num nowrap">{kstText(p.saleStartsAt)}</span>
          <span className="t-xs muted num nowrap">~ {kstText(p.saleEndsAt)}</span>
        </div>
      </td>
      <td className={p.linkedProductionTitle ? undefined : 'muted'}>{p.linkedProductionTitle ?? '연결하지 않음'}</td>
      <td>
        <Link className="btn btn-outline btn-sm" href={routes.product(p.productId)} aria-label={`${p.name} 고치기`}>
          고치기
        </Link>
      </td>
    </tr>
  );
}

export function LiveProductListSection({ newHref }: { newHref: string }) {
  const [kind, setKind] = useState<'' | 'goods' | 'addon'>('');
  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [status, setStatus] = useState<'' | ProductStatus>('');
  const key = `${kind}|${appliedQ}|${status}`;
  const page = useAsync(key, (signal) =>
    listProducts(
      {
        ...(kind === 'goods' ? { ticketLinked: false } : kind === 'addon' ? { ticketLinked: true } : {}),
        ...(status ? { status: [status] } : {}),
        ...(appliedQ ? { q: appliedQ } : {}),
        limit: 100,
      },
      signal,
    ),
  );

  const items = page.status === 'ready' ? page.data.items : [];

  return (
    <section className="col" style={{ gap: 16 }} aria-labelledby="h-plist">
      <div className="section-title">
        <div className="row" style={{ gap: 10 }}>
          <h2 id="h-plist">상품 목록</h2>
          <span className="t-sm muted">{page.status === 'ready' ? `${items.length}개` : '불러오는 중'}</span>
        </div>
        <Link className="btn btn-primary max-md:hidden" href={newHref}>
          <i className="ic ic-plus" aria-hidden="true" />
          상품 만들기
        </Link>
      </div>
      <div className="row wrap" style={{ gap: 8 }} role="group" aria-label="상품 유형으로 거르기">
        <button className={kind === '' ? 'chip is-selected' : 'chip'} type="button" aria-pressed={kind === ''} onClick={() => setKind('')}>
          전체
        </button>
        <button className={kind === 'goods' ? 'chip is-selected' : 'chip'} type="button" aria-pressed={kind === 'goods'} onClick={() => setKind('goods')}>
          굿즈
        </button>
        <button className={kind === 'addon' ? 'chip is-selected' : 'chip'} type="button" aria-pressed={kind === 'addon'} onClick={() => setKind('addon')}>
          티켓 연동 부가 상품
        </button>
      </div>
      <form
        className="toolbar max-lg:grid max-lg:grid-cols-3 max-md:grid-cols-2"
        role="search"
        aria-label="상품 찾기"
        style={{ alignItems: 'flex-end', gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          setAppliedQ(q.trim());
        }}
      >
        <div className="field max-md:col-span-2 lg:w-[280px]">
          <label className="label" htmlFor="pl-q">
            상품 이름
          </label>
          <div className="input-group input-group-sm">
            <i className="ic ic-search ic-16" aria-hidden="true" />
            <input id="pl-q" name="q" type="search" placeholder="상품 이름 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="field lg:w-[180px]">
          <label className="label" htmlFor="pl-status">
            상태
          </label>
          <div className="input-group input-group-sm">
            <select id="pl-status" value={status} onChange={(e) => setStatus(e.target.value as '' | ProductStatus)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
          </div>
        </div>
        <button className="btn btn-outline max-lg:col-span-3 max-md:col-span-2" type="submit">
          찾기
        </button>
      </form>

      {page.status === 'loading' ? <LoadingCard label="상품 목록을 불러오는 중입니다" /> : null}
      {page.status === 'error' ? <ErrorCard error={page.error} onRetry={page.reload} fallback="상품 목록을 불러오지 못했습니다" /> : null}
      {page.status === 'ready' && items.length === 0 ? (
        <EmptyCard title="아직 만든 상품이 없습니다">[상품 만들기]로 첫 상품을 만들어 보세요.</EmptyCard>
      ) : null}

      {items.length > 0 ? (
        <>
          <div className="table-wrap table-scroll max-md:hidden" role="region" aria-label="상품 목록 표" tabIndex={0}>
            <table className="table dense" style={{ minWidth: 1000 }}>
              <caption className="sr-only">상품 {items.length}개의 유형, 상태, 표시 가격, 재고, 판매 기간, 연결 공연</caption>
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
                {items.map((p) => (
                  <Row key={p.productId} p={p} />
                ))}
              </tbody>
            </table>
          </div>
          <ul className="col md:hidden" style={{ gap: 12 }} aria-label={`상품 ${items.length}개`}>
            {items.map((p) => {
              const price = priceView(p);
              return (
                <li key={p.productId}>
                  <article className="card col" style={{ padding: '14px 16px', gap: 10 }} aria-labelledby={`pl-${p.productId}`}>
                    <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                      <Thumb />
                      <div className="col grow" style={{ gap: 2 }}>
                        <h3 className="t-md fw-b" id={`pl-${p.productId}`}>
                          {p.name}
                        </h3>
                        <span className="t-xs muted">
                          {p.type} · {p.linkedProductionTitle ?? '연결하지 않음'}
                        </span>
                      </div>
                      <span className={PRODUCT_STATUS_BADGE[p.status]}>{PRODUCT_STATUS_LABEL[p.status]}</span>
                    </div>
                    <dl className="kv">
                      <dt>표시 가격</dt>
                      <dd className="fw-b">{price.main}</dd>
                      <dt>재고(남은/전체)</dt>
                      <dd>{stockText(p)}</dd>
                      <dt>판매 기간</dt>
                      <dd>
                        {kstText(p.saleStartsAt)} ~ {kstText(p.saleEndsAt)}
                      </dd>
                    </dl>
                    <Link className="btn btn-outline btn-sm" href={routes.product(p.productId)}>
                      고치기
                    </Link>
                  </article>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <p className="t-xs muted">{NOTE}</p>
    </section>
  );
}
