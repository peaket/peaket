'use client';
// SCR-021 5단계 판매 승인 요청 실제 화면(BAT-617, LCH-080, d5 §6.4, ADR-0327).
// 실제 공연(UUID)은 GET /v1/partner/productions/{productionId}/sale-review로 상태·제목·판매자 정보·회차를 읽고,
// partner_admin이 POST로 요청하거나 DELETE로 변경을 취소한다. 계좌는 요청 본문에만 쓰고 저장하지 않는다.
// partner_member는 요청·취소 단추가 없고, 서버 403을 받으면 이 방문 동안 버튼을 끈다.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isProblem, problemMessage, problemType } from '@/shared/api/problem';
import { routes } from '@/shared/config/routes';
import { Modal } from '@/shared/ui/Modal';
import { performanceSellerNotice } from '@/shared/lib/seller-notice';
import {
  emptySaleReviewForm,
  formFromStatus,
  formatKst,
  problemOf,
  saleReviewView,
  toSaleReviewBody,
  validateSaleReview,
  type SaleReviewForm,
  type SaleReviewIssue,
  type SaleReviewStatusLike,
  type ShortfallReason,
} from '../model/sale-review-live';

type Load = { kind: 'loading' } | { kind: 'ready'; status: SaleReviewStatusLike } | { kind: 'notfound' } | { kind: 'error'; message: string };

const SCALE_LABEL = { LARGE: '대형', MEDIUM: '중형', SMALL: '소형' } as const;
const SHORTFALL = [
  { value: 'RELAXED_STANDARD', label: '공연장이 완화된 기준을 승인받았습니다' },
  { value: 'RECOMMENDED_FACILITY', label: '공연장이 휠체어석 설치 권장 시설입니다' },
  { value: 'NOT_USED_THIS_SHOW', label: '무대 설치 등으로 이 공연에서 쓸 수 없는 휠체어석이 있습니다' },
  { value: 'OTHER', label: '기타(직접 입력)' },
] as const;

const fieldId = (field: string) => `f-${field.replaceAll('.', '-')}`;

