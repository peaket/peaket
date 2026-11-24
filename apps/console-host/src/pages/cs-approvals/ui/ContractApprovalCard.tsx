// SCR-046 계약 조건 변경 승인 카드(F-07-2, d5 §7.7·§7.13, settlement §9·§10).
// 실제 API가 있으면 CONTRACT_TERMS_CHANGE 대기 요청을 읽어 현재 값↔바꿀 값을 보이고, 요청자가 아닌 commander가 재인증 뒤 승인·반려한다.
// 목업 보드(SCR-046-d·t·m)는 그대로 두고, 이 카드는 그 위에 실제 대기 요청만 덧붙인다. 대기 요청이 없으면 아무것도 그리지 않는다.
import { useCallback, useEffect, useState } from 'react';
import type { ApprovalRequest } from '@peaket/api-client/model';
import { ReauthDialog } from '@/features/admin-reauth/ReauthDialog';
import { ensureConsoleApi, opsApiAvailable } from '@/shared/api';
import { approvalBodyOf, approvalEligibility, approvalMetaOf, contractApprovalProblemMessage, contractRowsOf, isContractApproval, rejectionBodyOf } from '../model/contract-approval';

type Load = { kind: 'loading' } | { kind: 'ready'; items: ApprovalRequest[] } | { kind: 'config' } | { kind: 'error'; message: string };

