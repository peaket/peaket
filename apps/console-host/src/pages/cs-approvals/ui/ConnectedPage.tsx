// F-04-15 SCR-046 부정 예매 조치 승인 운영 연결(동결 로컬, LCH-310).
// 승인 상세의 fraudCaseSummary만 읽고, 서버 canApprove를 덮지 않는다.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError } from '@peaket/api-client';
import { ensureConsoleApi } from '@/shared/api';
import { approvalReasonError, approveBlockReason, exclusionIssues, fraudApprovalBody, fraudApprovalProblem, mapFraudSummary, summaryTargets, type FraudSummary } from '../model/fraud-summary';

export function ConnectedPage() {
  const [sp] = useSearchParams();
  const approvalId = sp.get('approvalId') ?? '';
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [summary, setSummary] = useState<FraudSummary | null>(null);
  const [screen, setScreen] = useState<'loading' | 'ready' | 'forbidden' | 'config' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [excluded, setExcluded] = useState<string[]>([]);
  const [reauth, setReauth] = useState('');
  const [me, setMe] = useState<{ accountId: string; role: string; designations: string[] } | null>(null);

  const load = useCallback(async () => {
    if (!ensureConsoleApi()) {
      setScreen('config');
      return;
    }
    setScreen((s) => (s === 'ready' ? s : 'loading'));
    try {
      const [{ listOpsApprovalRequests, getOpsApprovalRequest, getMyOpsAuthSession }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const session = (await getMyOpsAuthSession()).data as unknown as { adminAccountId?: string; role?: string; designations?: string[] };
      setMe({
        accountId: typeof session.adminAccountId === 'string' ? session.adminAccountId : '',
        role: typeof session.role === 'string' ? session.role : '',
        designations: Array.isArray(session.designations) ? session.designations.map(String) : [],
      });
      const list = await listOpsApprovalRequests({ status: ['PENDING_APPROVAL'], limit: 100 });
      setItems(list.data.items as unknown as Record<string, unknown>[]);
      if (approvalId) {
        const d = await getOpsApprovalRequest(approvalId);
        const raw = d.data as unknown as Record<string, unknown>;
        setDetail(raw);
        setSummary(mapFraudSummary((raw.fraudCaseSummary ?? {}) as Record<string, unknown>));
      }
      setScreen('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setScreen('forbidden');
      else {
        setMessage(fraudApprovalProblem(e).message);
        setScreen('error');
      }
    }
  }, [approvalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const block = summary
    ? approveBlockReason({
        summary,
        status: String(detail?.status ?? ''),
        canApprove: detail?.canApprove === true,
        requesterId: String((detail?.requestedBy as { adminAccountId?: string } | undefined)?.adminAccountId ?? ''),
        meId: me?.accountId ?? '',
        role: me?.role ?? '',
        designations: me?.designations ?? [],
        summaryViewedAt: typeof detail?.summaryViewedAt === 'string' ? detail.summaryViewedAt : null,
      })
    : '사건 요약이 아직 실리지 않았습니다';

  const approve = async () => {
    const issue = block ?? approvalReasonError(reason) ?? (summary ? exclusionIssues(summary, excluded) : undefined);
    if (issue) {
      setMessage(issue);
      return;
    }
    if (!summary) return;
    try {
      const [{ createOpsApprovalRequestApproval }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      await createOpsApprovalRequestApproval(approvalId, fraudApprovalBody(summary, { reason, excludedLabels: excluded }) as never, { headers: { 'x-reauth-token': reauth, 'idempotency-key': crypto.randomUUID() } } as never);
      await load();
    } catch (e) {
      setMessage(fraudApprovalProblem(e).message);
    }
  };

  const reject = async () => {
    const issue = approvalReasonError(reason);
    if (issue) {
      setMessage(issue);
      return;
    }
    try {
      const [{ createOpsApprovalRequestRejection }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      await createOpsApprovalRequestRejection(approvalId, { reason } as never, { headers: { 'x-reauth-token': reauth, 'idempotency-key': crypto.randomUUID() } } as never);
      await load();
    } catch (e) {
      setMessage(fraudApprovalProblem(e).message);
    }
  };

  if (screen === 'config') return <p className="state">관제 API 주소가 설정되지 않았습니다.</p>;
  if (screen === 'forbidden') return <p className="state">권한 없음</p>;
  if (screen === 'loading') return <p className="state">불러오는 중입니다</p>;

  return (
    <div className="col" style={{ gap: 16 }}>
      <h1>승인 업무</h1>
      {message ? <p className="banner banner-warning" role="alert">{message}</p> : null}
      <ul className="col" style={{ gap: 8 }}>
        {items.map((r) => <li key={String(r.approvalId)} className="card-flat pad">{String(r.approvalId)} · {String(r.status)}</li>)}
      </ul>
      {summary ? (
        <section className="widget">
          <h2 className="t-sm fw-b">사건 요약</h2>
          <p>{summary.reasonCategory} · {summary.accountCount}계정 · 대상 표 {summary.ticketCount}장</p>
          <p>구매 {summary.purchaseCount} / 한도 {summary.limitPerPerson} · {summary.scoreBand} · {summary.appealOutcome}</p>
          <p>공유 속성 {summary.sharedAttributes.join('·') || '없음'} · 근거 {summary.signals.join('·') || '없음'}</p>
          <p>소명 인정 {summary.appealCounts.accepted} · 불인정 {summary.appealCounts.rejected} · 기한 경과 {summary.appealCounts.expired}</p>
          <p>조사관 의견 {summary.investigatorOpinion ?? '없음'} · 취소 마감 {summary.cancelDeadlineAt}</p>
          <p className="mono t-xs">고정 판 {summary.snapshotHash}</p>
          <ul className="col" style={{ gap: 4 }}>
            {summaryTargets(summary).map((t) => (
              <li key={t.accountId}><label className="check-row"><input className="cb" type="checkbox" checked={excluded.includes(t.label)} onChange={(e) => setExcluded((xs) => e.target.checked ? [...xs, t.label] : xs.filter((x) => x !== t.label))} />{t.label} · {t.appealOutcome}</label></li>
            ))}
          </ul>
          <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="판단 이유" />
          <input className="input" value={reauth} onChange={(e) => setReauth(e.target.value)} placeholder="재인증 토큰" aria-label="재인증 토큰" />
          {block ? <p className="t-sm tx-danger">{block}</p> : null}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary" type="button" disabled={block !== undefined} onClick={() => void approve()}>승인</button>
            <button className="btn btn-secondary" type="button" onClick={() => void reject()}>반려</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
