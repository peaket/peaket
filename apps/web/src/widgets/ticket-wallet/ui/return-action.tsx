'use client';
// SCR-013 돌려주기: 확인 대화상자 → 재인증 왕복. 받은 티켓 카드에서만 쓰므로 WalletLive가 늦게 가져온다
// (docs/frontend.md §5.8 월렛 첫 JS 예산, CI 실행 45240606103).
import { useId, useState } from 'react';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { WebShellModal } from '@peaket/ds/WebShell';
import { ORIGINS } from '@/shared/config/origins';
import { submitReauthForm } from '@/shared/lib/reauth-return';
import { reauthProviderFor, returnReauthTarget } from '../model/transfer-rules';

/** SCR-013 돌려주기: 확인 대화상자 → 재인증 왕복 → 돌아오면 WalletLive가 POST와 동기화를 마친다 */
export function ReturnAction({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const descId = `${useId()}-desc`;
  const start = async () => {
    setBusy(true);
    setNotice(null);
    const origin = ORIGINS.api;
    if (origin === '') {
      setNotice('지금은 돌려줄 수 없습니다. 잠시 뒤 다시 시도해 주세요');
      setBusy(false);
      return;
    }
    try {
      const r = await fetch(`${origin}/v1/identity/providers`, { credentials: 'include', headers: { accept: 'application/json' } });
      const body = r.status === 200 ? ((await r.json()) as { providers?: { provider?: unknown }[] }) : { providers: [] };
      const linked = (body.providers ?? []).map((p) => p.provider).filter((p): p is string => typeof p === 'string' && p.length > 0);
      const provider = reauthProviderFor(linked);
      if (provider === undefined) {
        setNotice('다시 로그인할 수단을 찾지 못했습니다. 로그인 수단을 확인한 뒤 다시 시도해 주세요');
        return;
      }
      const pending = { ticketId, key: crypto.randomUUID() };
      sessionStorage.setItem('peaket.return.reauth', JSON.stringify(pending));
      const target = returnReauthTarget(ticketId);
      submitReauthForm(provider, target.returnTo, target.purpose);
    } catch {
      setNotice('연결을 확인한 뒤 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        결제자에게 돌려주기
      </button>
      <WebShellModal open={open} onClose={() => setOpen(false)} title="돌려주면 이 휴대폰의 입장 키가 지워집니다" describedBy={descId} icon={<i className="ic ic-undo" aria-hidden="true" />} iconTone="warning">
        <p className="t-sm" id={descId}>
          돌려주기 전에 다시 로그인하며, 입장이 시작되면 돌려줄 수 없습니다.
        </p>
        {notice ? (
          <NoticeBanner tone="danger" role="alert">
            {notice}
          </NoticeBanner>
        ) : null}
        <div className="col gap-2 md:flex-row-reverse md:flex-wrap md:items-center md:justify-start">
          <button className="btn btn-primary btn-lg btn-block md:inline-flex md:w-auto" type="button" disabled={busy} onClick={() => void start()}>
            돌려주기
          </button>
          <button className="btn btn-ghost btn-block md:inline-flex md:w-auto" type="button" onClick={() => setOpen(false)}>
            닫기
          </button>
        </div>
      </WebShellModal>
    </>
  );
}
