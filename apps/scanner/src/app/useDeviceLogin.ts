// SCR-036 기기 승인 로그인의 실제 흐름(offline-gate §6.1, RFC 8628, GAT-220).
// 기기 키(DPoP)를 준비하고, 확인 코드를 받아 화면에 띄우고, 승인되면 스태프 토큰을 만료 시각과 함께 저장한다.
// 거부되면 새 코드를, 만료되면 새 코드를 받는다. 한도(429)·폐기 기기는 그 상태로 멈춘다.
import { useEffect, useState } from 'react';
import { DeviceLoginError, pollDeviceToken, qrDataUrlOf, startDeviceAuthorization } from '../api/device-login';
import type { DpopKey } from '../api/dpop';
import { ensureDeviceKey, saveStaffSession } from '../api/key-store';
import { SCANNER_API_ORIGIN } from '../api/config';

export type DeviceLoginPhase = 'starting' | 'waiting' | 'rejected' | 'approved' | 'limited' | 'revoked' | 'error';

export interface DeviceLoginView {
  phase: DeviceLoginPhase;
  code?: string;
  verificationUri?: string;
  /** 실제 QR 그림(data URL). 승인 화면이 가짜 무늬 대신 이것을 그린다 */
  qrDataUrl?: string;
  expiresAtMs?: number;
  error?: string;
}

export function useDeviceLogin(enabled: boolean): DeviceLoginView {
  const [view, setView] = useState<DeviceLoginView>({ phase: 'starting' });

  useEffect(() => {
    if (!enabled) return;
    // React StrictMode가 효과를 두 번 돌려도 각 실행이 자기 멈춤 신호를 갖는다.
    // 한 ref를 함께 쓰면 첫 실행의 폴링이 살아남아 두 번째 흐름의 화면을 덮어쓴다.
    let active = true;
    const isActive = () => active;

    const run = async (): Promise<void> => {
      let key: DpopKey;
      try {
        key = await ensureDeviceKey();
      } catch (e) {
        if (isActive()) setView({ phase: 'error', error: e instanceof Error ? e.message : '기기 키를 만들지 못했습니다' });
        return;
      }
      let restart = 0;
      while (isActive()) {
        try {
          const auth = await startDeviceAuthorization({ origin: SCANNER_API_ORIGIN, key });
          if (!isActive()) return;
          // 실제 QR은 승인 화면에서만 필요하므로 동적 import로 초기 번들에서 뺀다.
          const qrDataUrl = await qrDataUrlOf(auth.verificationUriComplete);
          if (!isActive()) return;
          setView({ phase: 'waiting', code: auth.userCode, verificationUri: auth.verificationUriComplete, ...(qrDataUrl ? { qrDataUrl } : {}), expiresAtMs: Date.now() + auth.expiresIn * 1000 });
          let intervalMs = Math.max(1, auth.interval) * 1000;
          const deadline = Date.now() + auth.expiresIn * 1000;
          for (;;) {
            await wait(intervalMs);
            if (!isActive()) return;
            if (Date.now() >= deadline) break;
            try {
              const grant = await pollDeviceToken({ origin: SCANNER_API_ORIGIN, key, deviceCode: auth.deviceCode });
              if (!isActive()) return;
              await saveStaffSession({ token: grant.accessToken, expiresAtMs: Date.now() + grant.expiresIn * 1000 });
              if (isActive()) setView({ phase: 'approved', code: auth.userCode, verificationUri: auth.verificationUriComplete });
              return;
            } catch (e) {
              if (!(e instanceof DeviceLoginError)) throw e;
              if (e.code === 'authorization_pending') continue;
              if (e.code === 'slow_down') {
                intervalMs = Math.max(intervalMs + 5_000, (e.intervalSec ?? 0) * 1000);
                continue;
              }
              if (e.code === 'access_denied') {
                if (isActive()) setView({ phase: 'rejected' });
                restart = 1_000;
                break;
              }
              if (e.code === 'expired_token') {
                restart = 0;
                break;
              }
              if (e.code === 'rate_limited') {
                if (isActive()) setView({ phase: 'limited', error: e.message });
                return;
              }
              if (e.code === 'device_revoked' || e.code === 'device_unregistered') {
                if (isActive()) setView({ phase: 'revoked', error: e.message });
                return;
              }
              if (isActive()) setView({ phase: 'error', error: e.message });
              return;
            }
          }
        } catch (e) {
          if (!isActive()) return;
          if (e instanceof DeviceLoginError && e.code === 'rate_limited') {
            setView({ phase: 'limited', error: e.message });
            return;
          }
          if (e instanceof DeviceLoginError && (e.code === 'device_revoked' || e.code === 'device_unregistered')) {
            setView({ phase: 'revoked', error: e.message });
            return;
          }
          setView({ phase: 'error', error: e instanceof Error ? e.message : '기기 승인 로그인에 닿지 못했습니다' });
          return;
        }
        if (restart > 0) await wait(restart);
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [enabled]);

  return view;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
