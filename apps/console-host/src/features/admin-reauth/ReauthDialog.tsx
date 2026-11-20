'use client';
// SCR-047 확정 승인 직전의 관제 admin 재인증(CMP-064 admin 모양, d5 §7.8 ④, authz-matrix §6).
// 비밀번호·TOTP를 확인하고, 서버가 요구하면 브라우저 패스키 창까지 마친 뒤 토큰을 부모에게 한 번 넘긴다.
// 토큰·비밀번호·인증 코드는 저장하지 않고, 창을 닫거나 성공하면 화면 상태에서도 지운다.
import { useState } from 'react';
import { Button } from '@peaket/ds/Button';
import { Overlay } from '@/shared/ui/Overlay';
import { requestApprovalReauth, reauthErrorMessage } from './api';

export interface ReauthDialogProps {
  open: boolean;
  onDone: (token: string) => void;
  onClose: () => void;
}

export function ReauthDialog({ open, onDone, onClose }: ReauthDialogProps) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const close = () => {
    if (busy) return;
    setPassword('');
    setCode('');
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (!password || !code.trim()) {
      setError('비밀번호와 인증 앱의 6자리 코드를 넣어 주세요');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await requestApprovalReauth({ password, code: code.trim() });
      setPassword('');
      setCode('');
      onDone(token);
    } catch (e) {
      setError(reauthErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={close}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="reauth-h" aria-describedby="reauth-d" style={{ maxWidth: 460 }}>
        <div className="row between" style={{ gap: 8 }}>
          <h2 className="dialog-title" id="reauth-h">
            다시 인증해 주세요
          </h2>
          <span className="badge badge-primary">
            <i className="ic ic-shield" aria-hidden="true" />
            admin
          </span>
        </div>
        <p className="t-sm" id="reauth-d">
          회차 취소 확정은 되돌릴 수 없습니다. 비밀번호와 인증 앱의 6자리 코드를 넣고, 이어서 뜨는 패스키 창에서 확인해 주세요.
        </p>
        <label className="field">
          <span className="label">비밀번호</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            maxLength={1024}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </label>
        <label className="field">
          <span className="label">인증 앱의 6자리 코드</span>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            maxLength={7}
            placeholder="123456"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {error ? (
          <p className="t-sm" role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button className="btn btn-outline" type="button" onClick={close} disabled={busy}>
            취소
          </button>
          <Button loading={busy} onClick={() => void submit()}>
            확인하고 계속
          </Button>
        </div>
        <p className="t-xs muted">패스키를 등록하지 않은 계정은 이 승인을 할 수 없습니다. 내 계정에서 패스키를 등록한 뒤 다시 시도해 주세요.</p>
      </section>
    </Overlay>
  );
}
