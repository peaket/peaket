// 설정 화면의 대화상자 조각(보드 SCR-020 showReauth·showPk·showPayoutDlg·showSellerReq).
// 재인증은 CMP-064 admin(비밀번호 + 인증 앱 코드, 5분 안에 한 번 쓰는 재인증), 계좌 입력은 CMP-062 payout.
// 휴대폰(md 미만)은 아래 시트 모양: 버튼을 세로로 쌓고 주 버튼을 크게(보드 SCR-020-m).
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Modal } from '@/shared/ui/Modal';
import { PasswordInput } from './PasswordInput';

/** 시트(휴대폰)에서 버튼을 세로로: 주 버튼이 위, 닫기는 글자 버튼 모양 */
export const SHEET_ACTIONS = 'dialog-actions max-md:flex-col-reverse max-md:[&>*]:w-full';
export const SHEET_PRIMARY = 'max-md:min-h-[52px] max-md:rounded-[var(--r-lg)] max-md:text-base';
export const SHEET_CANCEL = 'max-md:border-transparent max-md:bg-transparent';

export function CancelButton({ children }: { children: ReactNode }) {
  return (
    <button className={`btn btn-outline ${SHEET_CANCEL}`} type="button" data-modal-close="">
      {children}
    </button>
  );
}

export interface ReauthDialogProps {
  id: string;
  defaultOpen?: boolean;
  /** 본문 첫 문장(예: '비밀번호를 바꾸기 전에') */
  before: string;
  /** 주 버튼 글(예: '다시 인증하고 비밀번호 바꾸기') */
  submitLabel: string;
  /** 주 버튼을 누르면 열 다음 대화상자 id(정산 계좌 변경의 패스키 단계) */
  next?: string;
  /** 단계 표시(정산 계좌 변경: 2단계 중 1단계) */
  steps?: boolean;
  /** 본문을 통째로 바꿀 때 */
  body?: string;
}

