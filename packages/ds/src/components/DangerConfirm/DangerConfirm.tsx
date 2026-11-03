'use client';
// CMP-020 DangerConfirm. 되돌릴 수 없는 작업 직전에 결과를 적은 버튼으로 확인받는다(Dialog role="alertdialog" 위에 짠다).
// - fan(팬의 탈퇴·양도·돌려주기·취소·병합): 결과를 적은 버튼만 둔다. 사유 입력·문구 타이핑을 요구하지 않는다(POL-033).
// - ops(관제 킬스위치 등): 보드 SCR-030 마크업 — 제목 왼쪽 위험 아이콘(ic-stop, 44px), 영향 요약(details, .kv 상자),
//   실행 사유(.textarea, 필수, 글자 수), 확인 문구(.input.input-sm, 회차 이름 그대로), [돌아가기 btn-outline] [결과 버튼 btn-danger].
//   사유와 문구가 맞기 전에는 결과 버튼을 이유 있는 비활성(aria-disabled + 이유 글)으로 둔다.
// - confirmLabel에는 구체적인 결과를 적는다("판매를 전면 중단합니다").
import { useId, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../../icons';
import { Dialog } from '../Dialog/Dialog';

export interface DangerConfirmProps {
  open: boolean;
  onClose: () => void;
  /** 확인. ops면 사유를 넘긴다 */
  onConfirm: (reason?: string) => void;
  variant?: 'fan' | 'ops';
  title: ReactNode;
  description?: ReactNode;
  /** 결과를 적은 버튼 글 */
  confirmLabel: string;
  cancelLabel?: string;
  icon?: IconName;
  /** 영향 요약(.kv 등). ops는 옅은 상자에 담는다 */
  details?: ReactNode;
  /** ops: 사유 칸 라벨. 기본 '실행 사유' */
  reasonLabel?: string;
  reasonHint?: ReactNode;
  /** ops: 그대로 입력해야 하는 확인 문구(회차 이름 등) */
  confirmPhrase?: string;
  /** 행동 아래 작은 글(다음 단계 재인증 안내 등) */
  footnote?: ReactNode;
  loading?: boolean;
  /** 미리보기용 처음 값 */
  defaultReason?: string;
  defaultPhrase?: string;
}

export function DangerConfirm({
  open,
  onClose,
  onConfirm,
  variant = 'fan',
  title,
  description,
  confirmLabel,
  cancelLabel,
  icon,
  details,
  reasonLabel = '실행 사유',
  reasonHint = '사유는 감사 로그와 사후 검토 보고서에 그대로 남습니다',
  confirmPhrase,
  footnote,
  loading = false,
  defaultReason = '',
  defaultPhrase = '',
}: DangerConfirmProps) {
  const base = useId();
  const reasonId = `${base}-reason`;
  const phraseId = `${base}-phrase`;
  const whyId = `${base}-why`;
  const [reason, setReason] = useState(defaultReason);
  const [phrase, setPhrase] = useState(defaultPhrase);
  const ops = variant === 'ops';
  const ready = !ops || (reason.trim().length > 0 && (!confirmPhrase || phrase.trim() === confirmPhrase));
  const blocked = !ready || loading;
  const reasonText = Array.from(reason).length;

  const confirmButton = (
    <button
      className="btn btn-danger"
      type="button"
      aria-disabled={!ready ? true : undefined}
      aria-busy={loading ? true : undefined}
      aria-describedby={!ready ? whyId : undefined}
      onClick={(e) => {
        if (blocked) {
          e.preventDefault();
          return;
        }
        onConfirm(ops ? reason.trim() : undefined);
      }}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : ops ? <Icon name={icon ?? 'stop'} /> : null}
      {confirmLabel}
    </button>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      title={title}
      description={description}
      icon={ops ? (icon ?? 'stop') : icon}
      iconTone="danger"
      iconPlacement={ops ? 'inline' : 'stack'}
      maxWidth={ops ? 560 : undefined}
      layout={ops ? 'dialog' : 'auto'}
      actions={
        <>
          <button className={ops ? 'btn btn-outline' : 'btn btn-ghost'} type="button" onClick={onClose}>
            {cancelLabel ?? (ops ? '작성 화면으로 돌아가기' : '취소')}
          </button>
          {confirmButton}
        </>
      }
      footnote={footnote}
    >
      {details ? (
        ops ? (
          <div style={{ fontSize: 13, lineHeight: '18px', padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--surface-muted)' }}>
            {details}
          </div>
        ) : (
          details
        )
      ) : null}
      {ops ? (
        <>
          <div className="field">
            <label className="label" htmlFor={reasonId}>
              {reasonLabel} <span className="opt">(필수)</span>
            </label>
            <textarea
              className="textarea"
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-describedby={`${reasonId}-h ${reasonId}-c`}
              style={{ minHeight: 84, fontSize: 14, lineHeight: '21px' }}
            />
            <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span className="hint" id={`${reasonId}-h`}>
                {reasonHint}
              </span>
              <span className="counter" id={`${reasonId}-c`} aria-live="polite">
                {reasonText}자
              </span>
            </div>
          </div>
          {confirmPhrase ? (
            <div className="field">
              <label className="label" htmlFor={phraseId}>
                확인 문구 <span className="opt">(필수)</span>
              </label>
              <input
                className="input input-sm"
                id={phraseId}
                type="text"
                autoComplete="off"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                aria-describedby={`${phraseId}-h`}
              />
              <span className="hint" id={`${phraseId}-h`}>
                확인하려면 {confirmPhrase}을(를) 그대로 입력하세요
              </span>
            </div>
          ) : null}
          {!ready ? (
            <p className="t-sm" id={whyId}>
              {confirmPhrase ? '사유를 적고 확인 문구를 그대로 입력하면 실행할 수 있습니다' : '사유를 적으면 실행할 수 있습니다'}
            </p>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
