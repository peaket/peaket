'use client';
// SCR-023 [상품 만들기]·[상품 고치기] 실제 API 판(openapi createPartnerProduct·updatePartnerProduct).
// 목업 ProductForm은 ?state= 미리보기에 남긴다.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createProduct, listProductionEvents, listProductions, updateProduct, type PartnerProductCreate, type PartnerProductDetail } from '@/shared/api/partner-live';
import { problemMessage } from '@/shared/api/problem';
import { useAsync } from '@/shared/ui/Async';
import { ADDON_REFUND_RULE, GOODS_REFUND_RULE } from '../../model/products';
import { EMPTY_PRODUCT_FORM, buildProductBody, commaDigits, detailToForm, kstText, type ProductFormValues } from '../../model/product-live';

const TYPES = [
  { value: 'MERCH', label: '공식 MD 굿즈(응원봉·의류·포토카드 등)' },
  { value: 'PARKING', label: '공연장 주차권' },
  { value: 'VIP', label: 'VIP 패키지' },
  { value: 'FAST_LANE', label: '패스트레인' },
];

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-5 lg:gap-x-6';

function Select({ id, value, onChange, children, describedBy }: { id: string; value: string; onChange: (v: string) => void; children: React.ReactNode; describedBy?: string }) {
  return (
    <div className="input-group">
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy}>
        {children}
      </select>
      <i className="ic ic-chevron-down" aria-hidden="true" />
    </div>
  );
}

function ErrorText({ id, children }: { id: string; children?: string }) {
  if (!children) return null;
  return (
    <span className="error-msg" id={id} role="alert">
      <i className="ic ic-alert-circle" aria-hidden="true" />
      {children}
    </span>
  );
}

