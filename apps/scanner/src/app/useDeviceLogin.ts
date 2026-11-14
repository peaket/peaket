// SCR-036 기기 승인 로그인의 실제 흐름(offline-gate §6.1, RFC 8628, GAT-220).
// 기기 키(DPoP)를 준비하고, 확인 코드를 받아 화면에 띄우고, 승인되면 스태프 토큰을 만료 시각과 함께 저장한다.
// 거부되면 새 코드를, 만료되면 새 코드를 받는다. 한도(429)·폐기 기기는 그 상태로 멈춘다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceLoginError, pollDeviceToken, startDeviceAuthorization } from '../api/device-login';
import type { DpopKey } from '../api/dpop';
import { ensureDeviceKey, saveStaffSession } from '../api/key-store';
import { SCANNER_API_ORIGIN } from '../api/config';

export type DeviceLoginPhase = 'starting' | 'waiting' | 'rejected' | 'approved' | 'limited' | 'revoked' | 'error';

export interface DeviceLoginView {
  phase: DeviceLoginPhase;
  code?: string;
  verificationUri?: string;
  expiresAtMs?: number;
  error?: string;
}

export function useDeviceLogin(enabled: boolean): DeviceLoginView {
  const [view, setView] = useState<DeviceLoginView>({ phase: 'starting' });
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const run = useCallback(async () => {
    let key: DpopKey;
    try {
      key = await ensureDeviceKey();
    } catch (e) {
      if (alive.current) setView({ phase: 'error', error: e instanceof Error ? e.message : '기기 키를 만들지 못했습니다' });
      return;
    }
    let restart = 0;
    while (alive.current) {
      try {
        const auth = await startDeviceAuthorization({ origin: SCANNER_API_ORIGIN, key });
        if (!alive.current) return;
        setView({ phase: 'waiting', code: auth.userCode, verificationUri: auth.verificationUriComplete, expiresAtMs: Date.now() + auth.expiresIn * 1000 });
        let intervalMs = Math.max(1, auth.interval) * 1000;
        const deadline = Date.now() + auth.expiresIn * 1000;
        for (;;) {
          await wait(intervalMs);
          if (!alive.current) return;
          if (Date.now() >= deadline) break;
          try {
            const grant = await pollDeviceToken({ origin: SCANNER_API_ORIGIN, key, deviceCode: auth.deviceCode });
            if (!alive.current) return;
            await saveStaffSession({ token: grant.accessToken, expiresAtMs: Date.now() + grant.expiresIn * 1000 });
            if (alive.current) setView({ phase: 'approved', code: auth.userCode, verificationUri: auth.verificationUriComplete });
            return;
          } catch (e) {
            if (!(e instanceof DeviceLoginError)) throw e;
            if (e.code === 'authorization_pending') continue;
            if (e.code === 'slow_down') {
              intervalMs = Math.max(intervalMs + 5_000, (e.intervalSec ?? 0) * 1000);
              continue;
            }
            if (e.code === 'access_denied') {
              if (alive.current) setView({ phase: 'rejected' });
              restart = 1_000;
              break;
            }
            if (e.code === 'expired_token') {
              restart = 0;
              break;
            }
            if (e.code === 'rate_limited') {
              if (alive.current) setView({ phase: 'limited', error: e.message });
              return;
            }
            if (e.code === 'device_revoked' || e.code === 'device_unregistered') {
              if (alive.current) setView({ phase: 'revoked', error: e.message });
              return;
            }
            if (alive.current) setView({ phase: 'error', error: e.message });
            return;
          }
        }
      } catch (e) {
        if (!alive.current) return;
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
  }, []);

  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    void run();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, run]);

  return view;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
