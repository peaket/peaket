'use client';
// SCR-020 '내 계정'의 실제 판(F-07-13). 인증 앱 다시 등록·복구 코드 다시 만들기·로그인 기기 세 줄만 실제 API로 잇는다.
// 재인증은 requestAccountSecurityReauth의 ACCOUNT_SECURITY 작업 묶음이고, 패스키가 있는 계정만 withPasskey를 켠다.
// 복구 코드는 한 번만 보이고 "저장했습니다" 전에는 닫지 않는다. 비밀번호·코드·재인증 토큰은 이 부품 상태에만 둔다.
import { useState } from 'react';
import {
  beginPartnerTotpEnrollment,
  confirmPartnerTotpEnrollment,
  deletePartnerAuthSession,
  getPartnerAuthSecuritySettings,
  getPartnerAuthSessions,
  recreatePartnerRecoveryCodes,
} from '@/shared/api/partner-live';
import { isProblem } from '@/shared/api/problem';
import { ErrorCard, LoadingCard, useAsync } from '@/shared/ui/Async';
import { Modal } from '@/shared/ui/Modal';
import { accountSecurityProblemMessage, accountSecurityView, deviceRowActions, deviceSessionsView, reauthFailureText, recoveryCodeDialogState, reauthWithPasskey } from '../../model/account-live';

type Action = 'totp' | 'recovery' | 'device';

