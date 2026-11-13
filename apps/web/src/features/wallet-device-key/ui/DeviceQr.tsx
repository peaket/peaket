'use client';
// SCR-013 월렛의 실제 회전 QR(FR-012, POL-018, ADR-0025·0051, offline-gate §2·§3, CMP-029).
// - '이 휴대폰을 입장용으로 등록'을 눌러야만 WebCrypto ECDSA P-256 키를 만든다(extractable=false).
//   키는 IndexedDB(`peaket-wallet`)에 CryptoKey 그대로 두고, keyId(SPKI SHA-256 앞 8바이트)만 화면에 보인다.
// - 15초마다 그 순간의 보정 시각(browserClock)으로 QR v1(93바이트)을 다시 서명하고 base45 140자를 QR로 그린다.
//   화면이 다시 보이면(visibilitychange) 그 순간에도 다시 서명한다. 네트워크와 무관하다.
// - 티켓 스냅샷과 마지막 동기화 시각을 IndexedDB에 남겨 서비스 워커가 셸을 연 뒤 오프라인에서도 같은 화면을 그린다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { QrPattern, QrStatus, useScreenWakeLock } from '@peaket/ds/RotatingQR';
import { browserClock } from '@/shared/lib/clock';
import { generateDeviceKey } from '../device-key';
import { createQrFrame, msUntilNextQrFrame, qrClockText, qrFrameStale, qrTimeSeconds, type QrFrame } from '../frame';
import { qrMatrix } from '../qr-matrix';
import { keyIdFromBase64Url } from '../qr-v1';
import { registerDeviceKey } from '../register';
import {
  deleteDeviceKey,
  loadDeviceKey,
  requestPersistentStorage,
  saveDeviceKey,
  saveLastSyncedAt,
  saveTicketSnapshot,
  type StoredDeviceKey,
  type WalletTicketSnapshot,
} from '../store';

type Phase = 'loading' | 'no-key' | 'registering' | 'ready' | 'error';

export interface DeviceQrSnapshot extends Omit<WalletTicketSnapshot, 'ticketId' | 'updatedAt'> {}

export interface DeviceQrProps {
  /** 티켓 UUIDv7. QR v1은 이 값을 16바이트로 싣는다 */
  ticketId: string;
  /** 대체 텍스트(티켓 표시 ID·좌석) */
  label: string;
  maxWidth?: number;
  /** 오프라인 미리보기 상태. 등록 버튼을 이유 있는 비활성으로 그린다 */
  offline?: boolean;
  /** 오프라인 진입용 티켓 스냅샷. 있으면 IndexedDB에 저장한다 */
  snapshot?: DeviceQrSnapshot;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 오류입니다';
}

