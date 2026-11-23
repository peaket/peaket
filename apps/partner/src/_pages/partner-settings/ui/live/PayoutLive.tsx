'use client';
// SCR-020 '정산 계좌' 실제 API 판(openapi getPartnerPayoutAccount·putPartnerPayoutAccount, ADR-0370 결정 5·9, d5 §6.1 ⑥).
// [계좌 바꾸기](파트너 관리자) → 재인증(비밀번호·인증 앱 코드 → 패스키, act PAYOUT_ACCOUNT) → 새 계좌 입력 → PUT(If-Match = 읽은 판) → 완료.
// 계좌는 은행과 끝 4자리만 그린다. 입력한 계좌번호는 이 부품 상태에만 두고 PUT 뒤·닫을 때 지운다(저장소·주소·로그 없음).
// 재인증 실행부(WebAuthn 변환)는 누를 때 늦게 가져온다(docs/frontend.md §4.1).
import { useState } from 'react';
import { REFUND_BANKS } from '@peaket/validation/refund-account';
import { getPayoutAccount, putPayoutAccount } from '@/shared/api/partner-live';
import { isProblem } from '@/shared/api/problem';
import { ErrorCard, LoadingCard, useAsync } from '@/shared/ui/Async';
import { Modal } from '@/shared/ui/Modal';
import { payoutAccountView, payoutProblemMessage } from '../../model/payout-live';

const BANK_NAMES: Readonly<Record<string, string>> = Object.fromEntries(REFUND_BANKS.map((b) => [b.code, b.label]));
const ROLE_REASON = '이 작업은 파트너 관리자만 할 수 있습니다';

type Step = 'closed' | 'reauth' | 'change';

