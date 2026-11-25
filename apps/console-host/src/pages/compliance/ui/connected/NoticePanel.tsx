// SCR-032 통보 상세(FR-033, d5 §7.5). props만으로 그리고, 칸 가림(view SUMMARY)과 막힘·휴대폰을 화면에 반영한다.
import { useState } from 'react';
import { deadlineView, listViewOf, actionAvailability, type ComplianceLayout, type ComplianceRole } from '../../model/compliance';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const STATUS: Record<string, string> = { OPEN: '처리 중', TAKEN_DOWN: '노출 차단', WITHDRAWN: '철회' };
const REQUESTER: Record<string, string> = { AGENCY: '신고기관', POLICE: '수사기관' };
const SCAN: Record<string, string> = { PENDING: '검사 중', CLEAN: '위협 없음', THREAT: '위협 발견' };

export function NoticePanel({
  role,
  layout,
  notice,
  nowMs,
  busy,
  onTakedown,
  onWithdraw,
  onUpload,
}: {
  role: ComplianceRole;
  layout: ComplianceLayout;
  notice: Record<string, unknown>;
  nowMs: number;
  busy: boolean;
  onTakedown: (reason: string) => void;
  onWithdraw: (reason: string) => void;
  onUpload: (file: File, kind: 'OFFICIAL_LETTER') => void;
}) {
  const view = listViewOf(notice);
  const summary = view === 'SUMMARY';
  const a = actionAvailability({ role, tab: 'requests', layout, view, detail: notice });
  const dl = deadlineView(text(notice.dueAt), nowMs);
  const status = text(notice.status);
  const phone = layout === 'phone';
  const [reason, setReason] = useState('');
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <div className="col" style={{ gap: 2 }}>
          <h3 className="t-md fw-b">{text(notice.agencyName) || '기관 이름 없음'}</h3>
          <span className="t-xs muted">
            {REQUESTER[text(notice.requester)] ?? text(notice.requester)} · 접수 {text(notice.receivedAt) || '—'}
          </span>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {summary ? <span className="badge">요약</span> : null}
          <span className={`badge${status === 'OPEN' ? ' badge-warning' : status === 'TAKEN_DOWN' ? ' badge-success' : ''}`}>{STATUS[status] ?? status}</span>
        </div>
      </div>
      <div className={`banner ${dl.tone === 'danger' || dl.tone === 'overdue' ? 'banner-danger' : dl.tone === 'warn' ? 'banner-warning' : 'banner-info'}`} role="status">
        <div className="banner-body">
          처리 기한 {text(notice.deadline) === 'H10' ? '10시간(고시)' : '24시간'} · {dl.text}
          {dl.tone === 'danger' || dl.tone === 'overdue' ? ' · SEV2 보안 경보 대상입니다' : ''}
        </div>
      </div>
      {!summary ? (
        <>
          <p className="t-sm">{text(notice.summary) || '통보 요약 없음'}</p>
          <div className="col" style={{ gap: 4 }}>
            <h4 className="eyebrow">대상 게시물</h4>
            {arr(notice.reviewIds).length === 0 ? <p className="t-sm muted">게시물 ID가 없습니다.</p> : null}
            <ul className="t-sm" style={{ margin: 0, paddingLeft: 18 }}>
              {arr(notice.reviewIds).map((id) => <li key={String(id)}>{String(id)}</li>)}
            </ul>
            <p className="t-xs muted">통보가 정식으로 철회되면 통보 단위로 되살립니다. 이 통보로 가린 게시물과 같은 내용으로 자동 숨긴 글을 함께 되살립니다.</p>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <h4 className="eyebrow">공문 원본</h4>
            {arr(notice.documents).length === 0 ? <p className="t-sm muted">올린 원본이 없습니다.</p> : null}
            {arr(notice.documents).map((d) => (
              <div key={text(d.documentId)} className="row between wrap card-flat pad" style={{ gap: 6 }}>
                <span className="t-sm">{text(d.kind)} · {SCAN[text(d.scanStatus)] ?? text(d.scanStatus)}</span>
                <a className="link" href={`${__OPS_API_ORIGIN__}/v1/ops/compliance/documents/${text(d.documentId)}`} download>
                  내려받기
                </a>
              </div>
            ))}
            <label className="field">
              <span className="label">원본 올리기(PDF만, 20MB까지)</span>
              <input
                className="input"
                type="file"
                accept="application/pdf,.pdf"
                disabled={!a.register.enabled || busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUpload(f, 'OFFICIAL_LETTER');
                }}
              />
            </label>
            <p className="t-xs muted">악성 코드 검사에서 위협이 없다고 나온 파일만 내려받을 수 있습니다.</p>
          </div>
        </>
      ) : (
        <p className="t-sm muted">건 요약만 보이는 역할입니다. 대상자·원문·문서는 표시하지 않습니다.</p>
      )}
      {phone ? <p className="hint">등록과 집행은 태블릿이나 데스크톱에서 합니다.</p> : null}
      <label className="field">
        <span className="label">집행 사유(노출 차단·철회 복원에 필요)</span>
        <textarea className="input" maxLength={2000} value={reason} disabled={phone || busy} onChange={(e) => setReason(e.target.value)} />
      </label>
      {status === 'TAKEN_DOWN' || a.withdraw.enabled ? (
        <p className="t-xs muted">통보가 정식으로 철회되었을 때만 씁니다. 이 통보로 가린 게시물과 같은 내용으로 자동 숨긴 글을 모두 다시 보이게 하고, 통보를 '철회'로 닫습니다. 조치·회신·제출 기록과 감사 로그에 남깁니다.</p>
      ) : null}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn btn-danger" type="button" disabled={!a.takedown.enabled || busy} aria-disabled={!a.takedown.enabled} title={a.takedown.reason} onClick={() => onTakedown(reason)}>
          노출 차단
        </button>
        <button className="btn btn-outline" type="button" disabled={!a.withdraw.enabled || busy} aria-disabled={!a.withdraw.enabled} title={a.withdraw.reason} onClick={() => onWithdraw(reason)}>
          통보 철회로 복원하기
        </button>
      </div>
      {!a.takedown.enabled && a.takedown.reason ? <p className="hint">{a.takedown.reason}</p> : null}
    </div>
  );
}
