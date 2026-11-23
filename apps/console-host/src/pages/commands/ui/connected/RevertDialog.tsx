// 되돌리기 대화상자(openapi createOpsCommandReversion, 사유 필수). 명령 1은 자동 조절로 돌아가기(재인증 없음),
// 명령 3(판매 재개)은 commander 요청·재인증 뒤 다른 운영자의 2인 승인, 명령 6은 commander·재인증 1인 해제다. 사유가 비면 확인 단추가 막힌다.
import { useState } from 'react';
import { Overlay } from '@/shared/ui/Overlay';
import type { CommandDetail } from '../../model/command-actions';
import { cardTitle } from './CommandCard';

export interface RevertDialogProps {
  detail: CommandDetail;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

const REASON_MAX = 2000;

function copyOf(type: string | undefined): { title: string; body: string; go: string } {
  if (type === 'KILL_SWITCH') {
    return {
      title: '판매 재개를 요청합니다',
      body: '판매 재개는 2인 승인입니다. 다시 인증해 요청하면, 요청자가 아닌 운영자가 10분 안에 승인해야 판매가 다시 열립니다.',
      go: '다시 인증하고 요청',
    };
  }
  if (type === 'DEGRADED_MODE') return { title: '대체 결제사 전환을 해제합니다', body: '다시 인증하면 새 결제가 원래 결제사로 돌아갑니다.', go: '다시 인증하고 해제' };
  if (type === 'ADMISSION_TARGET') return { title: '자동 조절로 되돌립니다', body: '직접 정한 동시 입장 목표를 풀고 자동 조절로 돌아갑니다.', go: '되돌리기' };
  return { title: '명령을 되돌립니다', body: '직전 값으로 되돌립니다.', go: '되돌리기' };
}

export function RevertDialog({ detail, busy = false, onConfirm, onClose }: RevertDialogProps) {
  const [reason, setReason] = useState('');
  const ready = reason.trim() !== '' && !busy;
  const c = copyOf(detail.type);
  return (
    <Overlay onClose={busy ? undefined : onClose}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="revert-h" aria-describedby="revert-d" style={{ maxWidth: 480 }}>
        <h2 className="dialog-title" id="revert-h">
          {c.title}
        </h2>
        <p className="t-sm" id="revert-d">
          {cardTitle(detail)} · {c.body}
        </p>
        <label className="field" htmlFor="revert-reason">
          <span className="label">사유(필수)</span>
          <textarea id="revert-reason" className="input" rows={3} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.currentTarget.value)} autoFocus />
          <span className="t-xs muted">사유는 감사 로그에 그대로 남습니다</span>
        </label>
        <div className="dialog-actions">
          <button className="btn btn-outline" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="btn btn-primary" type="button" disabled={!ready} onClick={() => ready && onConfirm(reason)}>
            {c.go}
          </button>
        </div>
      </section>
    </Overlay>
  );
}
