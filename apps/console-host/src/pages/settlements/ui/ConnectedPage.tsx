// SCR-049 정산 지급 연결 화면(BAT-630 LCH-110, d5 §7.10, settlement §9).
// 지급일 탭은 GET /v1/ops/payout-batches, 상세는 GET /v1/ops/payout-batches/{batchId},
// 승인·반려는 승인 업무 경로, 확인 요청·포트원 실행 기록은 지급 묶음 경로를 부른다.
// viewer는 읽기만, operator는 확인 요청·실행 기록, commander는 재인증 뒤 승인·반려한다. CS 두 역할은 쓰지 않는다.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError } from '@peaket/api-client';
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { ReauthDialog } from '@/features/admin-reauth/ReauthDialog';
import { BOARD_PEOPLE, NoAccess, ReadOnlyScope } from '@/features/screen-access';
import { useChosenRole, usePreviewHost } from '@/features/preview-host';
import { ensureConsoleApi } from '@/shared/api';
import { Overlay } from '@/shared/ui/Overlay';
import {
  canApprove,
  canRead,
  canRecordExecution,
  canRequest,
  formatDateKst,
  formatKst,
  holdLabel,
  mapApproval,
  mapBatch,
  mapBatchDetail,
  mapReceivable,
  mapStatement,
  remainingText,
  statusLabel,
  won,
  type ApprovalRow,
  type BatchDetail,
  type BatchRow,
  type LoadKind,
  type ReceivableRow,
  type StatementRow,
} from '../model/settlement-payout';

const TITLE = '정산 지급';
const todayKst = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const newKey = (): string => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

type Screen = { kind: LoadKind; message?: string };

