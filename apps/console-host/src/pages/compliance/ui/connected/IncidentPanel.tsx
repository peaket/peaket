// SCR-032 보안 사고 상세(FR-063, d5 §7.5). 의무별 기한·판단·신고 기록·종결과 통지 문안 미리보기를 보인다.
import { useState } from 'react';
import { actionAvailability, incidentDutyView, noticeUserCopy, type ComplianceLayout, type ComplianceRole } from '../../model/compliance';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const KIND: Record<string, string> = { INTRUSION: '침해사고', PERSONAL_DATA: '개인정보 유출', PERSONAL_DATA_POSSIBLE: '유출 가능성' };
const DETERMINATION: Record<string, string> = { APPLICABLE: '해당함', UNDECIDED: '판단이 서지 않음', NOT_APPLICABLE: '해당 없음' };

export function IncidentPanel({
  role,
  layout,
  incident,
  nowMs,
  demo,
  busy,
  onDetermine,
  onFile,
  onClose,
}: {
  role: ComplianceRole;
  layout: ComplianceLayout;
  incident: Record<string, unknown>;
  nowMs: number;
  demo: boolean;
  busy: boolean;
  onDetermine: (outcome: string, reason: string) => void;
  onFile: (d: { duty: string; channel: string; doneAt: string; summary: string }) => void;
  onClose: () => void;
}) {
  const view = incident.view === 'SUMMARY' ? 'SUMMARY' : 'FULL';
  const a = actionAvailability({ role, tab: 'incidents', layout, view, detail: incident });
  const duties = incidentDutyView(incident, nowMs);
  const decided = typeof incident.decidedAt === 'string' && incident.decidedAt !== '';
  const [outcome, setOutcome] = useState('APPLICABLE');
  const [reason, setReason] = useState('');
  const [filing, setFiling] = useState({ duty: duties[0]?.duty ?? 'KISA_REPORT_24H', channel: '', doneAt: '', summary: '' });
  const [copyKind, setCopyKind] = useState('A');
  const copy = noticeUserCopy(copyKind);
  const phone = layout === 'phone';
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <div className="col" style={{ gap: 2 }}>
          <h3 className="t-md fw-b">{KIND[text(incident.kind)] ?? text(incident.kind)}</h3>
          <span className="t-xs muted">인지 {text(incident.awareAt) || '—'} · 대상 {typeof incident.affectedCount === 'number' ? `${incident.affectedCount}명` : '모름'}</span>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {demo ? <span className="badge">데모 환경</span> : null}
          <span className={`badge${incident.status === 'CLOSED' ? ' badge-success' : ' badge-warning'}`}>{incident.status === 'CLOSED' ? '종결' : '진행 중'}</span>
        </div>
      </div>
      {view === 'SUMMARY' ? <p className="t-sm muted">건 요약만 보이는 역할입니다. 대상자·통지 목록은 표시하지 않습니다.</p> : null}
      {view === 'FULL' ? (
        <>
          <p className="t-sm">{text(incident.summary) || '사고 요약 없음'}</p>
          <dl className="kv t-sm">
            <dt>민감·고유식별</dt><dd>{incident.sensitiveOrUnique ? '포함' : '없음'}</dd>
            <dt>외부 불법 접근</dt><dd>{incident.externalAccess ? '있음' : '없음'}</dd>
            <dt>장애</dt><dd>{text(incident.outageStartedAt) || '—'} ~ {text(incident.outageEndedAt) || '진행 중'}</dd>
            <dt>해당 판단</dt><dd>{decided ? `${text(incident.decidedAt)} 기록됨` : '아직 없음'}</dd>
          </dl>
          <div className="col card-flat pad" style={{ gap: 6 }}>
            <h4 className="eyebrow">의무별 기한</h4>
            {duties.map((d) => (
              <div key={d.duty} className="row between wrap" style={{ gap: 6 }}>
                <span className="t-sm">{d.label}</span>
                <span className={`badge${d.doneAt ? ' badge-success' : d.tone === 'danger' || d.tone === 'overdue' ? ' badge-danger' : ' badge-warning'}`}>
                  {d.doneAt ? `완료 ${d.doneAt}` : d.tone === 'overdue' ? '기한 지남' : d.tone === 'none' ? '기한 없음' : `남은 ${Math.floor(d.remainingMs / 3_600_000)}시간 ${Math.floor((d.remainingMs % 3_600_000) / 60_000)}분`}
                </span>
              </div>
            ))}
          </div>
          {!decided ? (
            <div className="col card-flat pad" style={{ gap: 8 }}>
              <h4 className="eyebrow">해당 판단(commander, 한 번만)</h4>
              <p className="t-xs muted">판단은 한 번만 기록합니다. 기록한 뒤에 신고·통지를 기록할 수 있습니다.</p>
              <label className="field">
                <span className="label">판단</span>
                <select className="input" value={outcome} disabled={!a.determine.enabled || busy} onChange={(e) => setOutcome(e.target.value)}>
                  {Object.entries(DETERMINATION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="label">판단 사유</span>
                <textarea className="input" maxLength={2000} value={reason} disabled={!a.determine.enabled || busy} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button className="btn btn-primary" type="button" disabled={!a.determine.enabled || busy} aria-disabled={!a.determine.enabled} title={a.determine.reason} onClick={() => onDetermine(outcome, reason)}>
                판단을 기록합니다
              </button>
              {!a.determine.enabled && a.determine.reason ? <p className="hint">{a.determine.reason}</p> : null}
            </div>
          ) : null}
          <div className="col card-flat pad" style={{ gap: 8 }}>
            <h4 className="eyebrow">신고·통지 기록</h4>
            {arr(incident.filings).length === 0 ? <p className="t-sm muted">기록된 신고·통지가 없습니다.</p> : null}
            {arr(incident.filings).map((f, i) => (
              <p key={`${text(obj(f).duty)}:${i}`} className="t-sm">
                {text(obj(f).duty)} · {text(obj(f).channel)} · {text(obj(f).doneAt)} · {text(obj(f).summary)}
              </p>
            ))}
            <label className="field"><span className="label">의무</span><select className="input" value={filing.duty} disabled={!a.file.enabled || busy} onChange={(e) => setFiling((s) => ({ ...s, duty: e.target.value }))}>{duties.map((d) => <option key={d.duty} value={d.duty}>{d.label}</option>)}</select></label>
            <label className="field"><span className="label">기관·방법</span><input className="input" value={filing.channel} disabled={!a.file.enabled || busy} onChange={(e) => setFiling((s) => ({ ...s, channel: e.target.value }))} /></label>
            <label className="field"><span className="label">수행 시각</span><input className="input" type="datetime-local" value={filing.doneAt} disabled={!a.file.enabled || busy} onChange={(e) => setFiling((s) => ({ ...s, doneAt: e.target.value }))} /></label>
            <label className="field"><span className="label">내용 요약(개인정보 원문 없이)</span><textarea className="input" maxLength={2000} value={filing.summary} disabled={!a.file.enabled || busy} onChange={(e) => setFiling((s) => ({ ...s, summary: e.target.value }))} /></label>
            <button className="btn btn-primary" type="button" disabled={!a.file.enabled || busy} aria-disabled={!a.file.enabled} title={a.file.reason} onClick={() => onFile({ ...filing, doneAt: filing.doneAt ? new Date(filing.doneAt).toISOString() : '' })}>
              신고·통지 기록 추가하기
            </button>
            {!a.file.enabled && a.file.reason ? <p className="hint">{a.file.reason}</p> : null}
          </div>
          <div className="col card-flat pad" style={{ gap: 8 }}>
            <h4 className="eyebrow">이용자 통지 문안 미리보기</h4>
            <label className="field"><span className="label">문안</span><select className="input" value={copyKind} onChange={(e) => setCopyKind(e.target.value)}>{['A', 'A2', 'A3', 'B'].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
            <p className="t-sm fw-b">{copy.title}</p>
            <ul className="t-xs" style={{ margin: 0, paddingLeft: 18 }}>{copy.required.map((r) => <li key={r}>{r}</li>)}</ul>
            <p className="t-xs muted">필수 칸이 비면 보내기를 막습니다. 유출된 값 자체는 본문에 쓰지 않고 항목 이름만 씁니다.</p>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn btn-outline" type="button" disabled={!a.close.enabled || busy} aria-disabled={!a.close.enabled} title={a.close.reason} onClick={onClose}>
              보안 사고 종결하기
            </button>
            {!a.close.enabled && a.close.reason ? <p className="hint">{a.close.reason}</p> : null}
          </div>
        </>
      ) : null}
      {phone ? <p className="hint">등록과 집행은 태블릿이나 데스크톱에서 합니다.</p> : null}
    </div>
  );
}
