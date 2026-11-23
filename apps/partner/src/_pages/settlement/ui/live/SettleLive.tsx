'use client';
// SCR-027 [정산서] 탭 실제 API 판(openapi getPartnerEventSettlements·createPartnerSettlementDispute, ADR-0370 결정 9, d5 §6.10).
// 회차를 고르면 그 회차의 결제사별 정산서를 읽어 표·카드로 그리고, 이의 제기는 파트너 관리자만 한다(Idempotency-Key는 공용 함수가 붙인다).
// 계좌는 정산서에 끝 4자리만 오고 이 판은 계좌를 그리지 않는다. 상계 내역 줄은 다른 기능 몫이라 그리지 않는다(F-07-8).
import { useEffect, useState } from 'react';
import { AdminOnly } from '@/features/admin-only';
import { createSettlementDispute, listEventSettlements } from '@/shared/api/partner-live';
import { isProblem } from '@/shared/api/problem';
import { EmptyCard, ErrorCard, LoadingCard, useAsync } from '@/shared/ui/Async';
import { Modal } from '@/shared/ui/Modal';
import { DISPUTE_REASONS, disputeProblemMessage, settleStatementsView, type DisputeReasonCode, type SettleItemView } from '../../model/settle-live';

export interface LiveSettleRound {
  eventId: string;
  label: string;
}

