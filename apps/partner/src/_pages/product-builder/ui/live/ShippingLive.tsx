'use client';
// SCR-023 [배송·반품 처리] 실제 API 판(openapi listPartnerMerchOrderItems·shipment·arrival-*·merch-delivery-exports).
// 받는 분은 가린 값만 보이고, 주소 원문은 주문별 보기 API에서만 받는다. 배송 명단 내려받기는 관리자·재인증이다.
import { useState } from 'react';
import {
  confirmArrival,
  createDeliveryExport,
  listMerchOrderItems,
  putShipment,
  rejectArrival,
  type MerchOrderItem,
} from '@/shared/api/partner-live';
import { problemMessage } from '@/shared/api/problem';
import { requestBookerExportReauth } from '@/shared/api/reauth';
import { EmptyCard, ErrorCard, LoadingCard, useAsync } from '@/shared/ui/Async';
import { Modal } from '@/shared/ui/Modal';
import {
  CARRIERS,
  SHIP_STATUS_BADGE,
  SHIP_STATUS_LABEL,
  RETURN_REASON_LABEL,
  canConfirmReturn,
  canRegisterInvoice,
  canRejectReturn,
  carrierLabel,
  checkExportReason,
  checkInvoice,
  checkRejection,
  itemText,
  recipientText,
} from '../../model/shipping-live';
import { reauthErrorView } from '../../../settlement/model/roster-live';

const STATUS_FILTERS = [
  { value: '', label: '전체 상태' },
  { value: 'READY', label: '배송 준비' },
  { value: 'SHIPPED', label: '배송 중' },
  { value: 'DELIVERED', label: '배송 완료' },
  { value: 'RETURN_REQUESTED', label: '반품 요청' },
  { value: 'RETURN_RECEIVED', label: '반품 도착 확인' },
  { value: 'DISPUTED', label: '반품 확인 중(분쟁)' },
] as const;

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

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

function StatusCell({ o }: { o: MerchOrderItem }) {
  return (
    <div className="row wrap" style={{ gap: 4 }}>
      <span className={SHIP_STATUS_BADGE[o.status]}>{SHIP_STATUS_LABEL[o.status]}</span>
      {o.escrow ? <span className="badge badge-outline">결제대금예치</span> : null}
    </div>
  );
}

