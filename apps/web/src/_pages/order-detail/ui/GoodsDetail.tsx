// SCR-055 굿즈·부가 상품 주문 확인서(보드 '굿즈 주문 상세'·'굿즈 주문 취소 확인'·'반품 요청'). 결제대금예치 주문은 배지와 구매 확정 안내를 보인다(POL-014).
// 취소·반품 버튼은 상태로 고른다(POL-016 §1.4). 현장 수령 교환권 QR은 보드에 없어 그리지 않았다(수령 장소·시간대만).
import { ME } from '@/entities/me';
import type { GoodsHistory } from '@/entities/account';
import { getPerformance } from '@/entities/performance';
import { formatWon } from '@/entities/production';
import { getSeller } from '@/entities/seller';
import type { GoodsAction } from '../model/view';
import { BackLink, DetailHead, InquiryLink, MinorNotice, MORE, NumberCard, SellerSection } from './DetailParts';
import { OrderCancel, ReturnRequest } from './GoodsDialogs';

/** 택배사 배송 조회 창 자리(데이터 연결 단계에서 송장 번호로 잇는다). 예시 도메인이다 */
const TRACKING_URL = 'https://tracking.example.com/';

export interface GoodsDetailProps {
  g: GoodsHistory;
  action: GoodsAction;
  cancelReason: string;
  dialog: GoodsAction;
}

export function GoodsDetail({ g, action, cancelReason, dialog }: GoodsDetailProps) {
  const seller = getSeller(g.sellerId);
  if (!seller) return null;
  const round = g.performanceId ? getPerformance(g.performanceId)?.label : g.roundText;
  const qty = `${g.quantity}${g.kind === 'addon' ? '매' : '개'}`;
  const sub = [round, g.option, qty, g.delivery, `판매자 ${seller.name}`].filter(Boolean).join(' · ');
  const itemLine = `${g.itemTitle} · ${qty} · 주문번호 ${g.number}`;
  const shipped = g.link === 'tracking';

  return (
    <>
      <BackLink />
      <DetailHead title="주문 확인서" badges={g.badges} top />
      <NumberCard label="주문번호" number={g.number} />
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <span className="card-flat center muted h-[52px] w-[52px] flex-none md:h-14 md:w-14 lg:h-[52px] lg:w-[52px]" aria-hidden="true">
          <i className="ic ic-box ic-24" />
        </span>
        <div className="col grow" style={{ gap: 4 }}>
          <h2 className="t-md fw-b">{g.itemTitle}</h2>
          <p className="t-sm muted">{sub}</p>
        </div>
      </div>
      <dl className="kv">
        <dt>결제 수단</dt>
        <dd>{g.methodText}</dd>
        <dt>결제 금액</dt>
        <dd className="kv-total">{formatWon(g.amount)}</dd>
      </dl>

      {g.shipping ? (
        <section id="ship" className="col scroll-mt-24" style={{ gap: 10 }} aria-labelledby="h-gship">
          <h2 id="h-gship" className="t-md fw-b">
            배송
          </h2>
          <dl className="kv">
            <dt>받는 분</dt>
            <dd>
              {ME.name} · 010-****-{g.shipping.phoneLast4}
            </dd>
            <dt>배송지</dt>
            <dd>{g.shipping.address}</dd>
          </dl>
          {shipped ? (
            <a className="link-more" href={TRACKING_URL} target="_blank" rel="noopener noreferrer" style={{ alignSelf: 'flex-start' }}>
              배송 조회
              <span className="sr-only">(새 창)</span>
              {MORE}
            </a>
          ) : null}
        </section>
      ) : null}

      {g.pickup ? (
        <section id="pickup" className="col scroll-mt-24" style={{ gap: 10 }} aria-labelledby="h-gpick">
          <h2 id="h-gpick" className="t-md fw-b">
            현장 수령
          </h2>
          <dl className="kv">
            <dt>수령 장소</dt>
            <dd>{g.pickup.place}</dd>
            <dt>수령 시간대</dt>
            <dd>{g.pickup.slot}</dd>
          </dl>
        </section>
      ) : null}

      {g.escrow ? (
        <div className="banner banner-info">
          <i className="ic ic-shield" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">결제대금예치</span>
            상품을 받으면 토스페이먼츠가 보내는 이메일에서 구매를 확정해 주세요. 3영업일 동안 고르지 않으면 자동으로 확정됩니다. 일부 상품만 반품하려면 구매를
            확정한 뒤 요청해 주세요.
          </div>
        </div>
      ) : null}

      <section className="col" style={{ gap: 10 }} aria-labelledby="h-gret">
        <h2 id="h-gret" className="t-md fw-b">
          취소·반품
        </h2>
        {action === 'return' && g.returnInfo ? (
          <div className="col" style={{ gap: 10 }}>
            <p className="t-sm" id="g-due">
              {g.returnInfo.dueText}
            </p>
            <ReturnRequest
              defaultOpen={dialog === 'return'}
              itemLine={itemLine}
              price={g.amount}
              fee={g.returnInfo.fee}
              returnTo={`${seller.name} · ${seller.address}`}
              dueId="g-due"
            />
          </div>
        ) : null}
        {action === 'cancel' ? <OrderCancel defaultOpen={dialog === 'cancel'} itemLine={itemLine} price={g.amount} reason={cancelReason} /> : null}
        <MinorNotice />
      </section>

      <SellerSection kind="goods" seller={seller} />
      <InquiryLink />
    </>
  );
}
