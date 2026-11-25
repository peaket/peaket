// 검증 묶음 내보내기 대화상자(SCR-031, d5 §7.4 '검증 묶음 내보내기', C-T39).
// commander가 사유를 적어 내보낸다. 응답은 화면에 렌더하지 않고 파일로만 내려받는다. 원본 로그 내보내기는 원천이 없어 막힌다.
import { useState } from 'react';
import { Overlay } from '@/shared/ui/Overlay';
import { exportAvailability, type AuditLayout, type AuditRole } from '../../model/audit';

export function ExportBundleDialog({
  open,
  role,
  layout,
  checkpoint,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  role: AuditRole;
  layout: AuditLayout;
  checkpoint: { checkpointId: string; fromSeq: number; toSeq: number; reason: string } | null;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  if (!open) return null;
  const can = exportAvailability({ role, layout });
  const issue = can.bundle ? (reason.trim() === '' ? '내보내는 사유를 적어 주세요' : null) : (can.reason ?? '내보낼 수 없습니다');
  return (
    <Overlay onClose={onClose}>
      <div className="dialog col" role="dialog" aria-modal="true" aria-labelledby="audit-export-t" aria-describedby="audit-export-d" style={{ maxWidth: 520, gap: 12 }}>
        <h2 className="dialog-title" id="audit-export-t">
          검증 묶음 내보내기
        </h2>
        <p className="t-sm" id="audit-export-d">
          분쟁 당사자에게 주는 자료입니다. 기록 정규화 값·잎 솔트·포함 증명·체크포인트 서명·공개 타임스탬프 증명이 들어가고, 내보낸 사실은 감사 기록에 남습니다.
        </p>
        {checkpoint ? (
          <dl className="kv card-flat pad">
            <dt>체크포인트</dt>
            <dd>{checkpoint.checkpointId}</dd>
            <dt>구간</dt>
            <dd>
              {checkpoint.fromSeq}~{checkpoint.toSeq}
            </dd>
          </dl>
        ) : (
          <p className="t-sm muted">왼쪽에서 체크포인트를 고르세요.</p>
        )}
        <div className="field">
          <label className="label" htmlFor="audit-export-reason">
            내보내는 사유 <span className="opt">(필수, 2,000자)</span>
          </label>
          <textarea className="input" id="audit-export-reason" maxLength={2000} value={reason} disabled={!can.bundle || busy} onChange={(e) => setReason(e.target.value)} />
        </div>
        {!can.bundle ? (
          <p className="hint" role="note">
            {can.reason}
          </p>
        ) : null}
        {error ? (
          <p className="error-msg" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>
            닫기
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!can.bundle || busy || issue !== null || checkpoint === null}
            aria-disabled={!can.bundle || issue !== null}
            title={issue ?? undefined}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? '내보내는 중…' : '검증 묶음 내보내기'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