export function ConnectedPage() {
  const chosen = useChosenRole();
  const [sp, setSp] = useSearchParams();
  const [payoutDate, setPayoutDate] = useState(sp.get('date') ?? todayKst());
  const [selected, setSelected] = useState(sp.get('batch'));
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [receivables, setReceivables] = useState<ReceivableRow[]>([]);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [reauthOpen, setReauthOpen] = useState(false);
  const [portoneOpen, setPortoneOpen] = useState(false);
  const [bulkPayoutId, setBulkPayoutId] = useState('');
  const [form, setForm] = useState<{ pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; portoneAmount: string; observedAt: string }>({
    pg: 'TOSS',
    pgStore: 'STANDARD',
    portoneAmount: '',
    observedAt: new Date().toISOString().slice(0, 16),
  });

  const write = canRecordExecution(chosen);
  const approve = canApprove(chosen);
  const read = canRead(chosen);
  const selectedBatch = useMemo(() => batches.find((b) => b.batchId === selected) ?? null, [batches, selected]);
  const selectedApproval = useMemo(
    () => approvals.find((a) => a.targetRef === selectedBatch?.batchId) ?? (selectedBatch?.approvalId ? approvals.find((a) => a.approvalId === selectedBatch.approvalId) : undefined),
    [approvals, selectedBatch],
  );

  usePreviewHost(
    {
      scope: { stage: '종료 후' },
      control: { kind: 'ok' },
      clock: '11:42:05 KST',
      ...(chosen ? {} : { session: BOARD_PEOPLE.operator }),
    },
    [chosen, payoutDate, selected],
  );

  const load = useCallback(async () => {
    if (!ensureConsoleApi()) {
      setScreen({ kind: 'config' });
      return;
    }
    setScreen((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      const [batchResponse, approvalResponse, statementResponse, receivableResponse] = await Promise.all([
        ops.listOpsPayoutBatches({ payoutDate, limit: 100 }),
        ops.listOpsApprovalRequests({ status: ['PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'FAILED'], limit: 100 }),
        ops.listOpsSettlements({ payoutDate, limit: 100 }),
        ops.listOpsReceivables({ limit: 100 }),
      ]);
      const nextBatches = (batchResponse.data.items as unknown as Record<string, unknown>[]).map(mapBatch);
      setBatches(nextBatches);
      setApprovals((approvalResponse.data.items as unknown as Record<string, unknown>[]).map(mapApproval));
      setStatements((statementResponse.data.items as unknown as Record<string, unknown>[]).map(mapStatement));
      setReceivables((receivableResponse.data.items as unknown as Record<string, unknown>[]).map(mapReceivable));
      const id = selected && nextBatches.some((b) => b.batchId === selected) ? selected : (nextBatches[0]?.batchId ?? null);
      if (id) {
        setSelected(id);
        const detailResponse = await ops.getOpsPayoutBatch(id);
        setDetail(mapBatchDetail(detailResponse.data as unknown as Record<string, unknown>));
      } else {
        setDetail(null);
      }
      setScreen({ kind: 'ready' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setScreen({ kind: 'forbidden' });
      else setScreen({ kind: 'error', message: problemText(e) });
    }
  }, [payoutDate, selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectBatch = async (batchId: string) => {
    setSelected(batchId);
    const q = new URLSearchParams(sp);
    q.set('date', payoutDate);
    q.set('batch', batchId);
    setSp(q, { replace: true });
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      const res = await ops.getOpsPayoutBatch(batchId);
      setDetail(mapBatchDetail(res.data as unknown as Record<string, unknown>));
    } catch (e) {
      setNotice({ tone: 'bad', text: problemText(e) });
    }
  };

  const changeDate = (date: string) => {
    setPayoutDate(date);
    setSelected(null);
    setDetail(null);
    const q = new URLSearchParams(sp);
    q.set('date', date);
    q.delete('batch');
    setSp(q, { replace: true });
  };

  const requestBatch = async () => {
    if (!write || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      const body: { pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; payoutDate: string; portoneBalance?: { amount: number; observedAt: string } } = {
        pg: form.pg,
        pgStore: form.pgStore,
        payoutDate,
      };
      if (form.pg === 'PORTONE') {
        const amount = Number(form.portoneAmount.replaceAll(',', ''));
        if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('포트원 지급대행 계좌 잔액을 적어 주세요');
        body.portoneBalance = { amount, observedAt: new Date(form.observedAt).toISOString() };
      }
      await ops.createOpsPayoutBatch(body, { headers: { 'Idempotency-Key': newKey() } });
      setRequestOpen(false);
      setNotice({ tone: 'ok', text: '지급 묶음 확인을 요청했습니다. commander가 승인하면 결제사에 지급을 요청합니다.' });
      await load();
    } catch (e) {
      setNotice({ tone: 'bad', text: problemText(e) });
      if (e instanceof ApiError && e.status === 409 && e.type === 'payout-batch-exists') setRequestOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const approveBatch = async (token: string) => {
    if (!selectedApproval || !approve || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      await ops.createOpsApprovalRequestApproval(selectedApproval.approvalId, {}, { headers: { 'x-reauth-token': token } });
      setReauthOpen(false);
      setNotice({ tone: 'ok', text: '지급 묶음을 승인하고 결제사에 지급을 요청했습니다.' });
      await load();
    } catch (e) {
      setReauthOpen(false);
      setNotice({ tone: 'bad', text: problemText(e) });
      if (e instanceof ApiError && e.status === 409) await load();
    } finally {
      setBusy(false);
    }
  };

  const rejectBatch = async () => {
    if (!selectedApproval || !approve || rejectReason.trim() === '' || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      await ops.createOpsApprovalRequestRejection(selectedApproval.approvalId, { reason: rejectReason.trim() });
      setRejectOpen(false);
      setRejectReason('');
      setNotice({ tone: 'ok', text: '지급 묶음을 반려했습니다. 정산서는 다시 확정되어 다음 묶음에 들어갑니다.' });
      await load();
    } catch (e) {
      setNotice({ tone: 'bad', text: problemText(e) });
    } finally {
      setBusy(false);
    }
  };

  const recordPortone = async () => {
    if (!selectedBatch || bulkPayoutId.trim() === '' || !write || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      await ops.createOpsPayoutBatchPortoneExecution(selectedBatch.batchId, { bulkPayoutId: bulkPayoutId.trim() }, { headers: { 'Idempotency-Key': newKey() } });
      setPortoneOpen(false);
      setBulkPayoutId('');
      setNotice({ tone: 'ok', text: '포트원 일괄 지급 실행을 기록했습니다.' });
      await load();
    } catch (e) {
      setNotice({ tone: 'bad', text: problemText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (chosen === 'cs_agent' || chosen === 'cs_lead' || (chosen && !read)) return <NoAccess title={TITLE} role={chosen} who="viewer·operator·commander" />;
  if (screen.kind === 'config') return <section className="widget" role="alert"><div className="widget-body t-sm">관제 API 주소가 설정되지 않아 정산 지급을 부를 수 없습니다. 빌드의 <code>PEAKET_OPS_API_ORIGIN</code>을 확인해 주세요.</div></section>;
  if (screen.kind === 'forbidden') return <NoAccess title={TITLE} role={chosen ?? 'viewer'} who="viewer·operator·commander" />;

  return (
    <ReadOnlyScope on={!!chosen && !write} role={chosen ?? 'viewer'} who="operator·commander">
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>{TITLE}</h1>
          <p className="t-sm muted">지급 묶음은 지급일 전 영업일 09:00에 만들고, 15:00까지 commander가 승인해야 그 지급일에 지급합니다.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <label className="t-sm muted" htmlFor="payout-date">지급일</label>
          <input id="payout-date" className="input input-sm" type="date" value={payoutDate} onChange={(e) => changeDate(e.target.value)} />
          <button className="btn btn-outline" type="button" onClick={() => void load()} disabled={busy}>
            <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
          </button>
          <button className="btn btn-primary" type="button" onClick={() => setRequestOpen(true)} disabled={!canRequest(chosen)} aria-describedby="request-why">
            확인 요청
          </button>
        </div>
      </div>
      <p className="hint" id="request-why">{write ? '확인 요청은 operator·commander가 합니다. 승인은 commander가 재인증 뒤 합니다.' : '확인 요청과 실행 기록은 operator가 합니다.'}</p>

      {notice ? (
        <div className={`banner ${notice.tone === 'ok' ? 'banner-info' : 'banner-danger'}`} role={notice.tone === 'ok' ? 'status' : 'alert'} style={{ marginBottom: 12 }}>
          <div className="banner-body">{notice.text}</div>
        </div>
      ) : null}
      {screen.kind === 'loading' ? <p className="t-sm muted" role="status">정산 지급을 불러오는 중…</p> : null}
      {screen.kind === 'error' ? <p className="t-sm" role="alert">{screen.message}</p> : null}

      <div className="tabs" role="tablist" aria-label="지급일">
        {[payoutDate].map((d) => (
          <button key={d} className="tab is-active" type="button" role="tab" aria-selected="true">
            {formatDateKst(d)}
          </button>
        ))}
        <button className="tab" type="button" role="tab" aria-selected="false" onClick={() => changeDate(todayKst())}>오늘</button>
      </div>

      <div className="grid-12" style={{ rowGap: 16, alignItems: 'start', marginTop: 12 }}>
        <section className="span-8 col" style={{ gap: 16 }}>
          <section className="widget" aria-labelledby="h-batches">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-batches">결제사·결제 상점별 지급 묶음 · {formatDateKst(payoutDate)}</h2>
              <span className="badge">{batches.length}건</span>
            </div>
            <div className="widget-body col" style={{ gap: 10 }}>
              {batches.length === 0 && screen.kind === 'ready' ? (
                <div className="state" role="status" style={{ padding: 32 }}>
                  <h3 className="t-md">오늘 처리할 지급 묶음이 없습니다</h3>
                  <p className="t-sm muted">지급일 탭에서 다른 날을 고르면 그날의 지급 묶음과 정산서를 봅니다.</p>
                </div>
              ) : null}
              {batches.map((b) => {
                const approval = approvals.find((a) => a.targetRef === b.batchId) ?? (b.approvalId ? approvals.find((a) => a.approvalId === b.approvalId) : undefined);
                return (
                  <article
                    key={b.batchId}
                    className={`card${selected === b.batchId ? ' is-selected' : ''}`}
                    style={{ padding: '12px 14px', cursor: 'pointer' }}
                    role="button"
                    tabIndex={0}
                    onClick={() => void selectBatch(b.batchId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void selectBatch(b.batchId);
                      }
                    }}
                    aria-current={selected === b.batchId ? 'true' : undefined}
                  >
                    <div className="row between wrap" style={{ gap: 8 }}>
                      <div className="col" style={{ gap: 2 }}>
                        <h3 className="t-md fw-b">{b.pg === 'TOSS' ? '토스페이먼츠' : '포트원'} {b.pgStore === 'ESCROW' ? '에스크로 상점' : '일반 상점'}</h3>
                        <span className="t-xs muted">지급일 {formatDateKst(b.payoutDate)} · 승인 기한 {formatKst(b.approvalDueAt)}</span>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        <span className={`badge${b.status === 'COMPLETED' ? ' badge-success' : b.status === 'FAILED' || b.status === 'PARTIAL_FAILED' ? ' badge-danger' : ' badge-warning'}`}>{statusLabel(b.status)}</span>
                        <span className="badge badge-outline">{remainingText(approval?.dueAt ?? b.approvalDueAt)}</span>
                      </div>
                    </div>
                    <dl className="kv" style={{ marginTop: 8 }}>
                      <dt>정산서</dt><dd className="num">{b.statementCount}건</dd>
                      <dt>합계</dt><dd className="num">{won(b.totalAmount)}</dd>
                      <dt>승인</dt><dd>{approval ? `${statusLabel(approval.status)} · 요청 ${formatKst(approval.requestedAt)}` : '승인 업무 없음'}</dd>
                      {b.portoneBulkPayoutId ? <><dt>포트원 일괄 지급</dt><dd>{b.portoneBulkPayoutId}</dd></> : null}
                    </dl>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="widget" aria-labelledby="h-statements">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-statements">정산서 · {formatDateKst(payoutDate)} 지급</h2>
              <span className="badge">{statements.length}건</span>
            </div>
            <div className="table-wrap">
              <table className="table dense">
                <caption className="sr-only">지급일의 정산서 목록. 계좌는 은행과 끝 4자리만 보입니다</caption>
                <thead>
                  <tr><th scope="col">종류</th><th scope="col">결제사·상점</th><th scope="col" className="r">거래액</th><th scope="col" className="r">수수료</th><th scope="col" className="r">상계</th><th scope="col" className="r">지급액</th><th scope="col">상태</th><th scope="col">계좌</th></tr>
                </thead>
                <tbody>
                  {statements.map((s) => (
                    <tr key={s.statementId}>
                      <td>{s.kind === 'PRODUCT' ? '상품' : '회차'}</td>
                      <td>{s.pg === 'TOSS' ? '토스' : '포트원'} {s.pgStore === 'ESCROW' ? '에스크로' : '일반'}</td>
                      <td className="r num">{won(s.grossAmount - s.refundAmount)}</td>
                      <td className="r num">{won(s.commissionAmount + s.commissionVat)}</td>
                      <td className="r num">{won(s.offsetAmount)}</td>
                      <td className="r num">{won(s.payoutAmount)}</td>
                      <td><span className={`badge${s.status === 'HELD' ? ' badge-warning' : s.status === 'FAILED' ? ' badge-danger' : ''}`}>{statusLabel(s.status)}{s.holdReason ? ` · ${holdLabel(s.holdReason)}` : ''}</span></td>
                      <td>{s.payoutBankCode ? `${s.payoutBankCode} ****${s.payoutAccountLast4 ?? ''}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </section>

        <aside className="span-4 col" style={{ gap: 16 }}>
          <section className="widget" aria-labelledby="h-detail">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-detail">묶음 상세</h2>
              {selectedApproval ? <span className="badge">{statusLabel(selectedApproval.status)}</span> : null}
            </div>
            <div className="widget-body col" style={{ gap: 10 }}>
              {!detail ? <p className="t-sm muted">왼쪽에서 지급 묶음을 고르세요.</p> : (
                <>
                  <dl className="kv">
                    <dt>요청</dt><dd>{selectedApproval ? `${selectedApproval.requestedBy?.role ?? 'operator'} · ${formatKst(selectedApproval.requestedAt)}` : '—'}</dd>
                    <dt>대상</dt><dd>정산서 {detail.batch.statementCount}건 · {won(detail.batch.totalAmount)}</dd>
                    <dt>보류</dt><dd>{detail.holds.length}건</dd>
                    <dt>필요 승인</dt><dd>commander 1명 · {selectedApproval?.status === 'APPROVED' || selectedApproval?.status === 'EXECUTING' ? '완료' : '아직 없음'}</dd>
                  </dl>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <button className="btn btn-primary btn-sm" type="button" disabled={!approve || !selectedApproval?.canApprove || busy} onClick={() => setReauthOpen(true)} aria-describedby="approve-why">지급 묶음 승인하기</button>
                    <button className="btn btn-outline btn-sm" type="button" disabled={!approve || !selectedApproval?.canApprove || busy} onClick={() => setRejectOpen(true)}>반려하기</button>
                  </div>
                  <p className="hint" id="approve-why">{approve ? (selectedApproval?.canApprove ? '승인 직전에 admin 재인증(비밀번호·인증 앱·패스키)을 받습니다.' : '요청자 본인은 승인할 수 없습니다. 다른 commander가 승인합니다.') : '지급 묶음 승인은 commander가 합니다.'}</p>
                  <hr className="divider" />
                  <h3 className="t-sm fw-b">지급 건</h3>
                  {detail.payouts.length === 0 ? <p className="t-sm muted">아직 지급 건이 없습니다. 승인 뒤 만들어집니다.</p> : (
                    <ul className="col">
                      {detail.payouts.map((p) => (
                        <li key={p.payoutId} className="row between" style={{ gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                          <div className="col" style={{ gap: 2, minWidth: 0 }}>
                            <span className="hash">{p.refPayoutId}</span>
                            <span className="t-xs muted">{p.pgPayoutId ?? '결제사 ID 없음'}{p.errorCode ? ` · ${p.errorCode}` : ''}</span>
                          </div>
                          <div className="col" style={{ gap: 4, alignItems: 'flex-end' }}>
                            <span className="t-sm num">{won(p.amount)}</span>
                            <span className="badge">{statusLabel(p.status)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.batch.pg === 'PORTONE' ? (
                    <div className="row" style={{ gap: 8 }}>
                      <input className="input input-sm" aria-label="포트원 일괄 지급 ID" placeholder="일괄 지급 ID" value={bulkPayoutId} onChange={(e) => setBulkPayoutId(e.target.value)} />
                      <button className="btn btn-secondary btn-sm" type="button" disabled={!write || busy || bulkPayoutId.trim() === ''} onClick={() => setPortoneOpen(true)}>실행 기록 저장하기</button>
                    </div>
                  ) : null}
                  <p className="t-xs muted">지급한 돈은 결제사가 되돌려 주지 않습니다. 합계와 제외 목록을 확인하세요.</p>
                </>
              )}
            </div>
          </section>

          <section className="widget" aria-labelledby="h-holds">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-holds">제외·보류</h2><span className="badge">{detail?.holds.length ?? 0}건</span></div>
            <div className="widget-body col" style={{ gap: 8 }}>
              {detail?.holds.length === 0 ? <p className="t-sm muted">보류된 정산서가 없습니다.</p> : null}
              {detail?.holds.map((s) => (
                <div key={s.statementId} className="card-flat pad col" style={{ gap: 2 }}>
                  <span className="t-sm fw-b">{holdLabel(s.holdReason)}</span>
                  <span className="t-xs">정산서 {s.statementId}</span>
                  <span className="t-xs muted">{won(s.payoutAmount)} · {s.status}</span>
                  {s.holdReason === 'BALANCE' ? <span className="t-xs">잔액이 생긴 뒤 증빙(잔액 확인)으로 다시 확정합니다.</span> : null}
                </div>
              ))}
            </div>
          </section>

          <section className="widget" aria-labelledby="h-kyc">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-kyc">KYC 예고</h2></div>
            <div className="widget-body col" style={{ gap: 8 }}>
              {detail?.kycNotices.filter((k) => k.notice).length === 0 ? <p className="t-sm muted">예고 대상 셀러가 없습니다.</p> : null}
              {detail?.kycNotices.filter((k) => k.notice).map((k) => (
                <div key={k.promoterId} className="banner banner-warning" role="status">
                  <div className="banner-body">
                    <span className="banner-title">KYC 예고</span>
                    {k.promoterId} · {formatDateKst(k.from)}~{formatDateKst(k.to)} 토스 지급 합계 {won(k.amount)} (기준 {won(k.threshold)})
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="widget" aria-labelledby="h-receivables">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-receivables">미수금</h2><span className="actions t-xs muted">상계 → 보증 → 청구</span></div>
            <div className="widget-body col" style={{ gap: 8 }}>
              {receivables.length === 0 ? <p className="t-sm muted">열린 미수금이 없습니다.</p> : null}
              {receivables.slice(0, 8).map((r) => (
                <div key={r.receivableId} className="row between" style={{ gap: 8 }}>
                  <div className="col" style={{ gap: 2 }}>
                    <span className="t-sm">{r.cause}</span>
                    <span className="t-xs muted">{r.promoterId}</span>
                  </div>
                  <div className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
                    <span className="t-sm num">{won(r.remaining)}</span>
                    <span className="badge">{r.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {requestOpen ? (
        <Overlay onClose={() => setRequestOpen(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="request-title" style={{ maxWidth: 520 }}>
            <h2 className="dialog-title" id="request-title">지급 묶음 확인을 요청합니다</h2>
            <div className="field">
              <label className="label" htmlFor="request-pg">결제사</label>
              <select id="request-pg" className="input" value={form.pg} onChange={(e) => setForm((f) => ({ ...f, pg: e.target.value as 'TOSS' | 'PORTONE' }))}>
                <option value="TOSS">토스페이먼츠</option>
                <option value="PORTONE">포트원</option>
              </select>
            </div>
            {form.pg === 'TOSS' ? (
              <div className="field">
                <label className="label" htmlFor="request-store">결제 상점</label>
                <select id="request-store" className="input" value={form.pgStore} onChange={(e) => setForm((f) => ({ ...f, pgStore: e.target.value as 'STANDARD' | 'ESCROW' }))}>
                  <option value="STANDARD">일반</option>
                  <option value="ESCROW">에스크로</option>
                </select>
              </div>
            ) : null}
            {form.pg === 'PORTONE' ? (
              <>
                <div className="field">
                  <label className="label" htmlFor="request-balance">포트원 지급대행 계좌 잔액(원) <span className="opt">(필수)</span></label>
                  <input id="request-balance" className="input" type="text" inputMode="numeric" value={form.portoneAmount} onChange={(e) => setForm((f) => ({ ...f, portoneAmount: e.target.value }))} aria-describedby="request-balance-h" />
                  <span className="hint" id="request-balance-h">포트원 콘솔 &gt; 파트너정산 &gt; 정산 내역 관리 &gt; 내 가상계좌에서 지급대행 계좌를 골라 잔액을 조회한 뒤 적어 주세요.</span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="request-observed">본 시각 <span className="opt">(필수)</span></label>
                  <input id="request-observed" className="input" type="datetime-local" value={form.observedAt} onChange={(e) => setForm((f) => ({ ...f, observedAt: e.target.value }))} />
                </div>
              </>
            ) : null}
            <p className="t-xs muted">적은 잔액은 PEAKET이 검증할 수 없어 지급을 미루는 쪽으로만 씁니다. 입력한 분과 값, 본 시각은 묶음과 감사 로그에 남습니다.</p>
            <div className="dialog-actions">
              <button className="btn btn-outline" type="button" onClick={() => setRequestOpen(false)}>닫기</button>
              <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void requestBatch()}>확인을 요청합니다</button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {rejectOpen ? (
        <Overlay onClose={() => setRejectOpen(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="reject-title" style={{ maxWidth: 480 }}>
            <h2 className="dialog-title" id="reject-title">지급 묶음을 반려합니다</h2>
            <p className="t-sm">반려 사유는 감사 기록에 남습니다. 정산서는 다시 확정되어 다음 묶음에 들어갑니다.</p>
            <div className="field">
              <label className="label" htmlFor="reject-reason">반려 사유 <span className="opt">(필수)</span></label>
              <textarea id="reject-reason" className="input" maxLength={2000} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setRejectOpen(false)}>닫기</button>
              <button className="btn btn-danger" type="button" disabled={busy || rejectReason.trim() === ''} onClick={() => void rejectBatch()}>반려</button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {portoneOpen ? (
        <Overlay onClose={() => setPortoneOpen(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="portone-title" style={{ maxWidth: 480 }}>
            <h2 className="dialog-title" id="portone-title">포트원 일괄 지급 실행을 기록합니다</h2>
            <p className="t-sm">콘솔에서 일괄 지급을 실행한 뒤 일괄 지급 ID를 적어 주세요. 기록하면 30분마다 지급 내역과 대조합니다.</p>
            <dl className="kv"><dt>일괄 지급 ID</dt><dd>{bulkPayoutId}</dd><dt>묶음</dt><dd>{selectedBatch ? `${selectedBatch.batchId} · ${won(selectedBatch.totalAmount)}` : '—'}</dd></dl>
            <div className="dialog-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setPortoneOpen(false)}>닫기</button>
              <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void recordPortone()}>기록하기</button>
            </div>
          </div>
        </Overlay>
      ) : null}

      <ReauthDialog open={reauthOpen} onClose={() => setReauthOpen(false)} onDone={(token) => void approveBatch(token)} />
    </ReadOnlyScope>
  );
}

function problemText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return '권한이 없습니다. 지급 묶음 승인은 commander가 합니다.';
    if (e.type === 'payout-balance-insufficient') return '결제사 잔액이 모자라 지급일을 미룹니다. 정산서는 잔액 부족으로 보류했습니다.';
    if (e.type === 'payout-batch-exists') return '이미 요청한 묶음입니다.';
    if (e.type === 'payout-sale-suspended') return '판매 중지된 공연의 정산서라 지급할 수 없습니다.';
    if (e.type === 'payout-kyc-required') return 'KYC 확인이 끝나지 않아 지급할 수 없습니다.';
    if (e.type === 'payout-account-change-hold') return '정산 계좌 변경 보류 중이라 지급할 수 없습니다.';
    if (e.type === 'payout-account-mismatch') return '예금주가 확인되지 않은 정산 계좌라 지급할 수 없습니다.';
    if (e.type === 'approval-self-not-allowed') return '요청한 분은 승인할 수 없습니다. 다른 commander가 승인합니다.';
    if (e.type === 'approval-role-required') return '지급 묶음 승인은 commander가 합니다.';
    if (e.type === 'reauth-required') return '다시 인증해 주세요.';
    return e.title ?? `요청을 처리하지 못했습니다(${e.status}).`;
  }
  return e instanceof Error ? e.message : '요청을 처리하지 못했습니다.';
}
