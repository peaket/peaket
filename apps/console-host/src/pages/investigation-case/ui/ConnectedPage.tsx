// F-04-15 SCR-071 사건 작업대 운영 연결(동결 로컬, LCH-310).
// 실제 사건·그래프·소명·조치·증거 API만 부르고, IP 원문은 화면 상태에만 둔다.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '@peaket/api-client';
import { ensureConsoleApi } from '@/shared/api';
import {
  actionRequestBody,
  appealDefaults,
  clearanceBody,
  exportBody,
  exportIssue,
  holdChangeBody,
  holdChangeIssue,
  holdEndRequestBody,
  holdEndIssue,
  investigationsProblem,
  lockText,
  mapCaseDetail,
  mapGraph,
  nodeText,
  revealableNodeIds,
  statusText,
  validateActionRequest,
  validateAppealRequest,
  validateClearance,
  validateIpReveal,
  type ActionRequestInput,
  type CaseDetail,
  type GraphView,
} from '../model/investigation-case';

export function ConnectedPage() {
  const { caseId = '' } = useParams();
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [graph, setGraph] = useState<GraphView | null>(null);
  const [bundles, setBundles] = useState<Record<string, unknown>[]>([]);
  const [screen, setScreen] = useState<'loading' | 'ready' | 'forbidden' | 'config' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealReason, setRevealReason] = useState('');
  const [selectedIp, setSelectedIp] = useState<string[]>([]);
  const [memo, setMemo] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    if (!ensureConsoleApi()) {
      setScreen('config');
      return;
    }
    setScreen((s) => (s === 'ready' ? s : 'loading'));
    try {
      const [{ getOpsFraudCase, getOpsFraudCaseGraph, listOpsEvidenceBundles }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      const [d, g] = await Promise.all([getOpsFraudCase(caseId), getOpsFraudCaseGraph(caseId)]);
      const mapped = mapCaseDetail(d.data as unknown as Record<string, unknown>);
      setDetail(mapped);
      setGraph(mapGraph(g.data as unknown as Record<string, unknown>));
      if (mapped.eventId) {
        const b = await listOpsEvidenceBundles({ eventId: mapped.eventId, limit: 100 });
        setBundles((b.data.items as unknown as Record<string, unknown>[]).filter((x) => x.caseId === caseId));
      }
      setScreen('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setScreen('forbidden');
      else {
        setMessage(investigationsProblem(e).message);
        setScreen('error');
      }
    }
  }, [caseId]);

  useEffect(() => {
    void load();
    setRevealed(null);
    return () => setRevealed(null);
  }, [load]);

  const openReveal = async () => {
    const issue = validateIpReveal({ nodeIds: selectedIp, reason: revealReason });
    if (issue) {
      setMessage(issue);
      return;
    }
    try {
      const [{ createOpsFraudCaseIpReveal }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      const r = await createOpsFraudCaseIpReveal(caseId, { nodeIds: selectedIp, reason: revealReason } as never);
      const first = (r.data as unknown as { items?: { ip?: string }[] }).items?.find((x) => x.ip)?.ip ?? null;
      setRevealed(first);
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const requestAppeal = async () => {
    if (!detail) return;
    const defaults = appealDefaults(detail, { nowMs: Date.now(), entryOpensAtMs: null });
    const issue = validateAppealRequest(detail, defaults, { nowMs: Date.now(), entryOpensAtMs: null, cancelDeadlineMs: Date.parse(detail.cancelDeadlineAt) });
    if (issue) {
      setMessage(issue);
      return;
    }
    try {
      const [{ createOpsFraudCaseAppealRequest }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      await createOpsFraudCaseAppealRequest(caseId, { accountIds: defaults.accountIds, reasonCategories: defaults.reasonCategories, dueAt: defaults.dueAt } as never, { headers: { 'idempotency-key': crypto.randomUUID() } } as never);
      await load();
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const requestAction = async () => {
    if (!detail) return;
    const input: ActionRequestInput = { fraudAction: 'CANCEL_TICKETS', accountIds: detail.members.filter((m) => !m.removed).map((m) => m.accountId), reason };
    const issue = validateActionRequest(detail, input, { nowMs: Date.now(), cancelDeadlineMs: Date.parse(detail.cancelDeadlineAt) });
    if (issue) {
      setMessage(issue);
      return;
    }
    try {
      const [{ createOpsFraudCaseActionRequest }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      await createOpsFraudCaseActionRequest(caseId, actionRequestBody(input) as never, { headers: { 'idempotency-key': crypto.randomUUID() } } as never);
      await load();
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const closeCase = async () => {
    const issue = validateClearance({ reason, outcomeLabel: 'HUMAN' });
    if (issue) {
      setMessage(issue);
      return;
    }
    try {
      const [{ createOpsFraudCaseClearance }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      await createOpsFraudCaseClearance(caseId, clearanceBody({ reason, outcomeLabel: 'HUMAN' }) as never, { headers: { 'if-match': `"${detail?.version ?? 1}"`, 'idempotency-key': crypto.randomUUID() } } as never);
      await load();
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const makeBundle = async () => {
    try {
      const [{ createOpsFraudCaseEvidenceBundle }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      await createOpsFraudCaseEvidenceBundle(caseId, { reason: reason || '사건 조치 근거' } as never, { headers: { 'idempotency-key': crypto.randomUUID() } } as never);
      await load();
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const openBundle = async (bundleId: string) => {
    try {
      const [{ getOpsEvidenceBundle }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      await getOpsEvidenceBundle(bundleId);
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const exportBundle = async (bundleId: string, kind: 'AUTHORITY' | 'PROMOTER' | 'COMPLAINT') => {
    const issue = exportIssue(kind, reason, kind === 'AUTHORITY' ? memo : undefined);
    if (issue) {
      setMessage(issue);
      return;
    }
    try {
      const [{ createOpsEvidenceBundleExport }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      await createOpsEvidenceBundleExport(bundleId, exportBody(kind, reason, kind === 'AUTHORITY' ? memo : undefined) as never, { headers: { 'idempotency-key': crypto.randomUUID() } } as never);
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const changeHold = async (bundleId: string) => {
    const issue = holdChangeIssue({ holdReason: 'OBJECTION', status: 'SEALED' }, 'DISPUTE', memo);
    if (issue) {
      setMessage(issue);
      return;
    }
    try {
      const [{ createOpsEvidenceBundleHoldChange }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      await createOpsEvidenceBundleHoldChange(bundleId, holdChangeBody('DISPUTE', memo) as never, { headers: { 'idempotency-key': crypto.randomUUID() } } as never);
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const requestHoldEnd = async (bundleId: string) => {
    const issue = holdEndIssue({ holdReason: 'DISPUTE', status: 'SEALED', holdEndRequest: null }, memo);
    if (issue) {
      setMessage(issue);
      return;
    }
    try {
      const [{ createOpsEvidenceBundleHoldEndRequest }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      await createOpsEvidenceBundleHoldEndRequest(bundleId, holdEndRequestBody(memo) as never, { headers: { 'idempotency-key': crypto.randomUUID() } } as never);
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  if (screen === 'config') return <p className="state">관제 API 주소가 설정되지 않았습니다.</p>;
  if (screen === 'forbidden') return <p className="state">권한 없음(지정 없음)</p>;
  if (screen === 'loading') return <p className="state">불러오는 중입니다</p>;
  if (!detail) return <p className="state">{message || '사건을 찾을 수 없습니다'}</p>;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="page-head">
        <h1>사건 작업대</h1>
        <p className="t-sm">{detail.caseId} · {statusText(detail.status)} · {detail.reasonCategory}</p>
        {detail.transferLocked ? <p className="banner banner-warning">양도 잠금 · {lockText(detail.members[0]?.lockExpiresAt ?? null, true)}</p> : null}
      </div>
      {message ? <p className="banner banner-warning" role="alert">{message}</p> : null}
      <section className="widget">
        <h2 className="t-sm fw-b">묶음 요약</h2>
        <p>{detail.accountCount}계정 · {detail.ticketCount}장 · 소명 {detail.appealOutcome}</p>
        <p className="t-sm muted">{detail.investigatorOpinion ?? '조사관 의견 없음'}</p>
      </section>
      <section className="widget">
        <h2 className="t-sm fw-b">연결 그래프</h2>
        <p className="t-sm">{graph ? `${graph.nodes.length}개 점${graph.truncated ? ' · 묶음을 나눠 보세요' : ''}` : '없음'}</p>
        <ul className="col" style={{ gap: 4 }}>
          {(graph?.nodes ?? []).filter((n) => n.kind === 'IP').map((n) => (
            <li key={n.nodeId} className="row" style={{ gap: 8 }}>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setSelectedIp((xs) => (xs.includes(n.nodeId) ? xs.filter((x) => x !== n.nodeId) : [...xs, n.nodeId]))}>{nodeText(n)}</button>
            </li>
          ))}
        </ul>
        {revealed ? (
          <p className="row" style={{ gap: 8 }}>
            <span className="mono">{revealed}</span>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRevealed(null)}>원문 숨기기</button>
          </p>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            <input className="input" value={revealReason} onChange={(e) => setRevealReason(e.target.value)} placeholder="IP 원문을 여는 사유" aria-label="IP 원문 사유" />
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void openReveal()}>IP 원문 열기</button>
          </div>
        )}
      </section>
      <section className="widget">
        <h2 className="t-sm fw-b">소명·조치</h2>
        <div className="col" style={{ gap: 8 }}>
          <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="메모·사유" />
          <button className="btn btn-secondary" type="button" onClick={() => void requestAppeal()}>소명 요청</button>
          <button className="btn btn-secondary" type="button" onClick={() => void requestAction()}>조치 요청</button>
          <button className="btn btn-outline" type="button" onClick={() => void closeCase()}>정상 종료</button>
          <p className="t-xs muted">{revealableNodeIds(graph ?? { nodes: [], edges: [], truncated: false }).length}개 IP 점 · 사유 {reason.length}자</p>
        </div>
      </section>
      <section className="widget">
        <h2 className="t-sm fw-b">증거 묶음</h2>
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => void makeBundle()}>증거 묶음 만들기</button>
        <ul className="col" style={{ gap: 8 }}>
          {bundles.map((b) => (
            <li key={String(b.bundleId)} className="card-flat pad col" style={{ gap: 6 }}>
              <span className="mono t-xs">{String(b.bundleId)} · {String(b.status)} · {String(b.holdReason)}</span>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => void openBundle(String(b.bundleId))}>묶음 열기</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => void exportBundle(String(b.bundleId), 'COMPLAINT')}>고소·고발용 요약</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => void changeHold(String(b.bundleId))}>보존 이유 바꾸기</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => void requestHoldEnd(String(b.bundleId))}>보존 끝 요청</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