export function LiveProductForm({ listHref, editing }: { listHref: string; editing?: PartnerProductDetail }) {
  const [v, setV] = useState<ProductFormValues>(() => (editing ? detailToForm(editing) : EMPTY_PRODUCT_FORM));
  const [errors, setErrors] = useState<ReturnType<typeof buildProductBody>['errors']>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const productions = useAsync('productions', (signal) => listProductions(signal));
  const events = useAsync(`events:${v.linkedProductionId}`, (signal) => (v.linkedProductionId ? listProductionEvents(v.linkedProductionId, signal) : Promise.resolve([])));

  useEffect(() => {
    if (!v.ticketLinked || v.linkedEventId || events.status !== 'ready' || events.data.length === 0) return;
    setV((prev) => ({ ...prev, linkedEventId: events.data[0]!.eventId }));
  }, [v.ticketLinked, v.linkedEventId, events.status, events.data]);

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) => setV((prev) => ({ ...prev, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const built = buildProductBody(v);
    setErrors(built.errors);
    if (!built.body) {
      setMessage({ kind: 'error', text: '빈 칸을 채운 뒤 다시 시도해 주세요.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      if (editing) {
        await updateProduct(editing.productId, built.body, editing.version);
      } else {
        if (built.body.status === 'HIDDEN') {
          setMessage({ kind: 'error', text: '새 상품은 숨김으로 저장할 수 없습니다. 초안이나 게시로 저장해 주세요.' });
          return;
        }
        await createProduct(built.body as PartnerProductCreate);
      }
      setMessage({ kind: 'ok', text: editing ? '상품을 고쳤습니다.' : '상품을 저장하고 게시했습니다.' });
    } catch (err) {
      setMessage({ kind: 'error', text: problemMessage(err, '상품을 저장하지 못했습니다.') });
    } finally {
      setSaving(false);
    }
  }

  const delivery = v.fulfillments.includes('DELIVERY');
  const goods = !v.ticketLinked;

  return (
    <form className="card col" style={{ padding: 24, gap: 20 }} onSubmit={submit} aria-labelledby="h-new" noValidate>
      <div className="row between wrap" style={{ gap: 8 }}>
        <h2 className="t-lg" id="h-new">
          {editing ? '상품 고치기' : '새 상품'}
          {editing ? <span className="sr-only"> · {editing.name}</span> : null}
        </h2>
        <span className="t-xs muted">(필수) 칸을 채워야 게시할 수 있습니다</span>
      </div>

      {message ? (
        <div className={message.kind === 'ok' ? 'banner banner-success' : 'banner banner-danger'} role={message.kind === 'ok' ? 'status' : 'alert'}>
          <i className={message.kind === 'ok' ? 'ic ic-check-circle' : 'ic ic-alert-circle'} aria-hidden="true" />
          <div className="banner-body">{message.text}</div>
        </div>
      ) : null}

      <div className={GRID}>
        <div className="field">
          <label className="label" htmlFor="p-type">
            상품 유형 (필수)
          </label>
          <Select
            id="p-type"
            value={v.type}
            describedBy="p-type-h"
            onChange={(type) =>
              setV((prev) => ({
                ...prev,
                type,
                ticketLinked: type !== 'MERCH',
                fulfillments: type === 'MERCH' ? prev.fulfillments : ['PICKUP'],
              }))
            }
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          <span className="hint" id="p-type-h">
            유형을 바꾸면 아래 입력 칸이 바뀝니다
          </span>
          <ErrorText id="p-type-e">{errors.type}</ErrorText>
        </div>
        <div style={{ alignSelf: 'center' }}>
          <div className="banner banner-info" role="status" aria-live="polite">
            <i className={goods ? 'ic ic-bag' : 'ic ic-ticket'} aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">{goods ? '공식 굿즈 입력 칸입니다' : '티켓 연동 부가 상품 입력 칸입니다'}</span>
              {goods ? '로그인한 회원이면 티켓 예매와 관계없이 삽니다.' : '유효 티켓을 가진 분만 마이 티켓에서 삽니다.'}
            </div>
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="p-name">
            상품명 (필수)
          </label>
          <input className="input" id="p-name" type="text" value={v.name} onChange={(e) => set('name', e.target.value)} aria-describedby="p-name-e" />
          <ErrorText id="p-name-e">{errors.name}</ErrorText>
        </div>
        <div className="field">
          <label className="label" htmlFor="p-price">
            가격 (필수)
          </label>
          <div className="input-group">
            <span className="muted fw-b">₩</span>
            <input id="p-price" type="text" inputMode="numeric" value={v.price} onChange={(e) => set('price', commaDigits(e.target.value))} aria-describedby="p-price-e" />
          </div>
          <ErrorText id="p-price-e">{errors.price}</ErrorText>
        </div>

        <div className="field">
          <label className="label" htmlFor="p-stock">
            한정 수량 <span className="opt">(선택)</span>
          </label>
          <div className="input-group">
            <input id="p-stock" type="text" inputMode="numeric" value={v.limitedQty} onChange={(e) => set('limitedQty', commaDigits(e.target.value))} aria-describedby="p-stock-h" />
            <span className="muted">개</span>
          </div>
          <span className="hint" id="p-stock-h">
            비우면 한정하지 않습니다. 결제 직전에 재고를 확정합니다
          </span>
          <ErrorText id="p-stock-e">{errors.limitedQty}</ErrorText>
        </div>

        <fieldset className="col" style={{ gap: 10 }}>
          <legend className="label" style={{ marginBottom: 10 }}>
            수령 방식 (필수)
          </legend>
          {(['DELIVERY', 'PICKUP', 'WALLET'] as const).map((f) => (
            <label key={f} className="check-row">
              <input
                className="cb"
                type="checkbox"
                checked={v.fulfillments.includes(f)}
                disabled={!goods && f === 'DELIVERY'}
                onChange={() => set('fulfillments', v.fulfillments.includes(f) ? v.fulfillments.filter((x) => x !== f) : [...v.fulfillments, f])}
              />
              {f === 'DELIVERY' ? '택배 배송' : f === 'PICKUP' ? '현장 수령(공연 당일)' : '월렛 이용권'}
            </label>
          ))}
          {!goods ? <span className="hint">부가 상품은 실물을 보내지 않습니다. 굿즈는 따로 등록하세요.</span> : null}
          <ErrorText id="p-ful-e">{errors.fulfillments}</ErrorText>
        </fieldset>

        <div className="field">
          <span className="label" id="p-refund-l">
            취소·반품 기준 (PEAKET 공통, 바꿀 수 없음)
          </span>
          <p className="card-flat t-sm" aria-labelledby="p-refund-l" style={{ padding: '10px 12px' }}>
            {goods ? GOODS_REFUND_RULE : ADDON_REFUND_RULE}
          </p>
        </div>

        {v.ticketLinked ? (
          <>
            <div className="field">
              <label className="label" htmlFor="p-production">
                연결 공연 (필수)
              </label>
              <Select
                id="p-production"
                value={v.linkedProductionId}
                onChange={(productionId) => setV((prev) => ({ ...prev, linkedProductionId: productionId, linkedEventId: '' }))}
              >
                <option value="">공연 고르기</option>
                {productions.status === 'ready'
                  ? productions.data.map((p) => (
                      <option key={p.productionId} value={p.productionId}>
                        {p.title}
                      </option>
                    ))
                  : null}
              </Select>
              <ErrorText id="p-production-e">{errors.linkedProductionId}</ErrorText>
            </div>
            <div className="field">
              <label className="label" htmlFor="p-event">
                연결 회차 (필수)
              </label>
              <Select id="p-event" value={v.linkedEventId} onChange={(eventId) => set('linkedEventId', eventId)}>
                <option value="">회차 고르기</option>
                {events.status === 'ready'
                  ? events.data.map((e) => (
                      <option key={e.eventId} value={e.eventId}>
                        {kstText(e.startsAt)}
                      </option>
                    ))
                  : null}
              </Select>
              <ErrorText id="p-event-e">{errors.linkedEventId}</ErrorText>
            </div>
          </>
        ) : null}

        {delivery ? (
          <>
            <div className="field">
              <label className="label" htmlFor="p-ship">
                배송비(편도) (필수)
              </label>
              <div className="input-group">
                <span className="muted fw-b">₩</span>
                <input id="p-ship" type="text" inputMode="numeric" value={v.shippingFee} onChange={(e) => set('shippingFee', commaDigits(e.target.value))} />
              </div>
              <ErrorText id="p-ship-e">{errors.shippingFee}</ErrorText>
            </div>
            <div className="field">
              <label className="label" htmlFor="p-rship">
                단순 변심 반품 배송비(편도) (필수)
              </label>
              <div className="input-group">
                <span className="muted fw-b">₩</span>
                <input id="p-rship" type="text" inputMode="numeric" value={v.returnShippingFee} onChange={(e) => set('returnShippingFee', commaDigits(e.target.value))} />
              </div>
              <ErrorText id="p-rship-e">{errors.returnShippingFee}</ErrorText>
            </div>
            <div className="field col-span-2">
              <label className="label" htmlFor="p-raddr">
                반품 받을 주소 (필수)
              </label>
              <input className="input" id="p-raddr" type="text" value={v.returnAddress} onChange={(e) => set('returnAddress', e.target.value)} />
              <ErrorText id="p-raddr-e">{errors.returnAddress}</ErrorText>
            </div>
          </>
        ) : null}

        <div className="field col-span-2">
          <label className="label" htmlFor="p-opt">
            옵션 <span className="opt">(선택)</span>
          </label>
          <input className="input" id="p-opt" type="text" value={v.options} onChange={(e) => set('options', e.target.value)} aria-describedby="p-opt-h" />
          <span className="hint" id="p-opt-h">
            옵션 이름 뒤에 값을 쉼표로 나눠 적습니다(예: 색상: 인디고, 화이트)
          </span>
        </div>
        <div className="field col-span-2">
          <label className="label" htmlFor="p-desc">
            상품 설명 <span className="opt">(선택)</span>
          </label>
          <textarea className="textarea" id="p-desc" style={{ minHeight: 96 }} value={v.description} onChange={(e) => set('description', e.target.value)} />
        </div>

        <div className="col" style={{ gap: 8 }}>
          <span className="label">판매·양도 조건</span>
          <label className="check-row" style={{ alignItems: 'center' }}>
            <input className="sw" type="checkbox" role="switch" checked={v.transferable} onChange={(e) => set('transferable', e.target.checked)} aria-describedby="p-transfer-h" />
            티켓과 함께 양도 허용
          </label>
          <span className="hint" id="p-transfer-h">
            VIP 패키지는 양도 불가가 기본입니다
          </span>
        </div>
        <div className="field">
          <label className="label" htmlFor="p-status">
            저장 상태
          </label>
          <Select id="p-status" value={v.status} onChange={(status) => set('status', status as 'DRAFT' | 'PUBLISHED' | 'HIDDEN')}>
            <option value="PUBLISHED">게시</option>
            <option value="DRAFT">초안으로 저장</option>
            {editing ? <option value="HIDDEN">숨김</option> : null}
          </Select>
        </div>
      </div>

      <div className="row between wrap" style={{ gap: 12, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <p className="t-sm muted grow">{goods ? '게시하면 굿즈 스토어에 바로 보입니다.' : '게시하면 굿즈 스토어와 마이 티켓의 연동 부가 상품에 바로 보입니다.'}</p>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn btn-ghost" href={listHref}>
            목록으로
          </Link>
          <button className="btn btn-primary" type="submit" aria-busy={saving} aria-disabled={saving}>
            {saving ? <span className="spinner" aria-hidden="true" /> : null}
            {saving ? '저장하는 중' : editing ? '고치기 저장' : '스토어에 게시하기'}
          </button>
        </div>
      </div>
    </form>
  );
}
