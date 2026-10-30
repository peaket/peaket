'use client';
// 굿즈 주문서의 묶음들(보드 SCR-015 isCart/isOrder): 판매자·수령 방식별 묶음마다 상품 줄 · 합계 · 결제 버튼(한 결제 = 한 판매자·한 수령 방식).
// 택배 묶음: 배송지(CMP-067 자리, 보드 마크업) · 판매자에게 배송 정보 제공 동의(필수, 없으면 결제 버튼 비활성) · 결제대금예치 한 줄.
// 두 묶음 모두: 결제 창 자리(CMP-027 toss, 근사) → 상품용 중개자 고지(POL-037) → 미성년자 계약 취소 고지(POL-032) → [[ ₩n 결제하기 ]].
// 데스크톱(lg)은 묶음 카드 안을 7:5 두 칸(왼쪽 상품·배송지·동의 / 오른쪽 합계·결제)으로 나눈다.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Button } from '@peaket/ds/Button';
import { ConsentCheckbox } from '@peaket/ds/ConsentCheckbox';
import { groupSubtotal, groupTotal, lineMeta, useShopToast, won, type CartGroup, type ShopToastKind } from '@/entities/cart';
import { productBrokerNotice } from '@/entities/product';

export interface CheckoutGroupsProps {
  groups: readonly CartGroup[];
  /** 배송 받는 분 기본값(로그인한 팬의 표시 이름) */
  recipientName: string;
  /** 상태 '배송 정보 동의 없음'이면 거짓 */
  initialShipConsent?: boolean;
  initialToast?: { kind: ShopToastKind } | null;
}

/** 묶음 안 작은 제목(휴대폰 18px · 태블릿부터 16px, 보드 m의 .section-title h2 / t·d의 h3.t-md) */
const H3 = 'text-[18px] leading-6 font-bold md:text-base md:leading-[22px]';
const SPLIT = 'col gap-5 lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-8';