export function PayoutLive({ isMember }: { isMember: boolean }) {
  const account = useAsync('payout-account', (signal) => getPayoutAccount(signal));
  const [step, setStep] = useState<Step>('closed');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [reauthToken, setReauthToken] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [holderName, setHolderName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneHold, setDoneHold] = useState<string | null>(null);

  const view = account.status === 'ready' ? payoutAccountView(account.data, BANK_NAMES) : null;

  function clearInputs() {
    setPassword('');
    setCode('');
    setReauthToken('');
    setBankCode('');
    setAccountNumber('');
    setHolderName('');
    setError(null);
  }

  function close() {
    clearInputs();
    setStep('closed');
  }

  function open() {
    if (isMember) return;
    clearInputs();
    setDoneHold(null);
    setStep('reauth');
  }

  async function reauth() {
    if (!password || !/^[0-9]{6}$/.test(code.replace(/\s/g, ''))) {
      setError('비밀번호와 인증 앱의 6자리 코드를 적어 주세요');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { requestReauth } = await import('@/shared/api/reauth');
      const token = await requestReauth('PAYOUT_ACCOUNT', { password, code: code.replace(/\s/g, '') });
      setPassword('');
      setCode('');
      setReauthToken(token);
      setStep('change');
    } catch (e) {
      setPassword('');
      setCode('');
      setError(isProblem(e) ? payoutProblemMessage(e) : '패스키로 확인하지 못했습니다. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (account.status !== 'ready' || !view) return;
    if (!bankCode || !/^[0-9]{6,20}$/.test(accountNumber) || holderName.trim().length === 0 || holderName.trim().length > 100) {
      setError(payoutProblemMessage({ status: 400, type: 'invalid-body' }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await putPayoutAccount(
        { bankCode, accountNumber, holderName: holderName.trim() },
        { ifMatch: `"${view.version}"`, reauthToken },
      );
      setAccountNumber('');
      setHolderName('');
      setBankCode('');
      setReauthToken('');
      setStep('closed');
      account.setData(next);
      setDoneHold(payoutAccountView(next, BANK_NAMES).holdUntilText);
    } catch (e) {
      // 재인증 토큰은 한 번만 쓴다. 실패하면 버리고, 403 reauth-required면 재인증 대화상자부터 다시 연다
      setReauthToken('');
      setAccountNumber('');
      const problem = isProblem(e) ? e : null;
      if (problem && problem.status === 403 && problem.type === 'reauth-required') {
        setStep('reauth');
      } else if (problem && (problem.status === 412 || problem.status === 428)) {
        setStep('closed');
        account.reload();
      } else {
        setStep('reauth');
      }
      setError(problem ? payoutProblemMessage(problem) : '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="page-head">
        <div className="col" style={{ gap: 4, flex: '1 1 320px', minWidth: 0 }}>
          <h1>정산 계좌</h1>
          <p className="t-sm muted" id="po-live-h">
            바꾸기 전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다. 계좌번호는 결제사 지급대행 등록에만 넘기고 PEAKET에는 은행과
            끝 4자리만 남깁니다.
          </p>
        </div>
        {isMember ? (
          <button className="btn btn-outline max-md:hidden" type="button" aria-disabled="true" aria-describedby="po-live-role">
            계좌 바꾸기
          </button>
        ) : (
          <button className="btn btn-outline max-md:hidden" type="button" aria-haspopup="dialog" aria-describedby="po-live-h" onClick={open} disabled={account.status !== 'ready'}>
            계좌 바꾸기
          </button>
        )}
      </div>

      {isMember ? (
        <p className="row t-sm tx-warning" id="po-live-role" style={{ gap: 6 }}>
          <i className="ic ic-lock ic-16" aria-hidden="true" />
          {ROLE_REASON}
        </p>
      ) : (
        <div className="card-flat pad md:hidden" role="note">
          <p className="t-sm">정산 계좌 바꾸기는 태블릿이나 데스크톱에서 합니다</p>
        </div>
      )}

      {doneHold ? (
        <div className="banner banner-success" role="status">
          <i className="ic ic-check-circle" aria-hidden="true" />
          <div className="banner-body">변경했습니다. {doneHold}까지 지급이 보류됩니다</div>
        </div>
      ) : null}
      {error && step === 'closed' ? (
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">{error}</div>
        </div>
      ) : null}
      {view?.agencySyncPending ? (
        <div className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">결제사 수정 대기</span>
            결제사 한 곳 이상에 새 계좌를 반영하지 못해 지급을 멈췄습니다. 계좌를 다시 내면 반영하지 못한 결제사에만 다시 보냅니다
          </div>
        </div>
      ) : null}

      {account.status === 'loading' ? <LoadingCard label="정산 계좌를 불러오는 중입니다" /> : null}
      {account.status === 'error' ? <ErrorCard error={account.error} onRetry={account.reload} fallback="정산 계좌를 불러오지 못했습니다" /> : null}

      {view ? (
        <section className="card pad-lg col gap-4 max-md:gap-3 max-md:p-4" aria-labelledby="h-po-live">
          <h2 className="t-lg" id="h-po-live">
            정산금 지급 계좌
          </h2>
          {view.empty ? (
            <p className="t-sm muted">아직 정산 계좌가 없습니다. 판매 승인 요청에서 낸 계좌가 결제사에 등록되면 여기에 보입니다.</p>
          ) : (
            <dl className="kv md:grid-cols-[132px_minmax(0,1fr)] md:[&_dd]:text-left" style={{ alignItems: 'center' }}>
              <dt>은행</dt>
              <dd>{view.bankName}</dd>
              <dt>계좌</dt>
              <dd className="num">
                <span aria-hidden="true">****</span>
                {view.last4}
                <span className="sr-only">(끝 4자리)</span>
              </dd>
              <dt>예금주</dt>
              <dd>
                {view.holderVerified ? (
                  <span className="badge badge-success">
                    <i className="ic ic-check" aria-hidden="true" />
                    예금주 확인 완료
                  </span>
                ) : (
                  <span className="badge badge-warning">예금주 확인 전</span>
                )}
              </dd>
              <dt>지급 보류</dt>
              <dd>
                {view.holdUntilText ? (
                  <span className="badge badge-warning">
                    <i className="ic ic-clock" aria-hidden="true" />
                    {view.holdUntilText}까지 보류(계좌 변경)
                  </span>
                ) : view.agencySyncPending ? (
                  <span className="badge badge-warning">결제사 수정 대기</span>
                ) : (
                  '없음'
                )}
              </dd>
            </dl>
          )}
          <div className="banner banner-info">
            <i className="ic ic-info" aria-hidden="true" />
            <div className="banner-body">예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다 · 바꾸면 3영업일 동안 지급이 보류됩니다</div>
          </div>
        </section>
      ) : null}

      {step === 'reauth' ? (
        <Modal id="po-live-reauth" defaultOpen persistent labelledBy="po-live-reauth-t" describedBy="po-live-reauth-d" maxWidth={440}>
          <h2 className="dialog-title" id="po-live-reauth-t">
            다시 인증합니다
          </h2>
          <nav className="stepper" aria-label="재인증 단계">
            <span className="step is-current" aria-current="step">
              <span className="step-num">1</span>비밀번호·인증 앱 코드
            </span>
            <span className="step-line" />
            <span className="step">
              <span className="step-num">2</span>패스키
            </span>
          </nav>
          <p className="t-sm" id="po-live-reauth-d">
            정산 계좌를 바꾸기 전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다.
          </p>
          {error ? (
            <span className="error-msg" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              {error}
            </span>
          ) : null}
          <div className="field">
            <label className="label" htmlFor="po-live-pw">
              비밀번호
            </label>
            <input className="input" id="po-live-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="po-live-otp">
              인증 앱의 6자리 코드
            </label>
            <input
              className="otp-input"
              id="po-live-otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <p className="t-xs muted">다음을 누르면 브라우저의 패스키 창이 열립니다.</p>
          <div className="dialog-actions">
            <button className="btn btn-outline" type="button" onClick={close}>
              바꾸지 않고 닫기
            </button>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void reauth()}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <i className="ic ic-key" aria-hidden="true" />}
              다시 인증하고 패스키로 확인
            </button>
          </div>
        </Modal>
      ) : null}

      {step === 'change' ? (
        <Modal id="po-live-change" defaultOpen persistent labelledBy="po-live-change-t" describedBy="po-live-change-d" maxWidth={480}>
          <h2 className="dialog-title" id="po-live-change-t">
            정산 계좌 바꾸기
          </h2>
          <div className="banner banner-success" role="status">
            <i className="ic ic-check-circle" aria-hidden="true" />
            <div className="banner-body">비밀번호와 인증 앱 코드로 다시 인증하고, 패스키로 한 번 더 확인했습니다. 이 인증은 5분 안에 한 번 쓸 수 있습니다.</div>
          </div>
          {error ? (
            <span className="error-msg" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              {error}
            </span>
          ) : null}
          <div className="field">
            <label className="label" htmlFor="po-live-bank">
              은행
            </label>
            <div className="input-group">
              <select id="po-live-bank" autoComplete="off" value={bankCode} onChange={(e) => setBankCode(e.target.value)}>
                <option value="">은행을 고르세요</option>
                {REFUND_BANKS.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.label}
                  </option>
                ))}
              </select>
              <i className="ic ic-chevron-down" aria-hidden="true" />
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="po-live-num">
              계좌번호
            </label>
            <input
              className="input"
              id="po-live-num"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="숫자만 입력합니다"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, '').slice(0, 20))}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="po-live-holder">
              예금주
            </label>
            <input
              className="input"
              id="po-live-holder"
              type="text"
              autoComplete="off"
              maxLength={100}
              value={holderName}
              onChange={(e) => setHolderName(e.target.value)}
              aria-describedby="po-live-holder-h"
            />
            <span className="hint" id="po-live-holder-h">
              예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다
            </span>
          </div>
          <p className="t-sm" id="po-live-change-d">
            바꾸면 3영업일 동안 지급이 보류됩니다. 계좌번호는 저장하지 않고 결제사 지급대행 등록에 바로 넘깁니다.
          </p>
          <div className="dialog-actions">
            <button className="btn btn-outline" type="button" onClick={close}>
              바꾸지 않고 닫기
            </button>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void submit()}>
              {busy ? <span className="spinner" aria-hidden="true" /> : null}
              계좌를 바꾸고 3영업일 지급을 보류합니다
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