export function LiveShippingSection({ isMember }: { isMember: boolean }) {
  const [status, setStatus] = useState('');
  const [fulfillment, setFulfillment] = useState('');
  const page = useAsync(`ship:${status}|${fulfillment}`, (signal) =>
    listMerchOrderItems({ ...(status ? { status: [status] } : {}), ...(fulfillment ? { fulfillment: fulfillment as 'DELIVERY' | 'PICKUP' } : {}), limit: 100 }, signal),
  );
  const items = page.status === 'ready' ? page.data.items : [];
  const invoiceItems = items.filter(canRegisterInvoice);
  const [invoiceItemId, setInvoiceItemId] = useState('');
  const [carrier, setCarrier] = useState('CJ');
  const [trackingNo, setTrackingNo] = useState('');
  const [invoiceErrors, setInvoiceErrors] = useState<{ carrier?: string; trackingNo?: string }>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [exportReason, setExportReason] = useState('10/15(목) 발송분 송장 출력');
  const [exportFormat, setExportFormat] = useState<'CSV' | 'XLSX' | 'PDF'>('CSV');
  const [exportPassword, setExportPassword] = useState('');
  const [exportCode, setExportCode] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);

  const [rejectItem, setRejectItem] = useState<MerchOrderItem | null>(null);
  const [rejectReason, setRejectReason] = useState('DAMAGED_BY_BUYER');
  const [rejectEvidence, setRejectEvidence] = useState('');
  const [rejectErrors, setRejectErrors] = useState<{ reasonCode?: string; evidence?: string }>({});

  const selectedInvoice = invoiceItems.find((i) => i.itemId === invoiceItemId) ?? invoiceItems[0];

  async function registerInvoice() {
    if (!selectedInvoice) return;
    const check = checkInvoice(carrier, trackingNo);
    setInvoiceErrors(check.errors);
    if (!check.ok) return;
    setBusy(selectedInvoice.itemId);
    setMessage(null);
    try {
      await putShipment(selectedInvoice.itemId, { carrier, trackingNo }, selectedInvoice.version);
      setTrackingNo('');
      setMessage({ kind: 'ok', text: '송장을 등록했습니다.' });
      page.reload();
    } catch (e) {
      setMessage({ kind: 'error', text: problemMessage(e, '송장을 등록하지 못했습니다.') });
    } finally {
      setBusy(null);
    }
  }

  async function doConfirm(item: MerchOrderItem) {
    setBusy(item.itemId);
    setMessage(null);
    try {
      await confirmArrival(item.itemId);
      setMessage({ kind: 'ok', text: '반품 도착을 확인했습니다. PEAKET이 3영업일 안에 환급합니다.' });
      page.reload();
    } catch (e) {
      setMessage({ kind: 'error', text: problemMessage(e, '반품 도착을 확인하지 못했습니다.') });
    } finally {
      setBusy(null);
    }
  }

  async function doReject() {
    if (!rejectItem) return;
    const check = checkRejection(rejectReason, rejectEvidence);
    setRejectErrors(check.errors);
    if (!check.ok) return;
    setBusy(rejectItem.itemId);
    setMessage(null);
    try {
      await rejectArrival(rejectItem.itemId, { reasonCode: rejectReason as 'DAMAGED_BY_BUYER' | 'VALUE_LOST_BY_USE', evidence: rejectEvidence.trim() });
      setRejectItem(null);
      setRejectEvidence('');
      setMessage({ kind: 'ok', text: '반품을 거절하고 CS 처리함 분쟁 접수로 넘겼습니다.' });
      page.reload();
    } catch (e) {
      setMessage({ kind: 'error', text: problemMessage(e, '반품을 거절하지 못했습니다.') });
    } finally {
      setBusy(null);
    }
  }

  async function doExport() {
    const reasonError = checkExportReason(exportReason);
    if (reasonError) {
      setExportError(reasonError);
      return;
    }
    if (!exportPassword || !/^[0-9]{3} ?[0-9]{3}$/.test(exportCode.trim())) {
      setExportError('비밀번호와 인증 앱 6자리 코드를 적어 주세요.');
      return;
    }
    setBusy('export');
    setExportError(null);
    try {
      const token = await requestBookerExportReauth({ password: exportPassword, code: exportCode.trim() });
      const file = await createDeliveryExport(token, { reason: exportReason.trim(), format: exportFormat, status: ['READY', 'SHIPPED', 'DELIVERED', 'RETURN_REQUESTED'] });
      saveBlob(file.blob, file.filename);
      setExportOpen(false);
      setExportPassword('');
      setExportCode('');
      setMessage({ kind: 'ok', text: '배송 명단을 내려받았습니다. 사유와 건수는 접속기록에 남았습니다.' });
    } catch (e) {
      setExportError(reauthErrorView(e).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="col" style={{ gap: 16 }} aria-labelledby="h-ship">
      <div className="section-title">
        <h2 id="h-ship">배송·반품 처리</h2>
        <span className="t-xs muted md:text-[14px]">실제 주문 항목</span>
      </div>
      <div className="banner banner-info" role="note">
        <i className="ic ic-shield" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">주문서에서 받은 제3자 제공 동의 범위의 항목만 가려서 보입니다</span>
          받는 분 이름·연락처, 주문번호, 주문 상품·수량만 보이고, 배송 완료 후 3개월까지 봅니다. 주소 원문은 주문별 보기에서만 받습니다.
        </div>
      </div>
      {isMember ? (
        <div className="banner banner-warning" role="note">
          <i className="ic ic-lock" aria-hidden="true" />
          <div className="banner-body">배송 명단 내려받기만 파트너 관리자만 할 수 있습니다. 송장 등록·반품 확인·거절은 실무자도 합니다</div>
        </div>
      ) : null}
      {message ? (
        <div className={message.kind === 'ok' ? 'banner banner-success' : 'banner banner-danger'} role={message.kind === 'ok' ? 'status' : 'alert'}>
          <i className={message.kind === 'ok' ? 'ic ic-check-circle' : 'ic ic-alert-circle'} aria-hidden="true" />
          <div className="banner-body">{message.text}</div>
        </div>
      ) : null}

      <div className="toolbar between max-lg:flex-col max-lg:items-stretch" style={{ alignItems: 'flex-end', gap: 12 }}>
        <div className="row max-lg:grid max-lg:grid-cols-3 max-md:grid-cols-1" style={{ gap: 12, alignItems: 'flex-end' }}>
          <SelectField id="s-status" label="상태" value={status} onChange={setStatus} options={STATUS_FILTERS} />
          <SelectField
            id="s-fulfillment"
            label="수령 방식"
            value={fulfillment}
            onChange={setFulfillment}
            options={[
              { value: '', label: '전체 수령 방식' },
              { value: 'DELIVERY', label: '택배' },
              { value: 'PICKUP', label: '현장 수령' },
              { value: 'WALLET', label: '월렛' },
            ]}
          />
        </div>
        {!isMember ? (
          <div className="flex flex-col items-end gap-1 max-md:hidden">
            <button className="btn btn-outline" type="button" onClick={() => setExportOpen(true)} aria-describedby="s-dl-h">
              <i className="ic ic-download" aria-hidden="true" />
              배송 명단 내려받기
            </button>
            <span className="t-xs muted" id="s-dl-h">
              파트너 관리자 · 사유와 재인증이 필요합니다
            </span>
          </div>
        ) : null}
      </div>

      {page.status === 'loading' ? <LoadingCard label="배송·반품 목록을 불러오는 중입니다" /> : null}
      {page.status === 'error' ? <ErrorCard error={page.error} onRetry={page.reload} fallback="배송·반품 목록을 불러오지 못했습니다" /> : null}
      {page.status === 'ready' && items.length === 0 ? <EmptyCard title="지금 처리할 주문 항목이 없습니다" /> : null}

      {items.length > 0 ? (
        <>
          <div className="table-wrap table-scroll max-md:hidden" role="region" aria-label="택배 주문 표" tabIndex={0}>
            <table className="table dense" style={{ minWidth: 900 }}>
              <caption className="sr-only">배송·반품 주문 항목, 동의 범위 항목만 가려서 표시</caption>
              <thead>
                <tr>
                  <th scope="col">주문번호 · 주문 상품·수량</th>
                  <th scope="col">받는 분 · 연락처</th>
                  <th scope="col">상태</th>
                  <th scope="col">송장</th>
                  <th scope="col">
                    <span className="sr-only">처리</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.itemId}>
                    <td>
                      <div className="col" style={{ gap: 2 }}>
                        <span className="mono">{o.orderId.slice(0, 8)}…</span>
                        <span className="t-xs muted">{itemText(o)}</span>
                      </div>
                    </td>
                    <td>
                      <span className={o.recipient ? undefined : 'muted'}>{recipientText(o)}</span>
                    </td>
                    <td>
                      <StatusCell o={o} />
                      {o.returnReason ? <span className="t-xs muted">{RETURN_REASON_LABEL[o.returnReason]}</span> : null}
                    </td>
                    <td>
                      {o.trackingNo ? (
                        <div className="col" style={{ gap: 2 }}>
                          <span className="mono t-xs">
                            {carrierLabel(o.trackingCarrier)} {o.trackingNo}
                          </span>
                          {o.returnTrackingNo ? <span className="t-xs muted">반품 송장 {o.returnTrackingNo}</span> : null}
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {canRegisterInvoice(o) ? (
                        <button className="btn btn-outline btn-sm" type="button" onClick={() => setInvoiceItemId(o.itemId)}>
                          송장 등록
                        </button>
                      ) : null}
                      {canConfirmReturn(o) ? (
                        <button className="btn btn-primary btn-sm" type="button" disabled={busy === o.itemId} onClick={() => void doConfirm(o)}>
                          반품 도착 확인
                        </button>
                      ) : null}
                      {canRejectReturn(o) ? (
                        <button className="btn btn-danger-outline btn-sm" type="button" onClick={() => setRejectItem(o)}>
                          거절
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="t-xs muted max-md:hidden">
            반품 도착을 확인하면 PEAKET이 3영업일 안에 환급합니다. 전자상거래법 §17②1·2호 사유가 있으면 근거와 함께 거절할 수 있고, 거절하면 CS 처리함 &apos;분쟁
            접수&apos;로 넘어갑니다.
          </p>
        </>
      ) : null}

      {invoiceItems.length > 0 ? (
        <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="h-inv">
          <div className="col" style={{ gap: 2 }}>
            <h3 className="t-md fw-b" id="h-inv">
              송장 등록
            </h3>
            <span className="t-xs muted">한 건씩 등록합니다. 여러 건은 송장 CSV 묶음 API를 씁니다.</span>
          </div>
          <div className="field">
            <label className="label" htmlFor="inv-order">
              주문
            </label>
            <div className="input-group input-group-sm">
              <select id="inv-order" value={selectedInvoice?.itemId ?? ''} onChange={(e) => setInvoiceItemId(e.target.value)}>
                {invoiceItems.map((o) => (
                  <option key={o.itemId} value={o.itemId}>
                    {o.orderId.slice(0, 8)}… · {itemText(o)}
                  </option>
                ))}
              </select>
              <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
            </div>
          </div>
          <div className="row wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
            <div className="field" style={{ width: 180 }}>
              <label className="label" htmlFor="inv-courier">
                택배사
              </label>
              <div className="input-group input-group-sm">
                <select id="inv-courier" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                  {CARRIERS.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
              </div>
              {invoiceErrors.carrier ? <span className="error-msg">{invoiceErrors.carrier}</span> : null}
            </div>
            <div className="field grow">
              <label className="label" htmlFor="inv-no">
                송장 번호
              </label>
              <input className="input input-sm" id="inv-no" type="text" inputMode="numeric" value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} />
              {invoiceErrors.trackingNo ? <span className="error-msg">{invoiceErrors.trackingNo}</span> : null}
            </div>
            <button className="btn btn-primary" type="button" disabled={busy !== null} onClick={() => void registerInvoice()}>
              {busy === selectedInvoice?.itemId ? <span className="spinner" aria-hidden="true" /> : null}
              송장 등록하기
            </button>
          </div>
          <p className="t-xs muted">에스크로 주문의 송장 등록은 결제사 배송 정보 등록으로 이어집니다.</p>
        </section>
      ) : null}

      {exportOpen ? (
        <Modal id="ship-dl-live" defaultOpen labelledBy="sdl-t" describedBy="sdl-d" maxWidth={520}>
          <h2 className="dialog-title" id="sdl-t">
            배송 명단 내려받기
          </h2>
          <p className="t-sm muted" id="sdl-d">
            동의 범위 항목만 담습니다(받는 분 이름·연락처·배송 주소, 주문번호, 상품·수량). 사유와 건수는 접속기록에 남습니다.
          </p>
          {exportError ? (
            <div className="banner banner-danger" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              <div className="banner-body">{exportError}</div>
            </div>
          ) : null}
          <fieldset className="col" role="radiogroup" aria-labelledby="sdl-fmt-l">
            <legend className="label" id="sdl-fmt-l" style={{ marginBottom: 10 }}>
              파일 형식 (필수)
            </legend>
            <div className="row" style={{ gap: 24 }}>
              {(['CSV', 'XLSX', 'PDF'] as const).map((f) => (
                <label key={f} className="check-row">
                  <input className="rd" type="radio" name="sdl-fmt" checked={exportFormat === f} onChange={() => setExportFormat(f)} />
                  {f}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="field">
            <label className="label" htmlFor="sdl-reason">
              다운로드 사유 (필수)
            </label>
            <textarea className="input textarea" id="sdl-reason" style={{ minHeight: 96 }} value={exportReason} onChange={(e) => setExportReason(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="sdl-pw">
              비밀번호 (필수)
            </label>
            <input className="input" id="sdl-pw" type="password" autoComplete="current-password" value={exportPassword} onChange={(e) => setExportPassword(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="sdl-code">
              인증 앱 코드 (필수)
            </label>
            <input className="input" id="sdl-code" type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="000 000" value={exportCode} onChange={(e) => setExportCode(e.target.value)} />
            <span className="hint">확인 뒤 등록한 패스키로 한 번 더 확인합니다.</span>
          </div>
          <div className="dialog-actions">
            <button className="btn btn-ghost" type="button" data-modal-close onClick={() => setExportOpen(false)}>
              닫기
            </button>
            <button className="btn btn-primary" type="button" disabled={busy === 'export'} onClick={() => void doExport()}>
              {busy === 'export' ? <span className="spinner" aria-hidden="true" /> : <i className="ic ic-download" aria-hidden="true" />}
              명단 내려받기
            </button>
          </div>
        </Modal>
      ) : null}

      {rejectItem ? (
        <Modal id="return-reject-live" defaultOpen labelledBy="rj-t" describedBy="rj-d" maxWidth={500}>
          <h2 className="dialog-title" id="rj-t">
            반품 거절
          </h2>
          <p className="t-sm muted" id="rj-d">
            {itemText(rejectItem)} · 반품 사유 {rejectItem.returnReason ? RETURN_REASON_LABEL[rejectItem.returnReason] : '—'}
          </p>
          <fieldset className="col" style={{ gap: 8 }} role="radiogroup" aria-labelledby="rj-code-l">
            <legend className="label" id="rj-code-l" style={{ marginBottom: 8 }}>
              거절 사유 (필수)
            </legend>
            <label className="check-row" style={{ alignItems: 'flex-start' }}>
              <input className="rd" type="radio" name="rj-code" checked={rejectReason === 'DAMAGED_BY_BUYER'} onChange={() => setRejectReason('DAMAGED_BY_BUYER')} />
              <span className="col" style={{ gap: 2 }}>
                <span className="t-sm fw-b">구매자 책임의 훼손</span>
                <span className="t-xs muted">전자상거래법 §17②1호</span>
              </span>
            </label>
            <label className="check-row" style={{ alignItems: 'flex-start' }}>
              <input className="rd" type="radio" name="rj-code" checked={rejectReason === 'VALUE_LOST_BY_USE'} onChange={() => setRejectReason('VALUE_LOST_BY_USE')} />
              <span className="col" style={{ gap: 2 }}>
                <span className="t-sm fw-b">사용으로 가치가 현저히 줄어듦</span>
                <span className="t-xs muted">전자상거래법 §17②2호</span>
              </span>
            </label>
            {rejectErrors.reasonCode ? <span className="error-msg">{rejectErrors.reasonCode}</span> : null}
          </fieldset>
          <p className="t-xs muted">내용 확인을 위한 포장 개봉은 거절 사유가 아닙니다.</p>
          <div className="field">
            <label className="label" htmlFor="rj-basis">
              근거 (필수)
            </label>
            <textarea className="textarea" id="rj-basis" style={{ minHeight: 104 }} value={rejectEvidence} onChange={(e) => setRejectEvidence(e.target.value)} />
            {rejectErrors.evidence ? <span className="error-msg">{rejectErrors.evidence}</span> : null}
            <span className="hint">구매자의 이름·연락처는 적지 않습니다. 거절하면 CS 처리함 &apos;분쟁 접수&apos;로 넘어갑니다.</span>
          </div>
          <div className="dialog-actions">
            <button className="btn btn-ghost" type="button" onClick={() => setRejectItem(null)}>
              닫기
            </button>
            <button className="btn btn-danger" type="button" disabled={busy === rejectItem.itemId} onClick={() => void doReject()}>
              반품 거절하기
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
