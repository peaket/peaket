// SCR-046 승인 업무 연결 화면(F-06-3 GAT-290·GAT-300, d5 §7.7, transfer-refund §7.2).
// 생성 클라이언트의 목록·상세·승인·반려·철회·세션 읽기만 쓴다. 승인 값은 브라우저 저장소에 남기지 않는다.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { ensureConsoleApi } from '@/shared/api';
import { approvalPageOf, approvalViewOf, canAct, errorOf, evidenceOf, ifMatchOf, quorumLabel, type Actor, type ApprovalView } from '../model/live';
import { ApprovalCard } from './cards';

const ops = () => import('@peaket/api-client/endpoints/ops');
const problemOf = (e: unknown): unknown => (typeof e === 'object' && e !== null && 'problem' in e ? (e as { problem?: unknown }).problem : e);

export function ConnectedPage() {
  const { approvalId } = useParams();
  const [items, setItems] = useState<ApprovalView[]>([]);
  const [view, setView] = useState<ApprovalView | null>(null);
  const [actor, setActor] = useState<Actor | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const version = view?.version ?? null;

  const load = useCallback(async () => {
    if (!ensureConsoleApi()) {
      setNotice({ tone: 'bad', text: '운영 API 주소가 없습니다' });
      return;
    }
    try {
      const { getMyOpsAuthSession } = await ops();
      const session = await getMyOpsAuthSession();
      const me = session.data as { adminAccountId?: string; role?: string };
      setActor(me.adminAccountId && me.role ? { accountId: me.adminAccountId, role: me.role } : null);
      if (approvalId) {
        const { getOpsApprovalRequest } = await ops();
        const one = await getOpsApprovalRequest(approvalId);
        setView(approvalViewOf(one.data));
      } else {
        const { listOpsApprovalRequests } = await ops();
        const page = await listOpsApprovalRequests({ limit: 100 });
        setItems(approvalPageOf(page.data).items);
      }
    } catch (e) {
      setNotice({ tone: 'bad', text: errorOf(problemOf(e), 0).text });
    }
  }, [approvalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const permissions = useMemo(() => (view && actor ? canAct(view, actor) : { approve: false, reject: false, withdraw: false }), [view, actor]);

  const approve = async () => {
    if (!view) return;
    const a = canAct(view, actor ?? { accountId: '', role: '' });
    if (!a.approve) return;
    if (busy) return;
    setBusy(true);
    try {
      const { createOpsApprovalRequestApproval } = await ops();
      const out = await createOpsApprovalRequestApproval(view.approvalId, { ...(reason.trim() ? { reason: reason.slice(0, 1000) } : {}) }, { headers: { 'If-Match': ifMatchOf(version), 'X-Reauth-Token': token } as HeadersInit });
      setView(approvalViewOf(out.data));
      setNotice({ tone: 'ok', text: '승인했습니다' });
    } catch (e) {
      setNotice({ tone: 'bad', text: errorOf(problemOf(e), 0).text });
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!view) return;
    const a = canAct(view, actor ?? { accountId: '', role: '' });
    if (!a.reject) return;
    if (busy) return;
    if (!reason.trim()) {
      setNotice({ tone: 'bad', text: '반려 사유를 적어 주세요' });
      return;
    }
    setBusy(true);
    try {
      const { createOpsApprovalRequestRejection } = await ops();
      const out = await createOpsApprovalRequestRejection(view.approvalId, { reason: reason.slice(0, 2000) }, { headers: { 'If-Match': ifMatchOf(version), 'X-Reauth-Token': token } as HeadersInit });
      setView(approvalViewOf(out.data));
      setNotice({ tone: 'ok', text: '반려했습니다' });
    } catch (e) {
      setNotice({ tone: 'bad', text: errorOf(problemOf(e), 0).text });
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (!view) return;
    const a = canAct(view, actor ?? { accountId: '', role: '' });
    if (!a.withdraw) return;
    if (busy) return;
    if (!reason.trim()) {
      setNotice({ tone: 'bad', text: '철회 사유를 적어 주세요' });
      return;
    }
    setBusy(true);
    try {
      const { createOpsApprovalRequestWithdrawal } = await ops();
      const out = await createOpsApprovalRequestWithdrawal(view.approvalId, { reason: reason.slice(0, 2000) }, { headers: { 'If-Match': ifMatchOf(version) } as HeadersInit });
      setView(approvalViewOf(out.data));
      setNotice({ tone: 'ok', text: '철회했습니다' });
    } catch (e) {
      setNotice({ tone: 'bad', text: errorOf(problemOf(e), 0).text });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="cs-approvals">
      <h1>승인 업무</h1>
      {notice ? <p role="status">{notice.text}</p> : null}
      {view ? (
        <>
          <p>{quorumLabel(view.requiredApprovals)}</p>
          <p>{evidenceOf(view)}</p>
          <ApprovalCard view={view} />
          <label>
            사유
            <textarea maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value.slice(0, 2000))} />
          </label>
          <label>
            재인증 토큰
            <input value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <button type="button" disabled={busy || !permissions.approve} onClick={() => void approve()}>
            승인
          </button>
          <button type="button" disabled={busy || !permissions.reject} onClick={() => void reject()}>
            반려
          </button>
          <button type="button" disabled={busy || !permissions.withdraw} onClick={() => void withdraw()}>
            철회
          </button>
        </>
      ) : (
        <ul>
          {items.map((row) => (
            <li key={row.approvalId}>
              <a href={`/cs/approvals/${row.approvalId}`}>{row.approvalId}</a>
              <ApprovalCard view={row} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
