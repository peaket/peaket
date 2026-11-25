// SCR-032 접속기록 점검(FR-064, d5 §7.5). 월 점검 완료·이상 건 사유·사후조치, 데모 환경의 자기 점검(시연)을 보인다.
import { useState } from 'react';
import { actionAvailability, FINDING_ACTION_LABELS, FINDING_ACTIONS, type ComplianceLayout, type ComplianceRole } from '../../model/compliance';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function AccessReviewPanel({
  role,
  layout,
  demo,
  review,
  findings,
  busy,
  onComplete,
  onResolve,
}: {
  role: ComplianceRole;
  layout: ComplianceLayout;
  demo: boolean;
  review: Record<string, unknown>;
  findings: readonly Record<string, unknown>[];
  busy: boolean;
  onComplete: () => void;
  onResolve: (findingId: string, d: { reason: string; action: string }) => void;
}) {
  const a = actionAvailability({ role, tab: 'access-reviews', layout, view: 'FULL', detail: findings[0] ?? {}, demo });
  const [reason, setReason] = useState('');
  const [action, setAction] = useState('NONE');
  const phone = layout === 'phone';
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <div className="col" style={{ gap: 2 }}>
          <h3 className="t-md fw-b">접속기록 정기 점검 {text(review.period)}</h3>
          <span className="t-xs muted">점검자 commander · 자기 기록은 다른 commander가 점검합니다</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {demo ? <span className="badge">데모 환경</span> : null}
          <span className={`badge${text(review.state) === 'COMPLETED' ? ' badge-success' : ' badge-warning'}`}>{text(review.state) === 'COMPLETED' ? '완료' : '진행 중'}</span>
        </div>
      </div>
      <div className="row between wrap" style={{ gap: 8 }}>
        <p className="t-sm muted">이번 달 점검을 마치면 완료를 기록합니다. 이상 건은 사유 확인과 사후조치를 기록할 때까지 미조치로 남습니다.</p>
        <button className="btn btn-primary" type="button" disabled={!a.completeReview.enabled || busy} aria-disabled={!a.completeReview.enabled} title={a.completeReview.reason} onClick={onComplete}>
          월 정기 점검 완료
        </button>
      </div>
      {!a.completeReview.enabled && a.completeReview.reason ? <p className="hint">{a.completeReview.reason}</p> : null}
      <div className="col" style={{ gap: 8 }}>
        <h4 className="eyebrow">자동 탐지 이상 건</h4>
        {findings.length === 0 ? <p className="t-sm muted">이번 달 이상 건이 없습니다.</p> : null}
        {findings.map((f) => {
          const id = text(f.findingId);
          const self = f.self === true;
          const canSelf = self && demo && a.selfResolve.enabled;
          const canResolve = !self || demo ? a.resolveFinding.enabled : false;
          return (
            <div key={id} className="card-flat pad col" style={{ gap: 6 }}>
              <div className="row between wrap" style={{ gap: 6 }}>
                <span className="t-sm">{text(f.kind) || '이상 건'} · {text(f.accountRef) || '계정 가림'} · {text(f.detectedAt) || '—'}</span>
                <span className="row" style={{ gap: 4 }}>
                  <span className="badge">{text(f.state) || '열림'}</span>
                  {self ? <span className="badge badge-warning">본인</span> : null}
                  {self && demo && text(f.state) === 'RESOLVED' ? <span className="badge badge-success">자기 점검(시연)</span> : null}
                </span>
              </div>
              {self && !demo ? <p className="hint">본인 접속기록은 다른 commander가 점검하고 종결합니다.</p> : null}
              {demo ? (
                <p className="t-xs muted">데모 환경에서만 본인 기록을 종결할 수 있습니다. 종결 기록과 점검 보고 요약에 '자기 점검(시연)'이 남습니다. 운영 환경에서는 다른 commander가 점검하고 종결합니다.</p>
              ) : null}
              <div className="row wrap" style={{ gap: 8 }}>
                <label className="field" style={{ flex: 1 }}>
                  <span className="label">확인한 사유(소명)</span>
                  <input className="input" value={reason} maxLength={2000} disabled={!(canResolve || canSelf) || busy} onChange={(e) => setReason(e.target.value)} />
                </label>
                <label className="field" style={{ minWidth: 160 }}>
                  <span className="label">사후조치</span>
                  <select className="input" value={action} disabled={!(canResolve || canSelf) || busy} onChange={(e) => setAction(e.target.value)}>
                    {FINDING_ACTIONS.map((k) => <option key={k} value={k}>{FINDING_ACTION_LABELS[k]}</option>)}
                  </select>
                </label>
                <button className="btn btn-outline" type="button" disabled={!canResolve || busy} aria-disabled={!canResolve} title={a.resolveFinding.reason} onClick={() => onResolve(id, { reason, action })}>
                  이상 건 종결
                </button>
                {demo && self ? (
                  <button className="btn btn-primary" type="button" disabled={!canSelf || busy} aria-disabled={!canSelf} title={a.selfResolve.reason} onClick={() => onResolve(id, { reason, action })}>
                    자기 점검(시연)으로 종결
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {phone ? <p className="hint">등록과 집행은 태블릿이나 데스크톱에서 합니다.</p> : null}
    </div>
  );
}
