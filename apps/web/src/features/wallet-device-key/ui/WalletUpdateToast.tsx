'use client';
// '새 버전이 있습니다 [ 새로고침 ]' 토스트(docs/design/d5-screen-blueprint.md §3.1, docs/frontend.md §5.4 '갱신' ③④, HOT-390).
// - 월렛 등록에 waiting 워커가 있고, 어느 탭도 QR 잠금을 쥐지 않았고, 지금 화면이 대기실·좌석·결제·티켓이 아닐 때만 띄운다.
// - [새로고침]은 잠금을 한 번 더 보고 비었을 때만 SKIP_WAITING을 보낸 뒤, 새 워커가 활성화되면(controllerchange 또는 activated) 새로 읽는다.
//   그 사이 다른 탭이 QR을 열었으면 아무것도 보내지 않고 토스트를 닫는다.
// - Web Locks가 없는 브라우저는 띄우지 않는다(다음 방문 때 브라우저 기본 규칙으로 바뀐다).
// 셸은 월렛 등록이 있을 때만 이 모듈을 늦게 불러온다(WalletUpdateLoader). 첫 JS에 들지 않는다.
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { applyWaitingUpdate, qrLockHeld, shouldOfferUpdate, WALLET_SCOPE_URL } from '../update-hold';

/** 다른 탭이 QR을 닫았는지 다시 보는 간격 [가정] */
const RECHECK_MS = 30_000;

export function WalletUpdateToast() {
  const pathname = usePathname();
  const [offer, setOffer] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const check = useCallback(async () => {
    try {
      const registration = await navigator.serviceWorker.getRegistration(WALLET_SCOPE_URL);
      const held = await qrLockHeld(navigator.locks);
      setOffer(shouldOfferUpdate({ hasWaiting: Boolean(registration?.waiting), qrLockHeld: held, pathname: window.location.pathname }));
    } catch {
      setOffer(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check, pathname]);

  useEffect(() => {
    let registration: ServiceWorkerRegistration | undefined;
    const onUpdateFound = () => registration?.installing?.addEventListener('statechange', () => void check());
    void navigator.serviceWorker.getRegistration(WALLET_SCOPE_URL).then((r) => {
      registration = r;
      r?.addEventListener('updatefound', onUpdateFound);
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    const recheck = setInterval(() => void check(), RECHECK_MS);
    return () => {
      registration?.removeEventListener('updatefound', onUpdateFound);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(recheck);
    };
  }, [check]);

  const refresh = useCallback(async () => {
    const registration = await navigator.serviceWorker.getRegistration(WALLET_SCOPE_URL);
    const waiting = registration?.waiting;
    const result = await applyWaitingUpdate({ registration, locks: navigator.locks });
    if (result !== 'sent' || !waiting) {
      setDismissed(true);
      return;
    }
    let reloaded = false;
    const reload = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    // 월렛 범위 밖 화면은 이 워커가 제어하지 않아 controllerchange가 오지 않으므로 워커 상태도 함께 본다
    navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    waiting.addEventListener('statechange', () => {
      if (waiting.state === 'activated') reload();
    });
  }, []);

  // 보류 화면(대기실·좌석·결제·티켓)으로 옮기면 shouldOfferUpdate가 거짓이라 바로 숨는다
  if (!offer || dismissed || !shouldOfferUpdate({ hasWaiting: true, qrLockHeld: false, pathname })) return null;
  return (
    <div className="toast fixed bottom-4 left-1/2 z-[90] -translate-x-1/2" role="status">
      <i className="ic ic-refresh" aria-hidden="true" />
      새 버전이 있습니다
      <button className="btn btn-sm ml-1" type="button" onClick={() => void refresh()}>
        새로고침
      </button>
    </div>
  );
}

