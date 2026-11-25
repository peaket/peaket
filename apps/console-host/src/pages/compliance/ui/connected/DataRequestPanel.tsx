// SCR-032 자료 요청 상세(FR-034, d5 §7.5). 점검표·추출 범위·행 수·승인·거부·제출 기록·보존을 보인다.
import { useState } from 'react';
import { actionAvailability, deadlineView, listViewOf, DATA_ITEM_LABELS, type ComplianceLayout, type ComplianceRole } from '../../model/compliance';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const STATUS: Record<string, string> = {
  RECEIVED: '접수',
  REFUSED: '제공하지 않음',
  PENDING_APPROVAL: '승인 대기',
  APPROVED: '승인됨',
  EXTRACTED: '제출 파일 만듦',
  SUBMITTED: '제출 기록됨',
};
const KIND: Record<string, string> = { REPORT: '신고기관 자료(공연법)', CDR: '통신사실확인자료', SUBSCRIBER: '통신이용자정보' };

export function DataRequestPanel({
  role,
  layout,
  request,
  nowMs,
  busy,
  onExtract,
  onApprove,
  onReject,
  onSubmit,
}: {
  role: ComplianceRole;
  layout: ComplianceLayout;
  request: Record<string, unknown>;
  nowMs: number;
  busy: boolean;
  onExtract: (scope: { dataItems: string[]; periodFrom?: string; periodTo?: string; reason: string }) => void;
  onApprove: () => void;
  onReject: (outcome: 'REVISE' | 'DECLINE', reason: string) => void;
  onSubmit: (d: { submittedAt: string; recipient: string; channel: string; fileSha256: string }) => void;
}) {
  const view = listViewOf(request);
  const summary = view === 'SUMMARY';
  const a = actionAvailability({ role, tab: 'requests', layout, view, detail: request });
  const dl = deadlineView(text(request.dueAt), nowMs);
  const status = text(request.status);
  const extraction = obj(request.extraction);
  const submission = obj(request.submission);
  const approveLeft = deadlineView(text(extraction.approvalExpiresAt), nowMs);
  const [items, setItems] = useState<string[]>(arr(extraction.dataItems).map(String));
  const [reason, setReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [submit, setSubmit] = useState({ submittedAt: '', recipient: '', channel: '', fileSha256: '' });
  const phone = layout === 'phone';
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <div className="col" style={{ gap: 2 }}>
          <h3 className="t-md fw-b">{text(request.agencyName) || '기관 이름 없음'}</h3>
          <span className="t-xs muted">{KIND[text(request.kind)] ?? text(request.kind)} · 제출 기한 {dl.text}</span>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {summary ? <span className="badge">요약</span> : null}
          <span className={`badge${status === 'REFUSED' ? ' badge-danger' : status === 'SUBMITTED' ? ' badge-success' : ' badge-warning'}`}>{STATUS[status] ?? status}</span>
        </div>
      </div>
      {!summary ? (
        <>
          <dl className="kv t-sm">
            <dt>법적 근거</dt><dd>{text(request.legalBasis) || '—'}</dd>
            <dt>요청 목적</dt><dd>{text(request.purpose) || '—'}</dd>
            <dt>대상자</dt><dd>{arr(request.subjects).map((s) => `${text(obj(s).kind)}:${text(obj(s).value)}`).join(', ') || '—'}</dd>
            <dt>요청 범위</dt><dd>{arr(request.dataItems).map((i) => DATA_ITEM_LABELS[String(i)] ?? String(i)).join(', ') || '—'}</dd>
            <dt>대상 기간</dt><dd>{text(request.periodFrom) || '—'} ~ {text(request.periodTo) || '—'}</dd>
            <dt>보존 끝</dt><dd>{text(request.retainUntil) || '—'}</dd>
          </dl>
          {text(request.refusalReason) ? <p className="error-msg">거부 사유: {text(request.refusalReason)}</p> : null}
          <div className="col card-flat pad" style={{ gap: 8 }}>
            <h4 className="eyebrow">최소 범위 추출</h4>
            <p className="t-xs muted">요청서에 없는 항목과 대상자는 더할 수 없습니다. 행 수는 서버가 센 값입니다.</p>
            <fieldset className="row wrap" style={{ gap: 10, border: 0, padding: 0, margin: 0 }} disabled={!a.extract.enabled || busy} aria-label="추출할 자료 항목">
              <legend className="sr-only">추출할 자료 항목</legend>
              {arr(request.dataItems).map((i) => (
                <label key={String(i)} className="check-row">
                  <input
                    className="ck"
                    type="checkbox"
                    checked={items.includes(String(i))}
                    onChange={(e) => setItems((prev) => (e.target.checked ? [...prev, String(i)] : prev.filter((x) => x !== String(i))))}
                  />
                  {DATA_ITEM_LABELS[String(i)] ?? String(i)}
                </label>
              ))}
            </fieldset>
            {extraction.dataItems ? (
              <p className="t-sm">
                지금 요청: {arr(extraction.dataItems).map(String).join(', ')} · 행 수{' '}
                {Object.entries(obj(extraction.rowCounts)).map(([k, v]) => `${DATA_ITEM_LABELS[k] ?? k} ${String(v)}`).join(', ') || '—'}
              </p>
            ) : null}
            {status === 'PENDING_APPROVAL' ? (
              <p className="badge badge-warning" role="status">
                승인 대기 {approveLeft.text} · 승인 대기는 24시간이나 제출 기한 가운데 이른 때에 끝나 접수로 돌아갑니다.
              </p>
            ) : null}
            <label className="field">
              <span className="label">이 범위가 꼭 필요한 이유(사유)</span>
              <textarea className="input" value={reason} maxLength={2000} disabled={!a.extract.enabled || busy} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn btn-primary" type="button" disabled={!a.extract.enabled || busy} aria-disabled={!a.extract.enabled} title={a.extract.reason} onClick={() => onExtract({ dataItems: items, reason })}>
                추출 요청
              </button>
              <button className="btn btn-primary" type="button" disabled={!a.approve.enabled || busy} aria-disabled={!a.approve.enabled} title={a.approve.reason} onClick={onApprove}>
                승인
              </button>
              <button className="btn btn-danger" type="button" disabled={!a.reject.enabled || busy} aria-disabled={!a.reject.enabled} title={a.reject.reason} onClick={() => onReject('REVISE', rejectReason)}>
                거부
              </button>
            </div>
            {!a.approve.enabled && a.approve.reason ? <p className="hint">{a.approve.reason}</p> : null}
            <label className="field">
              <span className="label">거부 사유(범위를 고쳐 다시 요청은 REVISE, 제공하지 않음은 DECLINE)</span>
              <input className="input" value={rejectReason} maxLength={2000} disabled={!a.reject.enabled || busy} onChange={(e) => setRejectReason(e.target.value)} />
            </label>
            <p className="t-xs muted">추출 요청과 승인은 비밀번호·인증 앱 코드에 더해 등록한 패스키로 다시 확인합니다. 요청한 분이 아닌 commander가 승인한 뒤에만 자료를 뽑습니다.</p>
          </div>
          <div className="col card-flat pad" style={{ gap: 8 }}>
            <h4 className="eyebrow">제출 파일·기록</h4>
            {arr(request.documents).filter((d) => text(obj(d).kind) === 'SUBMISSION_FILE').length === 0 ? <p className="t-sm muted">승인 뒤에 제출 파일이 생깁니다.</p> : null}
            {arr(request.documents)
              .filter((d) => text(obj(d).kind) === 'SUBMISSION_FILE')
              .map((d) => (
                <div key={text(obj(d).documentId)} className="row between wrap" style={{ gap: 6 }}>
                  <span className="t-sm">{text(obj(d).kind)} · SHA-256 {text(obj(d).sha256).slice(0, 16)}…</span>
                  <a className="link" href={`${__OPS_API_ORIGIN__}/v1/ops/compliance/documents/${text(obj(d).documentId)}`} download>
                    내려받기
                  </a>
                </div>
              ))}
            {submission.fileSha256 ? <p className="t-sm">제출 기록: {text(submission.recipient)} · {text(submission.channel)} · SHA-256 {text(submission.fileSha256)}</p> : null}
            <label className="field"><span className="label">제출 일시</span><input className="input" type="datetime-local" value={submit.submittedAt} disabled={!a.submit.enabled || busy} onChange={(e) => setSubmit((s) => ({ ...s, submittedAt: e.target.value }))} /></label>
            <label className="field"><span className="label">받는 기관</span><input className="input" value={submit.recipient} disabled={!a.submit.enabled || busy} onChange={(e) => setSubmit((s) => ({ ...s, recipient: e.target.value }))} /></label>
            <label className="field"><span className="label">낸 방법</span><input className="input" value={submit.channel} disabled={!a.submit.enabled || busy} onChange={(e) => setSubmit((s) => ({ ...s, channel: e.target.value }))} /></label>
            <label className="field"><span className="label">파일 SHA-256</span><input className="input" value={submit.fileSha256} disabled={!a.submit.enabled || busy} onChange={(e) => setSubmit((s) => ({ ...s, fileSha256: e.target.value }))} /></label>
            <button className="btn btn-outline" type="button" disabled={!a.submit.enabled || busy} aria-disabled={!a.submit.enabled} title={a.submit.reason} onClick={() => onSubmit({ ...submit, submittedAt: submit.submittedAt ? new Date(submit.submittedAt).toISOString() : '' })}>
              제출 기록
            </button>
          </div>
        </>
      ) : (
        <p className="t-sm muted">건 요약만 보이는 역할입니다. 대상자·범위·제출 파일은 표시하지 않습니다.</p>
      )}
      {phone ? <p className="hint">등록과 집행은 태블릿이나 데스크톱에서 합니다.</p> : null}
    </div>
  );
}