/** CMP-064 admin 재인증. 보드 '보안 설정 재인증'(비밀번호 바꾸기)의 모양을 다른 보안 설정에도 같은 문형으로 쓴다 */
export function ReauthDialog({ id, defaultOpen, before, submitLabel, next, steps, body }: ReauthDialogProps) {
  return (
    <Modal id={id} defaultOpen={defaultOpen} labelledBy={`${id}-t`} describedBy={`${id}-d`} maxWidth={440}>
      <div className="row" style={{ gap: 12 }}>
        <span className="state-icon is-primary max-md:hidden" style={{ width: 44, height: 44 }}>
          <i className="ic ic-lock" aria-hidden="true" />
        </span>
        <h2 className="dialog-title" id={`${id}-t`}>
          다시 인증합니다
        </h2>
      </div>
      {steps && (
        <nav className="stepper" aria-label="재인증 단계">
          <span className="step is-current" aria-current="step">
            <span className="step-num">1</span>비밀번호·인증 앱 코드
          </span>
          <span className="step-line" />
          <span className="step">
            <span className="step-num">2</span>패스키
          </span>
        </nav>
      )}
      <p className="t-sm" id={`${id}-d`}>
        {body ?? `${before} 비밀번호와 인증 앱의 6자리 코드를 다시 입력합니다. 이 인증은 5분 안에 한 번 쓸 수 있습니다.`}
      </p>
      <form className="col" style={{ gap: 16 }} aria-label="관리 계정 재인증">
        <div className="field">
          <label className="label" htmlFor={`${id}-pw`}>
            비밀번호
          </label>
          <PasswordInput id={`${id}-pw`} autoComplete="current-password" autoFocusInDialog />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-otp`}>
            인증 앱의 6자리 코드
          </label>
          <input
            className="otp-input"
            id={`${id}-otp`}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="[0-9]*"
            aria-describedby={`${id}-otp-h`}
          />
          {/* 휴대폰 재인증 시트의 인증 앱 안내(d5 §3.9, 보드 SCR-020-m) */}
          <span className="hint md:hidden" id={`${id}-otp-h`}>
            휴대폰을 잃을 때 로그인과 인증 앱 코드를 함께 잃지 않도록, 인증 앱은 이 휴대폰이 아닌 다른 기기에 두기를 권합니다.
          </span>
        </div>
        <div className={SHEET_ACTIONS}>
          <CancelButton>바꾸지 않고 닫기</CancelButton>
          <button className={`btn btn-primary ${SHEET_PRIMARY}`} type="button" data-modal-close="" data-modal-open={next}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 정산 계좌 변경 2단계 중 2단계: 패스키 확인(보드 showPk·pkFail) */
export function PasskeyDialog({ id, defaultOpen, failed, next }: { id: string; defaultOpen?: boolean; failed?: boolean; next: string }) {
  return (
    <Modal id={id} defaultOpen={defaultOpen} labelledBy={`${id}-t`} describedBy={`${id}-d`} maxWidth={440}>
      <div className="row" style={{ gap: 12 }}>
        <span className="state-icon is-primary" style={{ width: 44, height: 44 }}>
          <i className="ic ic-lock" aria-hidden="true" />
        </span>
        <h2 className="dialog-title" id={`${id}-t`}>
          다시 인증합니다
        </h2>
      </div>
      <nav className="stepper" aria-label="재인증 단계">
        <span className="step is-done">
          <span className="step-num">
            <i className="ic ic-check" aria-hidden="true" />
          </span>
          비밀번호·인증 앱 코드<span className="sr-only">(완료)</span>
        </span>
        <span className="step-line is-done" />
        <span className="step is-current" aria-current="step">
          <span className="step-num">2</span>패스키
        </span>
      </nav>
      <p className="t-sm" id={`${id}-d`}>
        정산 계좌를 바꾸기 전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다.
      </p>
      <p className="row t-sm" style={{ gap: 8, alignItems: 'center' }}>
        <i className="ic ic-key ic-16" aria-hidden="true" />
        등록한 패스키로 한 번 더 확인합니다
      </p>
      {failed && (
        <span className="error-msg" id={`${id}-e`} role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          패스키로 확인하지 못했습니다. 다시 시도해 주세요
        </span>
      )}
      <p className="t-xs muted">누르면 브라우저의 패스키 창이 열립니다.</p>
      <div className={SHEET_ACTIONS}>
        <CancelButton>바꾸지 않고 닫기</CancelButton>
        <button
          className={`btn btn-primary ${SHEET_PRIMARY}`}
          type="button"
          data-autofocus=""
          data-modal-close=""
          data-modal-open={next}
          aria-describedby={failed ? `${id}-e` : undefined}
        >
          <i className="ic ic-key" aria-hidden="true" />
          패스키로 확인
        </button>
      </div>
    </Modal>
  );
}

/** 정산 계좌 바꾸기(CMP-062 payout, 보드 showPayoutDlg·holderErr) */
export function PayoutChangeDialog({ id, defaultOpen, holderError, doneHref }: { id: string; defaultOpen?: boolean; holderError?: boolean; doneHref: string }) {
  const sfx = holderError ? '-x' : '';
  return (
    <Modal id={id} defaultOpen={defaultOpen} labelledBy={`${id}-t`} describedBy={`${id}-d`} maxWidth={480}>
      <h2 className="dialog-title" id={`${id}-t`}>
        정산 계좌 바꾸기
      </h2>
      <nav className="stepper" aria-label="계좌 변경 단계">
        <span className="step is-done">
          <span className="step-num">
            <i className="ic ic-check" aria-hidden="true" />
          </span>
          다시 인증<span className="sr-only">(완료)</span>
        </span>
        <span className="step-line is-done" />
        <span className="step is-current" aria-current="step">
          <span className="step-num">2</span>새 계좌 입력
        </span>
      </nav>
      <div className="banner banner-success" role="status">
        <i className="ic ic-check-circle" aria-hidden="true" />
        <div className="banner-body">비밀번호와 인증 앱 코드로 다시 인증하고, 패스키로 한 번 더 확인했습니다. 이 인증은 5분 안에 한 번 쓸 수 있습니다.</div>
      </div>
      <div className="col" style={{ gap: 16 }}>
        <div className="field">
          <label className="label" htmlFor={`${id}-bank${sfx}`}>
            은행
          </label>
          <div className="input-group">
            <select id={`${id}-bank${sfx}`} autoComplete="off" defaultValue={holderError ? '○○은행' : '은행을 고르세요'} data-autofocus={holderError ? undefined : ''}>
              <option>은행을 고르세요</option>
              {holderError ? <option>○○은행</option> : <option>[은행 목록]</option>}
            </select>
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-num${sfx}`}>
            계좌번호
          </label>
          <input
            className="input"
            id={`${id}-num${sfx}`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="숫자만 입력합니다"
            defaultValue={holderError ? '[계좌번호 자리 표시]' : undefined}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-holder${sfx}`}>
            예금주
          </label>
          <input
            className={holderError ? 'input is-error' : 'input'}
            id={`${id}-holder${sfx}`}
            type="text"
            autoComplete="off"
            defaultValue={holderError ? '[예금주 자리 표시]' : undefined}
            aria-invalid={holderError || undefined}
            aria-describedby={holderError ? `${id}-holder-e` : `${id}-holder-h`}
            data-autofocus={holderError ? '' : undefined}
          />
          {holderError ? (
            <span className="error-msg" id={`${id}-holder-e`} role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다
            </span>
          ) : (
            <span className="hint" id={`${id}-holder-h`}>
              예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다
            </span>
          )}
        </div>
      </div>
      <p className="t-sm" id={`${id}-d`}>
        바꾸면 3영업일 동안 지급이 보류됩니다. 계좌번호는 저장하지 않고 결제사 지급대행 등록에 바로 넘깁니다.
      </p>
      <div className={SHEET_ACTIONS}>
        <CancelButton>바꾸지 않고 닫기</CancelButton>
        <Link className={`btn btn-primary ${SHEET_PRIMARY}`} href={doneHref}>
          계좌를 바꾸고 3영업일 지급을 보류합니다
        </Link>
      </div>
    </Modal>
  );
}