export function LiveSaleReview({ productionId }: { productionId: string }) {
  const [screen, setScreen] = useState<Load>({ kind: 'loading' });
  const [form, setForm] = useState<SaleReviewForm>(() => emptySaleReviewForm());
  const [issues, setIssues] = useState<SaleReviewIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [memberDenied, setMemberDenied] = useState(false);
  const [confirm, setConfirm] = useState<'request' | 'cancel' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const status = screen.kind === 'ready' ? screen.status : null;
  const view = useMemo(() => (status ? saleReviewView(status) : null), [status]);
  const setConfirmOpen = (open: boolean) => setConfirm(open ? 'request' : null);

  const load = useCallback(async () => {
    setScreen({ kind: 'loading' });
    try {
      const { partnerApi, OPERATIONS } = await import('@/shared/api');
      const s = await partnerApi().request<SaleReviewStatusLike>(OPERATIONS.getPartnerProductionSaleReview, { params: { productionId } });
      setScreen({ kind: 'ready', status: s });
      setForm(formFromStatus(s));
    } catch (e) {
      if (isProblem(e) && e.status === 404) setScreen({ kind: 'notfound' });
      else if (isProblem(e) && e.status === 403) setMemberDenied(true);
      else setScreen({ kind: 'error', message: problemMessage(e, '판매 승인 현황을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.') });
    }
  }, [productionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (issues.length === 0) return;
    document.getElementById(fieldId(issues[0]!.field))?.focus();
  }, [issues]);

  const updateSeller = (key: keyof SaleReviewForm['seller'], value: string) => setForm((f) => ({ ...f, seller: { ...f.seller, [key]: value } }));
  const updatePayout = (key: keyof SaleReviewForm['payout'], value: string) => setForm((f) => ({ ...f, payout: { ...f.payout, [key]: value } }));

  const openRequest = () => {
    const found = validateSaleReview(form);
    setIssues(found);
    setNotice(null);
    if (found.length > 0) return;
    setConfirm('request');
  };

  const sendRequest = async () => {
    if (busy) return;
    const found = validateSaleReview(form);
    setIssues(found);
    if (found.length > 0) {
      setConfirmOpen(false);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const { partnerApi, OPERATIONS } = await import('@/shared/api');
      await partnerApi().request(OPERATIONS.createPartnerProductionSaleReview, { params: { productionId }, body: toSaleReviewBody(form) });
      setConfirmOpen(false);
      setNotice({ tone: 'ok', text: '판매 승인을 요청했습니다. 운영자가 확인하면 상태가 바뀝니다.' });
      await load();
    } catch (e) {
      const p = problemOf(e);
      if (p.kind === 'member') setMemberDenied(true);
      setConfirmOpen(false);
      setNotice({ tone: 'bad', text: p.message });
      if (p.reload) await load();
    } finally {
      setBusy(false);
    }
  };

  const cancelChange = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const { partnerApi, OPERATIONS } = await import('@/shared/api');
      await partnerApi().request(OPERATIONS.deletePartnerProductionSaleReview, { params: { productionId } });
      setConfirmOpen(false);
      setNotice({ tone: 'ok', text: '변경 요청을 취소했습니다. 마지막 승인 내용으로 돌아갔습니다.' });
      await load();
    } catch (e) {
      const p = problemOf(e);
      if (p.kind === 'member') setMemberDenied(true);
      setConfirmOpen(false);
      setNotice({ tone: 'bad', text: p.message });
      if (p.reload) await load();
    } finally {
      setBusy(false);
    }
  };

  if (screen.kind === 'loading' && !status) {
    return (
      <section className="card pad-lg col" style={{ gap: 10 }} role="status">
        <h1 className="t-lg">5단계 · 판매자 정보·승인 요청</h1>
        <p className="t-sm muted">판매 승인 현황을 불러오는 중…</p>
      </section>
    );
  }

  if (screen.kind === 'notfound') {
    return (
      <section className="card pad-lg col" style={{ gap: 10 }} role="alert">
        <h1 className="t-lg">공연을 찾을 수 없습니다</h1>
        <p className="t-sm">없는 공연이거나 다른 파트너의 공연입니다.</p>
        <Link className="btn btn-outline" href={routes.events()}>
          공연 목록으로
        </Link>
      </section>
    );
  }

  if (screen.kind === 'error') {
    return (
      <section className="card pad-lg col" style={{ gap: 10 }} role="alert">
        <h1 className="t-lg">판매 승인 현황을 불러오지 못했습니다</h1>
        <p className="t-sm">{screen.message}</p>
        <button className="btn btn-outline" type="button" onClick={() => void load()}>
          다시 시도
        </button>
      </section>
    );
  }

  if (!status || !view) return null;

  return (
    <>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className={`badge${view.tone === 'danger' ? ' badge-danger' : view.tone === 'success' ? ' badge-success' : view.tone === 'warning' ? ' badge-warning' : view.tone === 'primary' ? ' badge-primary' : ''}`}>{view.label}</span>
            {status.hasApprovalHistory ? <span className="badge badge-outline">재승인</span> : null}
          </div>
          <h1 className="t-lg">{status.title || '판매 승인 요청'}</h1>
          <p className="t-sm muted">
            판매 승인은 공연 단위입니다. 5단계에서 판매자 정보·정산 계좌 모양·휠체어석 확인을 보내면 운영자가 확인합니다.
            {status.submittedAt ? ` · 제출 ${formatKst(status.submittedAt)}` : ''}
          </p>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <button className="btn btn-outline" type="button" onClick={() => void load()} disabled={busy}>
            <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
          </button>
        </div>
      </div>

      {memberDenied ? (
        <div className="banner banner-info" role="status" style={{ marginBottom: 12 }}>
          <i className="ic ic-lock" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">요청과 변경 취소는 파트너 관리자만 할 수 있습니다</span>
            요청 버튼을 잠갔습니다. 파트너 관리자에게 요청해 주세요.
          </div>
        </div>
      ) : null}

      {view.reason ? (
        <div className="banner banner-danger" role="alert" style={{ marginBottom: 12 }}>
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">반려 사유</span>
            {status.rejectionReason ?? view.reason}
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className={`banner ${notice.tone === 'ok' ? 'banner-info' : 'banner-danger'}`} role={notice.tone === 'ok' ? 'status' : 'alert'} style={{ marginBottom: 12 }}>
          <div className="banner-body">{notice.text}</div>
        </div>
      ) : null}

      <section className="card pad-lg col" style={{ gap: 12, marginBottom: 16 }} aria-labelledby="sr-rounds">
        <div className="section-title">
          <h2 id="sr-rounds">회차</h2>
          <span className="t-xs muted">{status.events.length}개 회차</span>
        </div>
        {status.events.length === 0 ? (
          <p className="t-sm muted">등록된 회차가 없습니다. 등록 정보에서 회차를 먼저 더해 주세요.</p>
        ) : (
          <ul className="col" style={{ gap: 6 }}>
            {status.events.map((e) => (
              <li key={e.eventId} className="row between wrap" style={{ gap: 8 }}>
                <span className="t-sm">오픈 {formatKst(e.openAt)} · 시작 {formatKst(e.startsAt)}</span>
                <span className="badge">{e.scale ? SCALE_LABEL[e.scale] : '규모 미정'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {issues.length > 0 ? (
        <div className="error-summary" role="alert" aria-labelledby="sr-err" style={{ marginBottom: 16 }}>
          <strong className="row" id="sr-err" style={{ gap: 6 }}>
            <i className="ic ic-alert-circle tx-danger" aria-hidden="true" />
            판매 승인 요청을 보내지 못했습니다 · 고칠 항목 {issues.length}건
          </strong>
          {issues.map((i) => (
            <a key={`${i.field}-${i.message}`} href={`#${fieldId(i.field)}`}>
              {i.message}
            </a>
          ))}
        </div>
      ) : null}

      {view.editable ? (
        <div className="col" style={{ gap: 16 }}>
          <div className="banner banner-legal" role="note">
            <i className="ic ic-scale" aria-hidden="true" />
            <div className="banner-body">
              <span className="legal-tag">법정 고지</span>
              {performanceSellerNotice(form.seller.legalName)}
            </div>
          </div>
          <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="sr-seller">
            <div className="section-title">
              <h2 id="sr-seller">판매자 정보 7항목</h2>
              <span className="t-xs muted">전자상거래법 §20②</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-[14px]">
              {(
                [
                  ['legalName', '상호', 'text', 100],
                  ['representative', '대표자', 'text', 100],
                  ['businessRegNo', '사업자등록번호', 'text', 20],
                  ['phone', '전화', 'tel', 30],
                  ['email', '전자우편', 'email', 200],
                ] as const
              ).map(([key, label, type, max]) => (
                <div className="field" key={key}>
                  <label className="label" htmlFor={fieldId(`seller.${key}`)}>
                    {label} <span className="opt">(필수)</span>
                  </label>
                  <input
                    className={`input input-sm${issues.some((i) => i.field === `seller.${key}`) ? ' is-error' : ''}`}
                    id={fieldId(`seller.${key}`)}
                    type={type}
                    maxLength={max}
                    autoComplete={key === 'phone' ? 'tel' : key === 'email' ? 'email' : 'off'}
                    value={form.seller[key]}
                    disabled={busy}
                    aria-invalid={issues.some((i) => i.field === `seller.${key}`) || undefined}
                    onChange={(e) => updateSeller(key, e.target.value)}
                  />
                </div>
              ))}
              <div className="field col-span-2">
                <label className="label" htmlFor={fieldId('seller.address')}>
                  주소 <span className="opt">(필수)</span>
                </label>
                <input
                  className={`input input-sm${issues.some((i) => i.field === 'seller.address') ? ' is-error' : ''}`}
                  id={fieldId('seller.address')}
                  type="text"
                  maxLength={300}
                  value={form.seller.address}
                  disabled={busy}
                  aria-invalid={issues.some((i) => i.field === 'seller.address') || undefined}
                  onChange={(e) => updateSeller('address', e.target.value)}
                />
              </div>
              <fieldset className="field col-span-2" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label">통신판매업 신고 (필수)</legend>
                <div className="row" style={{ gap: 16 }}>
                  {(['NUMBER', 'EXEMPTION'] as const).map((kind) => (
                    <label className="check-row" key={kind} htmlFor={`sr-report-${kind}`}>
                      <input
                        className="rd"
                        type="radio"
                        id={`sr-report-${kind}`}
                        name="sr-report"
                        checked={form.report.kind === kind}
                        disabled={busy}
                        onChange={() => setForm((f) => ({ ...f, report: { ...f.report, kind } }))}
                      />
                      {kind === 'NUMBER' ? '신고번호 있음' : '면제 대상'}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="field col-span-2">
                <label className="label" htmlFor={fieldId('report.value')}>
                  {form.report.kind === 'NUMBER' ? '통신판매업 신고번호' : '면제 근거'} <span className="opt">(필수)</span>
                </label>
                <input
                  className={`input input-sm${issues.some((i) => i.field === 'report.value') ? ' is-error' : ''}`}
                  id={fieldId('report.value')}
                  type="text"
                  maxLength={form.report.kind === 'NUMBER' ? 100 : 500}
                  value={form.report.value}
                  disabled={busy}
                  aria-invalid={issues.some((i) => i.field === 'report.value') || undefined}
                  onChange={(e) => setForm((f) => ({ ...f, report: { ...f.report, value: e.target.value } }))}
                />
              </div>
            </div>
          </section>

          <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="sr-payout">
            <div className="section-title">
              <h2 id="sr-payout">정산 계좌</h2>
              <span className="t-xs muted">지급대행 연동 전</span>
            </div>
            <p className="t-sm muted">계좌번호는 저장하지 않습니다. 지급대행 연동 전이라 예금주 확인은 하지 않으며, 판매 승인을 막지 않습니다(LCH-110).</p>
            <div className="grid grid-cols-3 gap-x-4 gap-y-[14px]">
              {(
                [
                  ['bankCode', '은행 코드', 'text', 10],
                  ['accountNumber', '계좌번호', 'text', 30],
                  ['holderName', '예금주', 'text', 60],
                ] as const
              ).map(([key, label, type, max]) => (
                <div className="field" key={key}>
                  <label className="label" htmlFor={fieldId(`payout.${key}`)}>
                    {label} <span className="opt">(필수)</span>
                  </label>
                  <input
                    className={`input input-sm${issues.some((i) => i.field === `payout.${key}`) ? ' is-error' : ''}`}
                    id={fieldId(`payout.${key}`)}
                    type={type}
                    inputMode={key === 'accountNumber' || key === 'bankCode' ? 'numeric' : undefined}
                    maxLength={max}
                    autoComplete="off"
                    value={form.payout[key]}
                    disabled={busy}
                    aria-invalid={issues.some((i) => i.field === `payout.${key}`) || undefined}
                    onChange={(e) => updatePayout(key, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="sr-wheelchair">
            <div className="section-title">
              <h2 id="sr-wheelchair">휠체어석 확인</h2>
            </div>
            <label className="check-row" htmlFor={fieldId('wheelchair.confirmed')}>
              <input
                type="checkbox"
                id={fieldId('wheelchair.confirmed')}
                checked={form.wheelchair.confirmed}
                disabled={busy}
                aria-invalid={issues.some((i) => i.field === 'wheelchair.confirmed') || undefined}
                onChange={(e) => setForm((f) => ({ ...f, wheelchair: { ...f.wheelchair, confirmed: e.target.checked } }))}
              />
              <span className="t-sm">휠체어석의 수와 위치를 공연장 좌석 배치도와 대조해 확인했습니다</span>
            </label>
            <div className="field">
              <label className="label" htmlFor={fieldId('wheelchair.shortfallReason')}>
                기준보다 적은 이유 <span className="opt">(해당할 때)</span>
              </label>
              <select
                className="input input-sm"
                id={fieldId('wheelchair.shortfallReason')}
                value={form.wheelchair.shortfallReason}
                disabled={busy}
                onChange={(e) => setForm((f) => ({ ...f, wheelchair: { ...f.wheelchair, shortfallReason: e.target.value as ShortfallReason | '' } }))}
              >
                <option value="">해당 없음</option>
                {SHORTFALL.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            {form.wheelchair.shortfallReason === 'OTHER' ? (
              <div className="field">
                <label className="label" htmlFor={fieldId('wheelchair.note')}>
                  이유 <span className="opt">(필수)</span>
                </label>
                <textarea
                  className={`input${issues.some((i) => i.field === 'wheelchair.note') ? ' is-error' : ''}`}
                  id={fieldId('wheelchair.note')}
                  maxLength={500}
                  value={form.wheelchair.note}
                  disabled={busy}
                  onChange={(e) => setForm((f) => ({ ...f, wheelchair: { ...f.wheelchair, note: e.target.value } }))}
                />
              </div>
            ) : null}
          </section>

          <div className="card row between wrap" style={{ padding: '12px 16px', gap: 8 }}>
            <Link className="btn btn-outline" href={routes.eventTab(productionId, 'edit')}>
              <i className="ic ic-chevron-left" aria-hidden="true" /> 이전(4단계 등록 정보)
            </Link>
            <div className="row" style={{ gap: 8 }}>
              {view.canCancel ? (
                <button className="btn btn-outline" type="button" disabled={busy || memberDenied} onClick={() => setConfirm('cancel')}>
                  변경 취소
                </button>
              ) : null}
              {view.canRequest ? (
                <button className="btn btn-primary" type="button" disabled={busy || memberDenied} onClick={openRequest}>
                  <i className="ic ic-upload" aria-hidden="true" /> 판매 승인 요청
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <section className="card pad-lg col" style={{ gap: 12 }} aria-labelledby="sr-state">
          <h2 className="t-md fw-b" id="sr-state">
            {view.label}
          </h2>
          {status.saleReview === 'SUBMITTED' ? <p className="t-sm">운영자가 판매자 정보·회차·규모·판매 정책을 확인하고 있습니다. 승인되면 공개와 판매가 열립니다.</p> : null}
          {status.saleReview === 'APPROVED' ? <p className="t-sm">판매 승인이 끝났습니다. 등록 정보나 판매 정책을 바꾸면 다시 승인을 받아야 합니다.</p> : null}
          {status.saleReview === 'SUSPENDED' ? <p className="t-sm">판매가 중지된 공연입니다. 문의는 파트너 지원으로 해 주세요.</p> : null}
          <div className="row" style={{ gap: 8 }}>
            <Link className="btn btn-outline" href={routes.eventTab(productionId, 'edit')}>
              등록 정보로
            </Link>
            <button className="btn btn-outline" type="button" onClick={() => void load()} disabled={busy}>
              새로 고침
            </button>
          </div>
        </section>
      )}

      {confirm === 'request' ? (
        <Modal key="request" id="sr-request" defaultOpen role="alertdialog" labelledBy="sr-request-t" describedBy="sr-request-d">
          <h2 className="dialog-title" id="sr-request-t">
            판매 승인을 요청합니다
          </h2>
          <p className="t-sm" id="sr-request-d">
            판매자 정보·정산 계좌 모양·휠체어석 확인을 보냅니다. 운영자가 확인하면 공개와 판매가 열립니다.
          </p>
          <p className="t-xs muted">계좌번호는 저장하지 않고 응답에도 남지 않습니다. 예금주 확인과 KYC는 지급대행 연동(LCH-110) 뒤에 합니다.</p>
          <div className="dialog-actions">
            <button className="btn btn-ghost" type="button" data-modal-close onClick={() => setConfirmOpen(false)}>
              돌아가서 고치기
            </button>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void sendRequest()}>
              {busy ? '보내는 중…' : '판매 승인 요청 보내기'}
            </button>
          </div>
        </Modal>
      ) : null}

      {confirm === 'cancel' ? (
        <Modal key="cancel" id="sr-cancel" defaultOpen role="alertdialog" labelledBy="sr-cancel-t" describedBy="sr-cancel-d">
          <h2 className="dialog-title" id="sr-cancel-t">
            변경 요청을 취소합니다
          </h2>
          <p className="t-sm" id="sr-cancel-d">
            마지막 승인 내용으로 돌아갑니다. 공개 중인 내용과 판매는 그대로입니다.
          </p>
          <div className="dialog-actions">
            <button className="btn btn-ghost" type="button" data-modal-close onClick={() => setConfirmOpen(false)}>
              닫기
            </button>
            <button className="btn btn-danger" type="button" disabled={busy} onClick={() => void cancelChange()}>
              {busy ? '취소하는 중…' : '변경 취소'}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