export function AccountSecurityLive() {
  const summary = useAsync('account-security', (signal) => getPartnerAuthSecuritySettings(signal));
  const sessions = useAsync('account-sessions', (signal) => getPartnerAuthSessions(signal));
  const [action, setAction] = useState<Action | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [step, setStep] = useState<'closed' | 'reauth' | 'totp' | 'codes'>('closed');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [reauthToken, setReauthToken] = useState('');
  const [otpauthUri, setOtpauthUri] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const view = summary.status === 'ready' ? accountSecurityView(summary.data) : null;
  const devices = sessions.status === 'ready' ? deviceSessionsView(sessions.data, Date.now()) : [];

  function clearSecrets() {
    setPassword('');
    setCode('');
    setReauthToken('');
    setTotpCode('');
    setError(null);
  }

  function closeAll() {
    clearSecrets();
    setOtpauthUri('');
    setRecoveryCodes([]);
    setSaved(false);
    setAction(null);
    setTarget(null);
    setStep('closed');
  }

  function start(next: Action, sessionId?: string) {
    clearSecrets();
    setOtpauthUri('');
    setRecoveryCodes([]);
    setSaved(false);
    setAction(next);
    setTarget(sessionId ?? null);
    setStep('reauth');
  }

  async function finishReauth() {
    if (!password || !/^\d{6}$/.test(code.replace(/\s/g, ''))) {
      setError('비밀번호와 인증 앱의 6자리 코드를 적어 주세요');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { requestAccountSecurityReauth } = await import('@/shared/api/reauth');
      const token = await requestAccountSecurityReauth({ password, code: code.replace(/\s/g, ''), withPasskey: reauthWithPasskey(view?.passkeyCount ?? 0) });
      setPassword('');
      setCode('');
      setReauthToken(token);
      if (action === 'totp') {
        const next = await beginPartnerTotpEnrollment(token);
        setOtpauthUri(next.otpauthUri);
        setStep('totp');
      } else if (action === 'recovery') {
        const next = await recreatePartnerRecoveryCodes(token);
        setRecoveryCodes(next.recoveryCodes);
        setSaved(false);
        setStep('codes');
        // 다시 만든 뒤 요약의 '남은 코드'도 10개로 맞춘다(IR13-05)
        summary.reload();
      } else if (action === 'device' && target) {
        await deletePartnerAuthSession(target, token);
        setReauthToken('');
        setStep('closed');
        setAction(null);
        setTarget(null);
        sessions.reload();
      }
    } catch (e) {
      setPassword('');
      setCode('');
      setReauthToken('');
      const problem = isProblem(e) ? e : null;
      if (problem && problem.status === 404 && problem.type === 'session-not-found') {
        sessions.reload();
        setStep('closed');
        setAction(null);
        setTarget(null);
      }
      setError(problem ? accountSecurityProblemMessage(problem) : reauthFailureText(e));
    } finally {
      setBusy(false);
    }
  }

  async function finishTotp() {
    if (!/^\d{6}$/.test(totpCode.replace(/\s/g, ''))) {
      setError('인증 앱의 6자리 코드를 적어 주세요');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await confirmPartnerTotpEnrollment(totpCode.replace(/\s/g, ''));
      setTotpCode('');
      setOtpauthUri('');
      setReauthToken('');
      setRecoveryCodes(next.recoveryCodes);
      setSaved(false);
      setStep('codes');
      summary.reload();
    } catch (e) {
      setTotpCode('');
      setError(isProblem(e) ? accountSecurityProblemMessage(e) : '인증 앱 코드를 확인하지 못했습니다');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <section className="card col px-6 pb-1.5 pt-5 max-md:px-4 max-md:pb-1 max-md:pt-4" aria-labelledby="h-sec-live">
        <h2 className="t-lg" id="h-sec-live" style={{ paddingBottom: 14 }}>
          보안
        </h2>
        {summary.status === 'loading' ? <LoadingCard label="보안 설정을 불러오는 중입니다" /> : null}
        {summary.status === 'error' ? <ErrorCard error={summary.error} onRetry={summary.reload} fallback="보안 설정을 불러오지 못했습니다" /> : null}
        {view ? (
          <>
            <div className="row between" style={{ padding: '14px 0', borderTop: '1px solid var(--border)', gap: 12 }}>
              <div className="col" style={{ gap: 4 }}>
                <h3 className="t-md fw-b">비밀번호</h3>
                <p className="t-sm">비밀번호 변경은 다음 기능에서 다룹니다</p>
                <p className="t-xs muted">15자 이상 · 유출된 적 있는 비밀번호는 쓸 수 없습니다</p>
              </div>
              <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" disabled>
                비밀번호 바꾸기
              </button>
            </div>
            <div className="row between" style={{ padding: '14px 0', borderTop: '1px solid var(--border)', gap: 12 }}>
              <div className="col" style={{ gap: 4 }}>
                <h3 className="t-md fw-b">인증 앱</h3>
                <p className="t-sm">{view.totpText}</p>
                <p className="t-xs muted">로그인할 때마다 인증 앱의 6자리 코드를 씁니다</p>
              </div>
              <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" onClick={() => start('totp')}>
                인증 앱 다시 등록
              </button>
            </div>
            <div className="row between" style={{ padding: '14px 0', borderTop: '1px solid var(--border)', gap: 12 }}>
              <div className="col" style={{ gap: 4 }}>
                <h3 className="t-md fw-b">패스키</h3>
                <p className="t-sm">{view.passkeyCount > 0 ? `등록된 패스키 ${view.passkeyCount}개` : '등록된 패스키 없음'}</p>
                <p className="t-xs muted">패스키 등록·지우기는 다음 기능에서 다룹니다. 패스키가 있으면 재인증 때 한 번 더 확인합니다</p>
              </div>
              <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" disabled>
                패스키 관리
              </button>
            </div>
            <div className="row between" style={{ padding: '14px 0', borderTop: '1px solid var(--border)', gap: 12 }}>
              <div className="col" style={{ gap: 4 }}>
                <h3 className="t-md fw-b">복구 코드</h3>
                <p className="t-sm">{view.recoveryText}</p>
                <p className="t-xs muted">인증 앱을 쓸 수 없을 때 코드 하나를 한 번 씁니다</p>
              </div>
              <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" onClick={() => start('recovery')}>
                다시 만들기
              </button>
            </div>
          </>
        ) : null}
      </section>

      <section className="card col px-6 pb-1.5 pt-5 max-md:px-4 max-md:pb-1 max-md:pt-3.5" aria-labelledby="h-dev-live">
        <div className="row between" style={{ paddingBottom: 14 }}>
          <h2 className="t-lg" id="h-dev-live">
            로그인 기기
          </h2>
          <span className="t-sm muted">최대 {view?.sessionLimit ?? 2}대</span>
        </div>
        {sessions.status === 'loading' ? <LoadingCard label="로그인 기기를 불러오는 중입니다" /> : null}
        {sessions.status === 'error' ? <ErrorCard error={sessions.error} onRetry={sessions.reload} fallback="로그인 기기를 불러오지 못했습니다" /> : null}
        {sessions.status === 'ready' && devices.length === 0 ? <p className="t-sm muted">지금 로그인한 기기만 있습니다</p> : null}
        {devices.map((d) => {
          const { canLogout, canEndOtherLogins } = deviceRowActions(d);
          return (
            <div key={d.sessionId} className="row" style={{ gap: 12, padding: d.current ? '14px 0' : '10px 0', borderTop: '1px solid var(--border)' }}>
              <i className={`ic ${d.current ? 'ic-monitor' : 'ic-tablet'} muted`} aria-hidden="true" />
              <span className={d.current ? 't-sm fw-b grow' : 't-sm grow'}>
                {d.label} · {d.lastActiveText}
              </span>
              {canEndOtherLogins ? (
                <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" onClick={() => start('device', d.sessionId)}>
                  이 기기의 다른 로그인 끝내기
                </button>
              ) : null}
              {canLogout ? (
                <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" onClick={() => start('device', d.sessionId)}>
                  로그아웃
                </button>
              ) : null}
            </div>
          );
        })}
      </section>

      {step === 'reauth' ? (
        <Modal id="account-security-reauth" defaultOpen persistent labelledBy="as-reauth-t" maxWidth={440}>
          <h2 className="dialog-title" id="as-reauth-t">
            다시 인증합니다
          </h2>
          <p className="t-sm">
            {action === 'device' ? '다른 기기를 로그아웃하기 전에 ' : '보안 설정을 바꾸기 전에 '}
            비밀번호와 인증 앱 코드로 다시 인증합니다. 등록한 패스키가 있으면 패스키로 한 번 더 확인합니다.
          </p>
          {error ? (
            <span className="error-msg" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              {error}
            </span>
          ) : null}
          <div className="field">
            <label className="label" htmlFor="as-pw">
              비밀번호
            </label>
            <input className="input" id="as-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="as-otp">
              인증 앱의 6자리 코드
            </label>
            <input className="otp-input" id="as-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="dialog-actions">
            <button className="btn btn-outline" type="button" onClick={closeAll}>
              닫기
            </button>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void finishReauth()}>
              {busy ? <span className="spinner" aria-hidden="true" /> : null}
              다시 인증
            </button>
          </div>
        </Modal>
      ) : null}

      {step === 'totp' ? (
        <Modal id="account-security-totp" defaultOpen persistent labelledBy="as-totp-t" maxWidth={480}>
          <h2 className="dialog-title" id="as-totp-t">
            인증 앱 다시 등록
          </h2>
          <p className="t-sm">인증 앱에 아래 주소를 넣거나 비밀 키를 직접 입력한 뒤, 앱에 표시되는 6자리 코드를 넣어 주세요.</p>
          <p className="t-xs muted">QR 코드 대신 otpauth 주소와 비밀 키를 글로 보입니다.</p>
          <code className="t-xs" style={{ wordBreak: 'break-all', background: 'var(--surface-muted)', padding: 8, borderRadius: 'var(--r-md)' }}>
            {otpauthUri}
          </code>
          {error ? (
            <span className="error-msg" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              {error}
            </span>
          ) : null}
          <div className="field">
            <label className="label" htmlFor="as-totp-code">
              인증 앱의 6자리 코드
            </label>
            <input className="otp-input" id="as-totp-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
          </div>
          <div className="dialog-actions">
            <button className="btn btn-outline" type="button" onClick={closeAll}>
              닫기
            </button>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void finishTotp()}>
              {busy ? <span className="spinner" aria-hidden="true" /> : null}
              인증 앱 등록을 마칩니다
            </button>
          </div>
        </Modal>
      ) : null}

      {step === 'codes' ? (
        <Modal id="account-security-codes" defaultOpen persistent labelledBy="as-codes-t" maxWidth={480}>
          <h2 className="dialog-title" id="as-codes-t">
            복구 코드
          </h2>
          <p className="t-sm">아래 코드는 이 화면에서 한 번만 보입니다. 안전한 곳에 저장해 주세요.</p>
          <div className="col" style={{ gap: 4 }}>
            {recoveryCodes.map((c) => (
              <code key={c} className="t-sm">
                {c}
              </code>
            ))}
          </div>
          <label className="row t-sm" style={{ gap: 8 }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            저장했습니다
          </label>
          <div className="dialog-actions">
            <button className="btn btn-primary" type="button" disabled={!recoveryCodeDialogState(saved).closeEnabled} onClick={closeAll}>
              닫기
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
