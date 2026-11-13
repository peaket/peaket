'use client';
// SCR-023 [상품 정산] 실제 API 판(openapi listPartnerProductSettlements·createPartnerSettlementDispute).
// payment-svc 정산 모듈·정산서 표·지급대행 어댑터가 없으면 서버가 404/501/503을 주고, 화면은 그 사실을 그대로 알린다.
import { useState } from 'react';
import { createSettlementDispute, listProductSettlements, type SettlementStatement } from '@/shared/api/partner-live';
import { problemMessage } from '@/shared/api/problem';
import { EmptyCard, ErrorCard, LoadingCard, useAsync } from '@/shared/ui/Async';
import { Modal } from '@/shared/ui/Modal';
import {
  DISPUTE_REASONS,
  canDispute,
  disputeDueText,
  periodText,
  settlementBlocked,
  statementTitle,
  statusBadge,
  statusText,
  won,
} from '../../model/settlement-live';

function DisputeDialog({ statement, onClose, onDone }: { statement: SettlementStatement; onClose: () => void; onDone: () => void }) {
  const [reasonCode, setReasonCode] = useState<(typeof DISPUTE_REASONS)[number]['code']>('GROSS_AMOUNT');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needDetail = reasonCode === 'OTHER';

  async function submit() {
    if (needDetail && !detail.trim()) {
      setError('그 밖의 사유는 설명을 적어야 보냅니다.');
      return;
    }
    if (!statement.statementId) {
      setError('정산서 번호가 없어 이의를 낼 수 없습니다.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createSettlementDispute(statement.statementId, { reasonCode, ...(detail.trim() ? { detail: detail.trim() } : {}) });
      onDone();
    } catch (e) {
      setError(problemMessage(e, '이의를 내지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal id="ps-dispute-live" defaultOpen labelledBy="pd-t" describedBy="pd-d" maxWidth={520}>
      <h2 className="dialog-title" id="pd-t">
        상품 정산서 이의 제기
      </h2>
      <p className="t-sm muted" id="pd-d">
        {statementTitle(statement)} · {periodText(statement)} · 지급액 {won(statement.payoutAmount)}
      </p>
      {error ? (
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">{error}</div>
        </div>
      ) : null}
      <fieldset className="col" style={{ gap: 8 }} role="radiogroup" aria-labelledby="pd-code-l">
        <legend className="label" id="pd-code-l" style={{ marginBottom: 8 }}>
          이의 사유 (필수)
        </legend>
        {DISPUTE_REASONS.map((r) => (
          <label key={r.code} className="check-row" style={{ alignItems: 'flex-start' }}>
            <input className="rd" type="radio" name="pd-code" checked={reasonCode === r.code} onChange={() => setReasonCode(r.code)} />
            <span className="col" style={{ gap: 2 }}>
              <span className="t-sm fw-b">{r.label}</span>
              <span className="t-xs muted">{r.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label className="label" htmlFor="pd-detail">
          설명 {needDetail ? '(필수)' : '(선택)'}
        </label>
        <textarea className="textarea" id="pd-detail" style={{ minHeight: 96 }} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} />
      </div>
      <div className="dialog-actions">
        <button className="btn btn-ghost" type="button" onClick={onClose}>
          닫기
        </button>
        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          이의 제기하기
        </button>
      </div>
    </Modal>
  );
}

export function LiveSettlementSection({ isMember }: { isMember: boolean }) {
  const page = useAsync('product-settlements', (signal) => listProductSettlements({ limit: 100 }, signal));
  const [dispute, setDispute] = useState<SettlementStatement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const blocked = page.status === 'error' ? settlementBlocked(page.error) : { blocked: false, title: '', detail: '' };
  const items = page.status === 'ready' ? page.data.items : [];

  return (
    <section className="col" style={{ gap: 16 }} aria-labelledby="h-ps">
      <div className="section-title">
        <h2 id="h-ps">상품 정산</h2>
        <span className="t-xs muted md:text-[14px]">payment-svc 상품 정산서</span>
      </div>
      <p className="t-sm muted">
        굿즈와 티켓 연동 부가 상품은 회차 정산서와 따로 상품 정산서로 냅니다. 결제 상점마다 한 주(월~일, KST)에 정산 기준일이 든 항목을 매주 첫 영업일에 계산하고,
        계산일로부터 4영업일 뒤 지급합니다.
      </p>

      {message ? (
        <div className="banner banner-success" role="status">
          <i className="ic ic-check-circle" aria-hidden="true" />
          <div className="banner-body">{message}</div>
        </div>
      ) : null}
      {page.status === 'loading' ? <LoadingCard label="상품 정산서를 불러오는 중입니다" /> : null}
      {page.status === 'error' && blocked.blocked ? (
        <div className="banner banner-warning" role="note">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">{blocked.title}</span>
            {blocked.detail}
          </div>
        </div>
      ) : null}
      {page.status === 'error' && !blocked.blocked ? <ErrorCard error={page.error} onRetry={page.reload} fallback="상품 정산서를 불러오지 못했습니다" /> : null}

      {page.status === 'ready' ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="group" aria-label="상품 정산 요약">
            <div className="stat max-md:col-span-2">
              <span className="stat-label">정산 대기</span>
              <span className="t-lg num">{won(page.data.awaitingSettlementAmount)}</span>
              <span className="stat-meta">구매 확정이나 반품 기한이 지난 주문부터 다음 주 정산서에 들어갑니다</span>
            </div>
            <div className="stat card is-selected max-md:col-span-2">
              <span className="stat-label">이번 정산서 지급액</span>
              <span className="t-lg num max-md:text-[24px] max-md:leading-8">{won(items.reduce((s, i) => s + (i.payoutAmount ?? 0), 0))}</span>
              <span className="stat-meta">결제 상점 {items.length}곳 합계</span>
            </div>
          </div>
          {items.length === 0 ? (
            <EmptyCard title="아직 상품 정산서가 없습니다">정산 기준일이 지난 주문이 생기면 다음 주 첫 영업일에 계산합니다.</EmptyCard>
          ) : (
            <>
              <div className="table-wrap table-scroll max-md:hidden" role="region" aria-label="결제 상점별 상품 정산서 표" tabIndex={0}>
                <table className="table dense" style={{ minWidth: 920 }}>
                  <caption className="sr-only">상품 정산서, 결제 상점별 금액 항목과 지급 상태</caption>
                  <thead>
                    <tr>
                      <th scope="col">결제 상점</th>
                      <th scope="col">기간</th>
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
                      <th scope="col">상태</th>
                      <th scope="col">
                        <span className="sr-only">이의 제기</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((s, i) => (
                      <tr key={s.statementId ?? i}>
                        <td className="fw-b">{statementTitle(s)}</td>
                        <td className="num">{periodText(s)}</td>
                        <td className="r">{won(s.grossAmount)}</td>
                        <td className="r">{won(s.refundAmount)}</td>
                        <td className="r">{won((s.commissionAmount ?? 0) + (s.commissionVat ?? 0))}</td>
                        <td className="r">{won(s.offsetAmount)}</td>
                        <td className="r fw-b">{won(s.payoutAmount)}</td>
                        <td>
                          <div className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
                            <span className={statusBadge(s)}>{statusText(s)}</span>
                            {s.disputeDueAt ? <span className="t-xs muted">이의 기한 {disputeDueText(s)}</span> : null}
                          </div>
                        </td>
                        <td>
                          {canDispute(s) && !isMember ? (
                            <button className="btn btn-outline btn-sm" type="button" onClick={() => setDispute(s)}>
                              이의 제기
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="col md:hidden" style={{ gap: 12 }} aria-label="상품 정산서">
                {items.map((s, i) => (
                  <li key={s.statementId ?? i} className="card pad col" style={{ gap: 12 }}>
                    <div className="row between" style={{ gap: 8 }}>
                      <h4 className="t-md fw-b">{statementTitle(s)}</h4>
                      <span className={statusBadge(s)}>{statusText(s)}</span>
                    </div>
                    <div className="row between" style={{ gap: 8, alignItems: 'baseline' }}>
                      <span className="t-sm muted">지급액</span>
                      <span className="t-lg num">{won(s.payoutAmount)}</span>
                    </div>
                    <dl className="kv" style={{ rowGap: 6 }}>
                      <dt>기간</dt>
                      <dd>{periodText(s)}</dd>
                      <dt>판매 대금</dt>
                      <dd>{won(s.grossAmount)}</dd>
                      <dt>환급</dt>
                      <dd>{won(s.refundAmount)}</dd>
                      <dt>수수료·부가세</dt>
                      <dd>{won((s.commissionAmount ?? 0) + (s.commissionVat ?? 0))}</dd>
                      <dt>상계</dt>
                      <dd>{won(s.offsetAmount)}</dd>
                    </dl>
                    {canDispute(s) && !isMember ? (
                      <button className="btn btn-outline btn-block" type="button" onClick={() => setDispute(s)}>
                        이의 제기
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="t-xs muted">지급액 = 판매 대금 − 환급 − 중개수수료와 부가세 − 미수금 상계. 판매 대금에는 구매자가 낸 처음 배송비가 들어갑니다.</p>
        </>
      ) : null}

      {dispute ? (
        <DisputeDialog
          statement={dispute}
          onClose={() => setDispute(null)}
          onDone={() => {
            setDispute(null);
            setMessage('이의를 접수했습니다. 그 정산서만 지급을 멈추고 PEAKET이 확인합니다.');
            page.reload();
          }}
        />
      ) : null}
    </section>
  );
}
