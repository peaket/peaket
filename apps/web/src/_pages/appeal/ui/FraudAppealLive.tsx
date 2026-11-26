'use client';
// F-04-15 SCR-042 부정 예매 소명 운영 화면(동결 로컬, LCH-310).
// GET /v1/fraud-appeal-requests로 자기 요청을 찾고, POST /v1/appeals(kind FRAUD_CASE)로 낸다.
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ensureBrowserApi } from '@/shared/api';
import {
  appealContentError,
  canSeeReasonCategories,
  createFraudAppealBody,
  fraudAppealProblem,
  fraudDeadlineText,
  holderTicketText,
  mapFraudLive,
  priorityPurchaseRows,
  submissionOf,
  type FraudLiveView,
} from '../model/fraud-live';

export function FraudAppealLive({ caseId }: { caseId: string }) {
  const [view, setView] = useState<FraudLiveView | null>(null);
  const [text, setText] = useState('');
  const [screen, setScreen] = useState<'loading' | 'ready' | 'login' | 'missing' | 'error'>('loading');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    if (!ensureBrowserApi()) {
      setScreen('error');
      setMessage('지금은 소명을 볼 수 없습니다');
      return;
    }
    try {
      const [{ listFraudAppealRequests }] = await Promise.all([import('@peaket/api-client/endpoints/support')]);
      const r = await listFraudAppealRequests({ limit: 100 });
      const found = (r.data.items as unknown as Record<string, unknown>[]).find((x) => x.caseId === caseId);
      if (!found) {
        setScreen('missing');
        return;
      }
      setView(mapFraudLive(found, Date.now()));
      setScreen('ready');
    } catch (e) {
      const p = fraudAppealProblem(e);
      if (p.kind === 'auth') setScreen('login');
      else {
        setMessage(p.message);
        setScreen('error');
      }
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (!view) return;
    const issue = appealContentError(text);
    if (issue) {
      setMessage(issue);
      return;
    }
    try {
      const [{ createAppeal }] = await Promise.all([import('@peaket/api-client/endpoints/support')]);
      await createAppeal(createFraudAppealBody(view, text) as never, { headers: { 'idempotency-key': crypto.randomUUID() } } as never);
      setText('');
      await load();
    } catch (e) {
      setMessage(fraudAppealProblem(e).message);
    }
  };

  if (screen === 'login') return <p className="state">로그인한 뒤 다시 시도해 주세요. <Link href="/login">로그인</Link></p>;
  if (screen === 'missing') return <p className="state">내 소명 요청이 아닙니다.</p>;
  if (screen === 'error') return <p className="state">{message || '소명을 불러오지 못했습니다'}</p>;
  if (screen === 'loading' || !view) return <p className="state">불러오는 중입니다</p>;

  const sub = submissionOf(view, Date.now());
  const reasons = canSeeReasonCategories(view);
  const priority = priorityPurchaseRows(view);

  return (
    <div className="col" style={{ gap: 20 }}>
      <header className="col" style={{ gap: 4 }}>
        <h1 className="t-xl">부정 예매 소명</h1>
        <p className="t-sm muted">{view.party === 'HOLDER' ? '결제자의 부정 예매 조사에 포함된 표입니다. 정당하게 받으셨다면 사정을 알려 주세요.' : '사유 범주와 기한을 확인하고 소명해 주세요.'}</p>
      </header>
      {message ? <p className="banner banner-warning" role="alert">{message}</p> : null}
      <section className="widget">
        <h2 className="t-sm fw-b">내 요청</h2>
        <p>{fraudDeadlineText(view)} · 상태 {view.status}</p>
        {reasons ? <p>사유 범주 {view.reasonCategories.join('·')}</p> : null}
        {view.party === 'HOLDER' ? <p>{holderTicketText(view)} · {view.heldTicketIds.join(', ')}</p> : <p>잠긴 표 {view.lockedTicketIds.length}매 · {view.lockActive ? '양도 잠금' : '잠금 풀림'}</p>}
        {view.actionResult ? <p>취소된 표 {view.actionResult.cancelledTicketIds.length}매{view.actionResult.restrictedUntilMs ? ` · 이용 제한 ${new Date(view.actionResult.restrictedUntilMs).toLocaleDateString('ko-KR')}까지` : ''}</p> : null}
        {view.objectionNote ? <p>이의 결과 이유 {view.objectionNote}</p> : null}
      </section>
      {priority.length > 0 ? (
        <section className="widget">
          <h2 className="t-sm fw-b">우선 구매</h2>
          <ul>{priority.map((p) => <li key={p.seatLabel}>{p.seatLabel} · {p.priceText} · {p.deadlineText}</li>)}</ul>
        </section>
      ) : null}
      <section className="widget">
        <h2 className="t-sm fw-b">소명 내용</h2>
        {sub.allowed ? (
          <div className="col" style={{ gap: 8 }}>
            <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} aria-label="소명 내용" />
            <span className="t-xs muted">{Array.from(text.trim()).length} / 2,000자</span>
            <button className="btn btn-primary" type="button" onClick={() => void submit()}>소명 제출</button>
          </div>
        ) : <p className="t-sm muted">지금은 소명을 낼 수 없습니다({sub.reason ?? '상태 확인'}).</p>}
      </section>
      <p className="t-sm"><Link href="/my/tickets">마이 티켓</Link></p>
    </div>
  );
}
