// SCR-055 상세의 공통 조각(예매 확인서·주문 확인서·주문 상세가 함께 쓴다). 보드 SCR-055 상세 마크업 그대로.
// 판매자 고지(CMP-058 receipt)는 POL-037 원문이고, 글씨는 판매자 정보 칸과 같은 크기(14px)다.
import Link from 'next/link';
import type { HistoryBadge } from '@/entities/account';
import type { Seller } from '@/entities/seller';
import { badgeClass } from '@/widgets/order-history';
import { CopyIconButton } from './CopyButton';

/** 제목: 휴대폰·태블릿은 화면 제목(t-xl), 데스크톱은 오른쪽 패널 제목 크기(t-lg) */
export const DETAIL_H1 = 't-xl lg:text-[20px] lg:leading-[27px]';
export const DETAIL_TITLE_ID = 'od-title';
export const MORE = <i className="ic ic-chevron-right" aria-hidden="true" />;

const MINOR_NOTICE = '만 19세 미만 미성년자가 법정대리인(부모 등)의 동의 없이 결제하면, 미성년자 본인이나 법정대리인이 이 계약을 취소할 수 있습니다.';

const BROKER = {
  ticket: (s: string) =>
    `판매자: ${s}. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고, 예매 취소와 환불은 PEAKET이 처리합니다`,
  goods: (s: string) =>
    `판매자: ${s}. PEAKET은 통신판매중개자로서 이 상품 거래의 당사자가 아닙니다. 상품의 제공(배송·이용)과 품질에 따른 책임은 판매자에게 있고, 주문 취소·반품과 환불은 PEAKET이 처리합니다`,
};

/** 휴대폰·태블릿의 '← 예매·주문 내역'(데스크톱은 왼쪽에 표가 있어 숨긴다) */
export function BackLink() {
  return (
    <Link className="btn btn-ghost btn-sm lg:hidden" href="/my/orders" style={{ alignSelf: 'flex-start', marginLeft: -8 }}>
      <i className="ic ic-arrow-left" aria-hidden="true" />
      예매·주문 내역
    </Link>
  );
}

export function DetailHead({ title, badges, top = false }: { title: string; badges: readonly HistoryBadge[]; top?: boolean }) {
  return (
    <div className="row between" style={{ gap: 8, alignItems: top ? 'flex-start' : undefined }}>
      <h1 className={DETAIL_H1} id={DETAIL_TITLE_ID}>
        {title}
      </h1>
      {badges.length === 1 ? (
        <span className={badgeClass(badges[0]!.tone, true)}>{badges[0]!.text}</span>
      ) : (
        <span className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
          {badges.map((b) => (
            <span key={b.text} className={badgeClass(b.tone, true)}>
              {b.text}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** 예매번호·주문번호 카드와 복사 버튼(이름에 번호를 넣는다) */
export function NumberCard({ label, number }: { label: '예매번호' | '주문번호'; number: string }) {
  return (
    <div className="card-flat row" style={{ padding: '12px 8px 12px 16px', gap: 8 }}>
      <div className="col grow" style={{ gap: 2 }}>
        <span className="t-xs muted">{label}</span>
        <span className="mono t-lg">{number}</span>
      </div>
      <CopyIconButton text={number} label={`${label} ${number} 복사`} done={`${label}를 복사했습니다`} />
    </div>
  );
}

export function LegalBanner({ kind, sellerName }: { kind: 'ticket' | 'goods'; sellerName: string }) {
  return (
    <div className="banner banner-legal">
      <i className="ic ic-scale" aria-hidden="true" />
      <div className="banner-body">
        <span className="legal-tag">법정 고지</span>
        {BROKER[kind](sellerName)}
      </div>
    </div>
  );
}

/** 판매자 신원정보 7항목. 태블릿은 두 칸씩 카드 안(보드 SCR-055-t), 휴대폰·데스크톱은 한 칸씩 */
const SELLER_KV =
  'kv md:max-lg:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] md:max-lg:rounded-(--r-xl) md:max-lg:border md:max-lg:border-(--border) md:max-lg:bg-(--surface) md:max-lg:px-[18px] md:max-lg:py-4';

export function SellerSection({ kind, seller }: { kind: 'ticket' | 'goods'; seller: Seller }) {
  return (
    <section className="col" style={{ gap: 10 }} aria-labelledby="h-seller">
      <h2 id="h-seller" className="t-md fw-b">
        판매자 정보
      </h2>
      <LegalBanner kind={kind} sellerName={seller.name} />
      <dl className={SELLER_KV}>
        <dt>상호</dt>
        <dd>{seller.name}</dd>
        <dt>대표자</dt>
        <dd>{seller.representative}</dd>
        <dt>주소</dt>
        <dd>{seller.address}</dd>
        <dt>전화</dt>
        <dd>{seller.phone}</dd>
        <dt>전자우편</dt>
        <dd>{seller.email}</dd>
        <dt>사업자등록번호</dt>
        <dd>{seller.businessNo}</dd>
        <dt>통신판매업 신고번호</dt>
        <dd>{seller.mailOrderNo}</dd>
      </dl>
    </section>
  );
}

/** 미성년자 계약 취소 고지 한 줄(§5.11 ⑨와 같은 문장) */
export function MinorNotice() {
  return (
    <p className="t-sm">
      {MINOR_NOTICE}{' '}
      <Link className="link-more" href="/help">
        미성년자 계약 취소 안내
        {MORE}
      </Link>
    </p>
  );
}

export function InquiryLink() {
  return (
    <Link className="link-more" href="/help/inquiries/new" style={{ alignSelf: 'flex-start' }}>
      이 주문으로 문의하기
      {MORE}
    </Link>
  );
}
