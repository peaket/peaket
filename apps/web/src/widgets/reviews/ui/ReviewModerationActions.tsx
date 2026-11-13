'use client';
// 후기 운영자 조치(SCR-016의 운영자 보기, FR-070·POL-044, ADR-0066). core-svc ops API를 쓴다.
// 이 버튼은 운영자 화면에서만 보인다(부르는 쪽이 moderator를 참으로 준다). 팬 화면에는 그리지 않는다.
import { useState } from 'react';
import { ApiError } from '@peaket/api-client';
import { REPORT_REASONS, type ReportReason } from '@peaket/ds/ReportDialog';
import { ensureBrowserApi, opsApiAvailable } from '@/shared/api';
import { buildModerationPayload } from '../model/moderation';

type Action = 'TEMP_BLOCK' | 'BLOCK' | 'RELEASE';

const ACTION_LABEL: Record<Action, string> = { TEMP_BLOCK: '임시조치', BLOCK: '노출 차단', RELEASE: '해제' };

function isoEndOfDay(date: string): string | undefined {
  if (!date) return undefined;
  const t = Date.parse(`${date}T23:59:59+09:00`);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export function ReviewModerationActions({ reviewId, onDone }: { reviewId: string; onDone?: (text: string) => void }) {
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [violation, setViolation] = useState<ReportReason>('ABUSE');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!opsApiAvailable()) return null;

  const submit = async () => {
    if (!action || reason.trim() === '' || busy) return;
    const payload = buildModerationPayload({ action, reason, violation, endsAt: isoEndOfDay(endsAt), nowMs: Date.now() });
    if (!payload.ok) {
      setError(payload.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [{ createOpsReviewModeration }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      if (!ensureBrowserApi()) throw new Error('no-api');
      await createOpsReviewModeration(reviewId, payload.body);
      setAction(null);
      setReason('');
      onDone?.(`후기를 ${ACTION_LABEL[action]}했습니다`);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 403) setError('이 조치를 할 권한이 없습니다');
        else if (e.status === 409) setError('지금 상태에서는 이 조치를 할 수 없습니다');
        else if (e.status === 422) setError('사유·위반 유형·기간을 확인해 주세요');
        else setError('조치하지 못했습니다. 잠시 뒤 다시 시도해 주세요');
      } else setError('조치하지 못했습니다. 잠시 뒤 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  if (!action) {
    return (
      <div className="row wrap" style={{ gap: 4 }} aria-label="운영자 후기 조치">
        {(Object.keys(ACTION_LABEL) as Action[]).map((a) => (
          <button key={a} className={a === 'RELEASE' ? 'btn btn-ghost btn-sm' : 'btn btn-outline btn-sm'} type="button" onClick={() => { setAction(a); setError(null); }}>
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="card col" style={{ gap: 8, padding: 12, marginTop: 8 }} role="group" aria-label={`후기 ${ACTION_LABEL[action]}`}>
      <p className="t-sm fw-b">후기 {ACTION_LABEL[action]}</p>
      {action !== 'RELEASE' ? (
        <label className="col" style={{ gap: 4 }}>
          <span className="t-xs muted">위반 유형</span>
          <select className="input" value={violation} onChange={(e) => setViolation(e.currentTarget.value as ReportReason)}>
            {REPORT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
      ) : null}
      {action === 'TEMP_BLOCK' ? (
        <label className="col" style={{ gap: 4 }}>
          <span className="t-xs muted">끝나는 날(최대 30일)</span>
          <input className="input" type="date" value={endsAt} min={new Date().toISOString().slice(0, 10)} max={new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString().slice(0, 10)} onChange={(e) => setEndsAt(e.currentTarget.value)} />
        </label>
      ) : null}
      <label className="col" style={{ gap: 4 }}>
        <span className="t-xs muted">사유 (필수)</span>
        <textarea className="input" rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
      </label>
      {error ? <p className="t-sm" role="alert" style={{ color: 'var(--danger)' }}>{error}</p> : null}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAction(null)} disabled={busy}>닫기</button>
        <button className="btn btn-danger btn-sm" type="button" onClick={() => void submit()} disabled={busy || reason.trim() === ''}>{busy ? '조치 중…' : ACTION_LABEL[action]}</button>
      </div>
    </div>
  );
}