export function DeviceQr({ ticketId, label, maxWidth = 324, offline = false, snapshot }: DeviceQrProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [key, setKey] = useState<StoredDeviceKey | null>(null);
  const [frame, setFrame] = useState<QrFrame | null>(null);
  const [matrix, setMatrix] = useState<ReturnType<typeof qrMatrix> | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const mounted = useRef(true);

  useScreenWakeLock(phase === 'ready');

  const boot = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const stored = await loadDeviceKey(ticketId);
      if (!mounted.current) return;
      setKey(stored ?? null);
      setPhase(stored ? 'ready' : 'no-key');
    } catch (e) {
      if (!mounted.current) return;
      setError(errorText(e));
      setPhase('error');
    }
  }, [ticketId]);

  useEffect(() => {
    mounted.current = true;
    void boot();
    void requestPersistentStorage();
    return () => {
      mounted.current = false;
    };
  }, [boot]);

  // 오프라인 진입용 티켓 스냅샷과 마지막 동기화 시각. 온라인일 때만 동기화 시각을 올린다.
  useEffect(() => {
    if (!snapshot) return;
    void saveTicketSnapshot({ ...snapshot, ticketId, updatedAt: Date.now() });
    if (typeof navigator === 'undefined' || navigator.onLine) void saveLastSyncedAt();
  }, [snapshot, ticketId]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const refresh = useCallback(
    async (atMs: number) => {
      if (!key) return;
      try {
        const signer = { privateKey: key.privateKey, keyId: keyIdFromBase64Url(key.keyId), keyIdText: key.keyId };
        const next = await createQrFrame(signer, ticketId, qrTimeSeconds(atMs));
        if (!mounted.current) return;
        setFrame(next);
        setMatrix(qrMatrix(next.text));
        setStale(false);
        setError(null);
      } catch (e) {
        if (!mounted.current) return;
        setStale(true);
        setError(errorText(e));
      }
    },
    [key, ticketId],
  );

  // 15초 경계마다 다시 서명하고, '지금' 글자는 1초마다 움직인다. 화면이 다시 보이면 그 순간 다시 서명한다.
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      const now = browserClock().now();
      setNowMs(now);
      await refresh(now);
      if (cancelled) return;
      timer = setTimeout(() => void run(), msUntilNextQrFrame(browserClock().now()));
    };
    // 페이지를 열거나 다시 보인 순간에는 기기 시계 + 마지막 오차로 단조 기준을 다시 잡는다.
    browserClock().reset();
    void run();
    const ticker = setInterval(() => setNowMs(browserClock().now()), 1000);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      browserClock().reset();
      const now = browserClock().now();
      setNowMs(now);
      void refresh(now);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(ticker);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, refresh]);

  const register = useCallback(async () => {
    setPhase('registering');
    setError(null);
    try {
      const generated = await generateDeviceKey();
      const stored: StoredDeviceKey = {
        ticketId,
        keyId: generated.keyIdText,
        privateKey: generated.privateKey,
        publicKeyJwk: generated.publicKeyJwk,
        createdAt: Date.now(),
        reason: 'ISSUE',
        registration: 'LOCAL',
      };
      await saveDeviceKey(stored);
      // ticket-svc device-keys 경로가 열리기 전에는 unavailable로 끝나고 키는 이 기기에만 남는다.
      const registered = await registerDeviceKey({ ticketId, publicKeyJwk: generated.publicKeyJwk, reason: 'ISSUE' });
      const next = registered.kind === 'registered' ? { ...stored, registration: 'REGISTERED' as const } : stored;
      if (registered.kind === 'registered') await saveDeviceKey(next);
      if (!mounted.current) return;
      setKey(next);
      setPhase('ready');
    } catch (e) {
      if (!mounted.current) return;
      setError(errorText(e));
      setPhase('error');
    }
  }, [ticketId]);

  const resetAndRegister = useCallback(async () => {
    try {
      await deleteDeviceKey(ticketId);
      setKey(null);
      setFrame(null);
      setMatrix(null);
      await register();
    } catch (e) {
      if (!mounted.current) return;
      setError(errorText(e));
      setPhase('error');
    }
  }, [register, ticketId]);

  const displayStale = stale || (frame ? qrFrameStale(frame.timeSeconds, nowMs) : false);
  const now = nowMs ? qrClockText(nowMs) : '--:--:--';

  if (phase === 'loading') {
    return (
      <div className="card-flat col items-center gap-3 px-4 py-7 text-center" style={{ minHeight: 400 }} aria-busy="true">
        <p className="t-sm muted">입장 QR을 준비하고 있습니다…</p>
      </div>
    );
  }

  if (phase === 'no-key' || phase === 'registering') {
    const disabled = !online || offline || phase === 'registering';
    return (
      <div className="card-flat col items-center gap-3 px-4 py-7 text-center" style={{ minHeight: 400 }}>
        <span className="state-icon is-primary">
          <i className="ic ic-phone" aria-hidden="true" />
        </span>
        <p className="t-md fw-b">입장할 때 쓸 휴대폰을 등록해야 QR이 나옵니다</p>
        <p className="t-sm muted">등록한 휴대폰에서만 입장 QR이 만들어집니다. 공연장에 가져갈 휴대폰에서 등록하세요.</p>
        <button
          className="btn btn-primary btn-lg btn-block"
          type="button"
          aria-label={`${label}, 이 휴대폰을 입장용으로 등록`}
          aria-disabled={disabled ? true : undefined}
          aria-describedby={disabled ? 'device-qr-why' : undefined}
          onClick={() => {
            if (!disabled) void register();
          }}
        >
          {phase === 'registering' ? '등록 중…' : '이 휴대폰을 입장용으로 등록'}
        </button>
        {disabled ? (
          <p className="t-xs muted" id="device-qr-why">
            {offline ? '오프라인에서는 새로 등록할 수 없습니다. 이미 등록한 기기는 오프라인에서도 QR이 나옵니다.' : '인터넷에 연결되면 등록할 수 있습니다.'}
          </p>
        ) : null}
        <p className="t-xs muted">키는 이 버튼으로만 만듭니다. 등록 뒤에는 오프라인에서도 15초마다 새 QR이 나옵니다.</p>
      </div>
    );
  }

  if (phase === 'error' || (stale && !frame)) {
    return (
      <div className="card-flat col items-center gap-3 px-4 py-7 text-center" style={{ minHeight: 400 }} role="alert">
        <span className="state-icon is-danger">
          <i className="ic ic-warning" aria-hidden="true" />
        </span>
        <p className="t-md fw-b">입장 QR을 만들지 못했습니다</p>
        <p className="t-sm muted">{error ?? '기기 키를 읽지 못했습니다'}</p>
        <button className="btn btn-outline btn-block" type="button" onClick={() => void boot()}>
          다시 시도
        </button>
        <button className="btn btn-ghost btn-block" type="button" onClick={() => void resetAndRegister()}>
          이 기기에 키 다시 만들기
        </button>
      </div>
    );
  }

  if (!key || !frame || !matrix) {
    return (
      <div className="card-flat col items-center gap-3 px-4 py-7 text-center" style={{ minHeight: 400 }} aria-busy="true">
        <p className="t-sm muted">입장 QR을 준비하고 있습니다…</p>
      </div>
    );
  }

  return (
    <div className="col items-center gap-3" style={{ alignSelf: 'stretch', minHeight: 400 }}>
      <QrPattern label={label} matrix={matrix} live={!displayStale} maxWidth={maxWidth} />
      <QrStatus stale={displayStale} now={now} />
      <p className="t-xs muted">
        기기 키 <span className="mono">{key.keyId}</span>
        {key.registration === 'LOCAL' ? ' · 이 기기에만 등록됨' : ''}
      </p>
    </div>
  );
}
