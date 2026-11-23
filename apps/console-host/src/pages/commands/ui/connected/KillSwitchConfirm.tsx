// 명령 3(판매 일시정지, 1인 실행) 위험 확인 대화상자(d5 §7.3 '명령 3(1인 실행) 화면 글'). 사유를 받고, 사유가 비면 실행 단추가 막힌다.
// 실행을 누르면 부르는 쪽이 재인증(OPS_COMMAND) → 접수로 잇는다. 승인 대기 없이 바로 전달된다(ADR-0095).
import { useState } from 'react';
import { Overlay } from '@/shared/ui/Overlay';
import type { CommandScope } from '../../model/command-form';

export interface KillSwitchConfirmProps {
  scope: CommandScope;
  eventId?: string;
  /** 회차 이름(있으면 범위 글에 함께) */
  eventName?: string;
  /** 작성 칸에 먼저 적은 사유(있으면 채워 둔다) */
  initialReason?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

const REASON_MAX = 2000;

export function KillSwitchConfirm({ scope, eventId, eventName, initialReason = '', busy = false, onConfirm, onClose }: KillSwitchConfirmProps) {
  const [reason, setReason] = useState(initialReason);
  const ready = reason.trim() !== '' && !busy;
  const target = scope === 'EVENT' ? `이 회차${eventName ? `(${eventName})` : eventId ? `(${eventId})` : ''}의 판매를 바로 멈춥니다.` : '전체 회차의 판매를 바로 멈춥니다.';
  return (
    <Overlay onClose={busy ? undefined : onClose}>
      <section className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="kill-h" aria-describedby="kill-d" style={{ maxWidth: 520 }}>
        <h2 className="dialog-title" id="kill-h">
          판매 일시정지(킬스위치)를 실행합니다
        </h2>
        <p className="t-sm" id="kill-d">
          {target} 승인 대기 없이 바로 걸리고, 되돌리기(판매 재개)는 다른 운영자의 승인이 있어야 합니다.
        </p>
        <label className="field" htmlFor="kill-reason">
          <span className="label">사유(필수)</span>
          <textarea id="kill-reason" className="input" rows={3} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.currentTarget.value)} autoFocus />
          <span className="t-xs muted">사유는 감사 로그와 사후 검토 보고서에 그대로 남습니다</span>
        </label>
        <div className="dialog-actions">
          <button className="btn btn-outline" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="btn btn-danger" type="button" disabled={!ready} onClick={() => ready && onConfirm(reason)}>
            다시 인증하고 실행
          </button>
        </div>
      </section>
    </Overlay>
  );
}