function DisputeDialog({ item, onClose, onDone }: { item: SettleItemView; onClose: () => void; onDone: () => void }) {
  const [reasonCode, setReasonCode] = useState<DisputeReasonCode>('GROSS_AMOUNT');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needDetail = reasonCode === 'OTHER';

  async function submit() {
    if (needDetail && !detail.trim()) {
      setError(disputeProblemMessage({ status: 422 }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createSettlementDispute(item.statementId, { reasonCode, ...(detail.trim() ? { detail: detail.trim() } : {}) });
      onDone();
    } catch (e) {
      setError(isProblem(e) ? disputeProblemMessage(e) : '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal id="settle-dispute-live" defaultOpen persistent labelledBy="sd-t" describedBy="sd-d" maxWidth={520}>
      <h2 className="dialog-title" id="sd-t">
        정산서 이의 제기
      </h2>
      <p className="t-sm muted" id="sd-d">
        {item.storeTitle} · 지급액 {item.amounts.payout}
        {item.disputeDueText ? ` · 이의 기한 ${item.disputeDueText}` : ''}
      </p>
      {error ? (
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">{error}</div>
        </div>
      ) : null}
      <fieldset className="col" style={{ gap: 8 }} role="radiogroup" aria-labelledby="sd-code-l">
        <legend className="label" id="sd-code-l" style={{ marginBottom: 8 }}>
          이의 사유 (필수)
        </legend>
        {DISPUTE_REASONS.map((r) => (
          <label key={r.code} className="check-row" style={{ alignItems: 'flex-start' }}>
            <input className="rd" type="radio" name="sd-code" checked={reasonCode === r.code} onChange={() => setReasonCode(r.code)} />
            <span className="col" style={{ gap: 2 }}>
              <span className="t-sm fw-b">{r.label}</span>
              <span className="t-xs muted">{r.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label className="label" htmlFor="sd-detail">
          설명 {needDetail ? '(필수)' : '(선택)'}
        </label>
        <textarea className="textarea" id="sd-detail" style={{ minHeight: 96 }} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} />
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

function DisputeAction({ item, isMember, onOpen, block = false }: { item: SettleItemView; isMember: boolean; onOpen: () => void; block?: boolean }) {
  const cls = block ? 'btn btn-outline btn-block' : 'btn btn-outline btn-sm';
  if (!item.disputable) return null;
  if (isMember)
    return (
      <AdminOnly isMember id={`sl-dp-${item.statementId}${block ? '-m' : ''}`} className={cls}>
        이의 제기
      </AdminOnly>
    );
  return (
    <button className={cls} type="button" aria-haspopup="dialog" onClick={onOpen}>
      이의 제기
    </button>
  );
}

function StatusCell({ item }: { item: SettleItemView }) {
  return (
    <div className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
      <span className={item.holdReasonText ? 'badge badge-warning' : 'badge'}>{item.statusText}</span>
      {item.holdReasonText ? <span className="t-xs">{item.holdReasonText}</span> : null}
      {item.disputable && item.disputeDueText ? <span className="t-xs muted">이의 기한 {item.disputeDueText}</span> : null}
    </div>
  );
}

export function LiveSettlePanel({ rounds, isMember }: { rounds: readonly LiveSettleRound[]; isMember: boolean }) {
  const [selected, setSelected] = useState(rounds[0]?.eventId ?? '');
  useEffect(() => {
    if (!rounds.some((r) => r.eventId === selected)) setSelected(rounds[0]?.eventId ?? '');
  }, [rounds, selected]);
  const page = useAsync(`event-settlements:${selected}`, (signal) => (selected ? listEventSettlements(selected, signal) : Promise.resolve([])));
  const [dispute, setDispute] = useState<SettleItemView | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (rounds.length === 0) return <EmptyCard title="회차가 없습니다">정산서를 볼 회차가 아직 없습니다.</EmptyCard>;
  const view = page.status === 'ready' ? settleStatementsView(page.data) : null;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="field md:w-[240px] lg:w-[280px]">
        <label className="label" htmlFor="st-live-round">
          회차
        </label>
        <div className="input-group md:h-10 md:[&>select]:text-sm">
          <select id="st-live-round" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {rounds.map((r) => (
              <option key={r.eventId} value={r.eventId}>
                {r.label}
              </option>
            ))}
          </select>
          <i className="ic ic-chevron-down" aria-hidden="true" />
        </div>
      </div>

      {message ? (
        <div className="banner banner-success" role="status">
          <i className="ic ic-check-circle" aria-hidden="true" />
          <div className="banner-body">{message}</div>
        </div>
      ) : null}
      {view?.kycBanner ? (
        <div className="banner banner-info" role="status">
          <i className="ic ic-info" aria-hidden="true" />
          <div className="banner-body">{view.kycBanner}</div>
        </div>
      ) : null}

      {page.status === 'loading' ? <LoadingCard label="정산서를 불러오는 중입니다" /> : null}
      {page.status === 'error' ? <ErrorCard error={page.error} onRetry={page.reload} fallback="정산서를 불러오지 못했습니다" /> : null}

      {view && view.groups.length === 0 ? (
        <EmptyCard title="아직 정산서가 없습니다">회차가 끝난 다음 영업일에 계산하고 같은 날 알립니다.</EmptyCard>
      ) : null}

      {view && view.groups.length > 0 ? (
        <section className="col" style={{ gap: 10 }} aria-labelledby="ps-live-h">
          <div className="flex flex-col gap-0.5 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-x-3 md:gap-y-1">
            <h3 className="t-md fw-b" id="ps-live-h">
              결제사별 정산서
            </h3>
            <span className="t-xs muted">회차가 끝난 다음 영업일에 계산 · 통지 뒤 2영업일 안에 이의를 낼 수 있습니다</span>
          </div>
          {view.groups.map((g) => (
            <div key={g.pg} className="col" style={{ gap: 8 }}>
              <h4 className="t-sm fw-b">{g.title}</h4>
              <div className="table-wrap table-scroll max-md:hidden" role="region" aria-label={`${g.title} 정산서 표`} tabIndex={0}>
                <table className="table dense" style={{ minWidth: 920 }}>
                  <caption className="sr-only">{g.title} 정산서, 금액 항목과 지급 상태</caption>
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
                        중개수수료
                      </th>
                      <th scope="col" className="r">
                        부가세
                      </th>
                      <th scope="col" className="r">
                        미수금 상계
                      </th>
                      <th scope="col" className="r">
                        지급액
                      </th>
                      <th scope="col">상태</th>
                      <th scope="col">지급 예정</th>
                      <th scope="col">
                        <span className="sr-only">이의 제기</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((i) => (
                      <tr key={i.statementId}>
                        <td className="fw-b">{i.storeTitle}</td>
                        <td className="r">{i.amounts.gross}</td>
                        <td className="r">{i.amounts.refund}</td>
                        <td className="r">{i.amounts.commission}</td>
                        <td className="r">{i.amounts.vat}</td>
                        <td className="r">{i.amounts.offset}</td>
                        <td className="r fw-b">{i.amounts.payout}</td>
                        <td>
                          <StatusCell item={i} />
                        </td>
                        <td className="num">{i.payoutDateText ?? '—'}</td>
                        <td>
                          <DisputeAction item={i} isMember={isMember} onOpen={() => setDispute(i)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="col md:hidden" style={{ gap: 12 }} aria-label={`${g.title} 정산서`}>
                {g.items.map((i) => (
                  <li key={i.statementId} className="card pad col" style={{ gap: 12 }}>
                    <div className="row between" style={{ gap: 8 }}>
                      <h5 className="t-md fw-b">{i.storeTitle}</h5>
                      <StatusCell item={i} />
                    </div>
                    <div className="row between" style={{ gap: 8, alignItems: 'baseline' }}>
                      <span className="t-sm muted">지급액</span>
                      <span className="t-lg num">{i.amounts.payout}</span>
                    </div>
                    <dl className="kv" style={{ rowGap: 6 }}>
                      <dt>판매 대금</dt>
                      <dd>{i.amounts.gross}</dd>
                      <dt>환급</dt>
                      <dd>{i.amounts.refund}</dd>
                      <dt>중개수수료</dt>
                      <dd>{i.amounts.commission}</dd>
                      <dt>부가세</dt>
                      <dd>{i.amounts.vat}</dd>
                      <dt>미수금 상계</dt>
                      <dd>{i.amounts.offset}</dd>
                      <dt>지급 예정</dt>
                      <dd>{i.payoutDateText ?? '—'}</dd>
                    </dl>
                    <DisputeAction item={i} isMember={isMember} onOpen={() => setDispute(i)} block />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="t-xs muted">
            지급액 = 판매 대금 − 환급 − 중개수수료와 부가세 − 미수금 상계. 보류(KYC 필요·계좌 변경 3영업일·잔액 부족·포트원 계좌 불일치·판매 중지)가 풀리면 다음 지급
            묶음으로 지급합니다. 결제사 잔액이 모자라면 지급일을 미룹니다.
          </p>
        </section>
      ) : null}

      {dispute ? (
        <DisputeDialog
          item={dispute}
          onClose={() => setDispute(null)}
          onDone={() => {
            setDispute(null);
            setMessage('이의를 접수했습니다. 그 정산서만 지급을 멈추고 PEAKET이 확인합니다.');
            page.reload();
          }}
        />
      ) : null}
    </div>
  );
}