export function ContractApprovalCard() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [reason, setReason] = useState('');

  const refresh = useCallback(async () => {
    if (!ensureConsoleApi() || !opsApiAvailable()) {
      setLoad({ kind: 'config' });
      return;
    }
    setLoad({ kind: 'loading' });
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      const res = await ops.listOpsApprovalRequests({ kind: ['CONTRACT_TERMS_CHANGE'], status: ['PENDING_APPROVAL'], limit: 100 });
      const items = (res.data.items as ApprovalRequest[] | undefined)?.filter(isContractApproval) ?? [];
      setLoad({ kind: 'ready', items });
      setSelectedId((prev) => (prev && items.some((a) => a.approvalId === prev) ? prev : (items[0]?.approvalId ?? null)));
    } catch (e) {
      setLoad({ kind: 'error', message: contractApprovalProblemMessage(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 프리뷰·설정 없음·오류·빈 목록은 이 카드가 할 일이 없다(보드 화면을 방해하지 않는다)
  if (load.kind === 'config' || load.kind === 'error' || load.kind === 'loading') return null;
  if (load.items.length === 0) return null;

  const selected = load.items.find((a) => a.approvalId === selectedId) ?? load.items[0]!;
  const terms = selected.contractTerms;
  if (!terms) return null;
  const rows = contractRowsOf(terms);
  // 화면의 역할을 고른 프리뷰가 있으면 그 역할로, 없으면 서버 판정(canApprove)을 따른다
  const eligibility = approvalEligibility(selected, { accountId: selected.requestedBy?.adminAccountId ?? '', role: 'commander' });
  const canApprove = selected.canApprove !== false && eligibility.canApprove;

  const approve = async (token: string) => {
    if (!selected.approvalId || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      await ops.createOpsApprovalRequestApproval(selected.approvalId, approvalBodyOf(reason), { headers: { 'x-reauth-token': token } });
      setReauthOpen(false);
      setReason('');
      setNotice({ tone: 'ok', text: '계약 조건 변경을 승인했습니다. 승인 뒤 판매 승인을 받는 공연부터 바뀐 값이 적용됩니다.' });
      await refresh();
    } catch (e) {
      setReauthOpen(false);
      setNotice({ tone: 'bad', text: contractApprovalProblemMessage(e) });
      if ((e as { status?: number }).status === 409) await refresh();
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    const body = rejectionBodyOf(rejectReason);
    if (!selected.approvalId || busy || !body) return;
    setBusy(true);
    setNotice(null);
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      await ops.createOpsApprovalRequestRejection(selected.approvalId, body);
      setRejectOpen(false);
      setRejectReason('');
      setNotice({ tone: 'ok', text: '계약 조건 변경을 반려했습니다. 지금 값은 그대로입니다.' });
      await refresh();
    } catch (e) {
      setNotice({ tone: 'bad', text: contractApprovalProblemMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="widget" role="region" aria-labelledby="h-contract-approval" style={{ marginBottom: 16 }}>
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="h-contract-approval">
          계약 조건 변경 승인
        </h2>
        <span className="badge badge-warning">대기 {load.items.length}건</span>
      </div>
      <div className="widget-body col" style={{ gap: 14 }}>
        {load.items.length > 1 ? (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }} role="tablist" aria-label="계약 변경 요청">
            {load.items.map((a) => (
              <button
                key={a.approvalId}
                type="button"
                role="tab"
                aria-selected={a.approvalId === selected.approvalId}
                className={`tab ${a.approvalId === selected.approvalId ? 'is-active' : ''}`}
                onClick={() => setSelectedId(a.approvalId ?? null)}
              >
                {a.targetRef ?? '파트너사'} · {a.approvalId}
              </button>
            ))}
          </div>
        ) : null}

        <div className="col" style={{ gap: 4 }}>
          <p className="t-sm fw-b">파트너사 {selected.targetRef ?? '-'}</p>
          <p className="t-xs muted">{approvalMetaOf(selected)}</p>
          {selected.reasonText ? <p className="t-sm">요청 사유: {selected.reasonText}</p> : null}
        </div>

        <table className="table">
          <thead>
            <tr>
              <th scope="col">항목</th>
              <th scope="col">지금 값</th>
              <th scope="col">바꿀 값</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td>{r.current}</td>
                <td className={r.changed ? 'fw-b' : 'muted'}>{r.changed ? r.requested : '그대로'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="banner banner-info">
          <div className="banner-body">수수료율·보증 변경은 operator가 요청하고 요청자가 아닌 commander가 재인증 뒤 승인합니다(2인). 바뀐 값은 승인 뒤 판매 승인을 받는 공연부터 쓰고, 판매 승인 때 회차에 고정됩니다.</div>
        </div>

        {selected.canApprove === false ? <p className="t-sm muted">요청한 분은 승인할 수 없습니다. 다른 commander가 승인해야 합니다.</p> : null}

        <label className="field">
          <span className="label">승인 판단 이유(선택, 1~1,000자)</span>
          <input className="input" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </label>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-outline" type="button" onClick={() => setRejectOpen((v) => !v)} disabled={busy || !canApprove}>
            반려
          </button>
          <button className="btn btn-primary" type="button" onClick={() => setReauthOpen(true)} disabled={busy || !canApprove} aria-describedby={canApprove ? undefined : 'contract-approval-blocked'}>
            승인
          </button>
        </div>
        {canApprove ? null : <p id="contract-approval-blocked" className="t-xs muted">{eligibility.reason ?? '이 요청은 지금 계정으로 승인할 수 없습니다.'}</p>}

        {rejectOpen ? (
          <section className="card-flat col" style={{ gap: 10, padding: 14 }} aria-labelledby="h-contract-reject">
            <h3 className="t-sm fw-b" id="h-contract-reject">반려 사유(필수)</h3>
            <textarea className="input" rows={3} value={rejectReason} maxLength={1000} onChange={(e) => setRejectReason(e.target.value)} />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-outline" type="button" onClick={() => setRejectOpen(false)}>
                취소
              </button>
              <button className="btn btn-danger-outline" type="button" onClick={() => void reject()} disabled={busy || rejectionBodyOf(rejectReason) === undefined}>
                반려합니다
              </button>
            </div>
          </section>
        ) : null}

        {notice ? (
          <div className={notice.tone === 'ok' ? 'banner banner-success' : 'banner banner-warning'} role="status">
            <div className="banner-body">{notice.text}</div>
          </div>
        ) : null}
      </div>

      <ReauthDialog open={reauthOpen} onClose={() => setReauthOpen(false)} onDone={(token) => void approve(token)} />
    </section>
  );
}