export function CheckoutGroups({ groups: initial, recipientName, initialShipConsent = true, initialToast = null }: CheckoutGroupsProps) {
  const [groups, setGroups] = useState<CartGroup[]>(() => initial.map((g) => ({ ...g, lines: [...g.lines] })));
  const [consent, setConsent] = useState(initialShipConsent);
  const [toastNode, showToast] = useShopToast(initialToast);
  const live = groups.filter((g) => g.lines.length > 0);
  const lineCount = live.reduce((n, g) => n + g.lines.length, 0);
  const remove = (lineId: string) => setGroups((gs) => gs.map((g) => ({ ...g, lines: g.lines.filter((l) => l.id !== lineId) })));

  return (
    <>
      <div className="col" style={{ gap: 4 }}>
        <h2 className="text-[18px] leading-6 font-bold lg:text-xl lg:leading-[27px]" id="h-cart">
          담은 상품 {lineCount}개
        </h2>
        <p className="hint">판매자·수령 방식별로 따로 결제합니다</p>
      </div>

      {live.map((g) => {
        const hId = `h-grp-${g.kind}`;
        const total = won(groupTotal(g));
        const lines = (
          <ul className="col">
            {g.lines.map((l) => (
              <li key={l.id} className="li" style={{ alignItems: 'flex-start' }}>
                <span className="card-flat center muted size-14 flex-none lg:size-16" aria-hidden="true">
                  <i className={`ic ic-${l.icon} ic-24`} />
                </span>
                <span className="col grow" style={{ gap: 2 }}>
                  <span className="t-sm fw-b">{l.title}</span>
                  <span className="li-sub">{lineMeta(l, true)}</span>
                  <span className="t-sm fw-b num">{won(l.unitPrice * l.quantity)}</span>
                </span>
                <button className="icon-btn icon-btn-sm" type="button" aria-label={`${l.title} 장바구니에서 빼기`} onClick={() => remove(l.id)}>
                  <i className="ic ic-close" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        );
        const totals = (
          <dl className="kv" aria-label={`${g.title} 합계`}>
            <dt>상품 금액</dt>
            <dd>{won(groupSubtotal(g))}</dd>
            {g.kind === 'ship' ? (
              <>
                <dt>배송비</dt>
                <dd>{won(g.shippingFee ?? 0)}</dd>
              </>
            ) : null}
            <dt className="kv-total">결제 예정 금액</dt>
            <dd className="kv-total">{total}</dd>
          </dl>
        );
        const frame = (
          <div className="card col center" style={{ gap: 8, padding: '28px 16px' }} role="region" aria-label={g.kind === 'ship' ? '토스페이먼츠 결제 창 자리' : '토스페이먼츠 결제 창 자리(현장 수령 묶음)'}>
            <i className="ic ic-won ic-24 muted" aria-hidden="true" />
            <p className="t-sm muted">토스페이먼츠 결제 창이 이 자리에 열립니다</p>
          </div>
        );
        const notices = <SellerNotices sellerName={g.sellerName} />;
        const payBlocked = g.kind === 'ship' && !consent;
        const pay = (
          <Button
            size="lg"
            block
            disabledReason={payBlocked ? '판매자에게 배송 정보 제공에 동의하면 결제할 수 있습니다' : undefined}
            onClick={() => showToast('ordered')}
          >
            {total} 결제하기
          </Button>
        );

        return (
          <section key={g.id} className="card col gap-5 p-4 md:px-6 md:py-5 lg:px-7 lg:py-6" aria-labelledby={hId}>
            <div className="col" style={{ gap: 2 }}>
              <h2 className="t-md fw-b lg:text-xl lg:leading-[27px]" id={hId}>
                {g.title}
              </h2>
              {g.showSeller ? <span className="t-sm muted">판매자 {g.sellerName}</span> : null}
            </div>
            {g.kind === 'ship' ? (
              <div className={SPLIT}>
                <div className="col gap-5 lg:gap-6">
                  {lines}
                  <div className="lg:hidden">{totals}</div>
                  <AddressSection recipientName={recipientName} count={g.lines.reduce((n, l) => n + l.quantity, 0)} />
                  <ShipConsent checked={consent} onChange={setConsent} sellerName={g.sellerName} />
                </div>
                <div className="col gap-5">
                  <div className="hidden lg:block">{totals}</div>
                  <section className="col" style={{ gap: 10 }} aria-labelledby="h-pay">
                    <h3 className={H3} id="h-pay">
                      결제
                    </h3>
                    <p className="t-sm">
                      신용카드가 아닌 결제(체크카드·계좌이체·가상계좌)는 결제대금예치(에스크로)를 고를 수 있습니다. 고르면 상품을 받고 구매를 확정할 때까지 토스페이먼츠가 대금을
                      보관합니다.
                    </p>
                    {frame}
                  </section>
                  <section className="col" style={{ gap: 8 }} aria-labelledby="h-seller-c">
                    <h3 className={H3} id="h-seller-c">
                      판매자와 중개자 고지
                    </h3>
                    {notices}
                  </section>
                  {pay}
                </div>
              </div>
            ) : (
              <div className={SPLIT}>
                {lines}
                <div className="col gap-5">
                  {totals}
                  {frame}
                  {notices}
                  {pay}
                </div>
              </div>
            )}
          </section>
        );
      })}
      {toastNode}
    </>
  );
}

function SellerNotices({ sellerName }: { sellerName: string }) {
  return (
    <>
      <div className="banner banner-legal">
        <i className="ic ic-scale" aria-hidden="true" />
        <div className="banner-body">
          <span className="legal-tag">법정 고지</span>
          {productBrokerNotice(sellerName)}
        </div>
      </div>
      <p className="t-md">
        만 19세 미만 미성년자가 법정대리인(부모 등)의 동의 없이 결제하면, 미성년자 본인이나 법정대리인이 이 계약을 취소할 수 있습니다.{' '}
        <Link className="link-more" href="/help">
          미성년자 계약 취소 안내
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      </p>
    </>
  );
}

function AddressSection({ recipientName, count }: { recipientName: string; count: number }) {
  return (
    <section className="col" style={{ gap: 14 }} aria-labelledby="h-addr">
      <div className="col" style={{ gap: 4 }}>
        <h3 className={H3} id="h-addr">
          배송지
        </h3>
        <p className="hint">택배 배송 상품 {count}개를 보낼 곳입니다</p>
      </div>
      <div className="col gap-3.5 md:grid md:grid-cols-2">
        <div className="field">
          <label className="label" htmlFor="ad-name">
            받는 분 <span className="opt">(필수)</span>
          </label>
          <input className="input" id="ad-name" type="text" autoComplete="name" defaultValue={recipientName} />
        </div>
        <div className="field">
          <label className="label" htmlFor="ad-tel">
            연락처 <span className="opt">(필수)</span>
          </label>
          <input className="input" id="ad-tel" type="tel" inputMode="tel" autoComplete="tel" placeholder="010-0000-0000" />
        </div>
      </div>
      <div className="field">
        <span className="label" id="ad-addr-l">
          주소 <span className="opt">(필수)</span>
        </span>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input w-[136px] min-w-0 shrink lg:w-40"
            id="ad-zip"
            type="text"
            autoComplete="postal-code"
            readOnly
            defaultValue="01234"
            aria-labelledby="ad-addr-l ad-zip-l"
          />
          <span className="sr-only" id="ad-zip-l">
            우편번호
          </span>
          <button className="btn btn-outline" type="button" style={{ height: 48 }} aria-haspopup="listbox">
            <i className="ic ic-search" aria-hidden="true" />
            주소 찾기
          </button>
        </div>
        <input className="input" id="ad-street" type="text" autoComplete="street-address" readOnly defaultValue="서울특별시 가상구 예시로 10 (가상 주소)" aria-label="도로명 주소" />
      </div>
      <div className="field">
        <label className="label" htmlFor="ad-detail">
          상세 주소 <span className="opt">(필수)</span>
        </label>
        <input className="input" id="ad-detail" type="text" defaultValue="101동 1001호" />
      </div>
      <ConsentCheckbox id="ad-save" label="기본 배송지로 저장" requirement="optional" />
    </section>
  );
}

const CONSENT_ROWS = (sellerName: string): { dt: string; dd: ReactNode; strong?: boolean }[] => [
  { dt: '받는 자', dd: `${sellerName}(이 상품의 판매자)`, strong: true },
  { dt: '목적', dd: '상품 배송과 반품·교환 처리. 광고·홍보에는 쓰지 않습니다', strong: true },
  { dt: '항목', dd: '받는 분 이름·연락처·배송 주소, 주문번호, 주문 상품·수량' },
  { dt: '보유 기간', dd: '배송 완료 후 3개월까지(설명과 다른 상품의 반품 기간)', strong: true },
  { dt: '거부권과 불이익', dd: '동의를 거부할 수 있습니다. 판매자가 직접 배송하므로 동의하지 않으면 택배로 받을 수 없습니다. 현장 수령은 동의 없이 고를 수 있습니다' },
];

/** 판매자에게 배송 정보 제공 동의(개인정보 보호법 §17, 택배 묶음만, ADR-0062). 받는 자·목적·보유 기간은 굵게 */
function ShipConsent({ checked, onChange, sellerName }: { checked: boolean; onChange: (v: boolean) => void; sellerName: string }) {
  return (
    <section className="card-flat col px-4 py-3.5 lg:px-[18px] lg:py-4" style={{ gap: 12 }} aria-labelledby="h-ship-3p">
      <h3 className="t-md fw-b" id="h-ship-3p">
        판매자에게 배송 정보 제공
      </h3>
      <dl className="col" style={{ gap: 8 }}>
        {CONSENT_ROWS(sellerName).map((r) => (
          <div key={r.dt} className="col" style={{ gap: 2 }}>
            <dt className="t-xs fw-b muted">{r.dt}</dt>
            <dd className={r.strong ? 't-sm fw-b' : 't-sm'}>{r.dd}</dd>
          </div>
        ))}
      </dl>
      <ConsentCheckbox id="ship-agree" label="위 내용에 동의합니다" requirement="required" checked={checked} onCheckedChange={onChange} />
    </section>
  );
}
