'use client';
// SCR-013 월렛의 실제 회전 QR(FR-012, POL-018, ADR-0025·0051·0336, offline-gate §2·§3, CMP-029).
// - '이 휴대폰을 입장용으로 등록'을 눌러야만 WebCrypto ECDSA P-256 키를 만든다(extractable=false).
//   키는 IndexedDB(`peaket-wallet`)에 CryptoKey 그대로 두고, keyId(SPKI SHA-256 앞 8바이트)만 화면에 보인다.
// - 서버 등록(enrollment.ts, docs/frontend.md §4.2.4 '입장용 휴대폰 등록 세부'): QR은 서버가 같은 keyId로 등록을 확인한 뒤(phase 'ready')에만 그린다.
//   그 전에는 d5 §5.13의 '등록 확인 전'·'다시 확인 필요'·'등록 거절'을 보인다. 부품이 붙을 때·[다시 시도]·`online` 사건에 같은 공개키로 다시 보낸다.
//   토큰 갱신 뒤에도 401이면 로그인 화면(SCR-004)으로 보내고 키는 둔다. '등록됨' 키는 이 화면에서 지우거나 새로 만들지 않는다.
// - 재발급(ADR-0363 결정 2·3): 403 reissue-required는 '저장소 유실, 입장 시작 전' [ 다시 로그인하고 받기 ], reauth-required는 '다시 확인 필요',
//   reissue-at-booth는 '저장소 유실, 입장 시작 뒤' 안내 글(부스 버튼은 GAT-190 전까지 없다), 재인증 뒤 429는 '재발급 한도'다.
//   재인증으로 떠날 때 탭 저장소 `peaket.wallet.reauth`에 티켓·이유·시각만 남기고, 돌아오면 한 번 읽고 지운 뒤 토큰으로 한 번 보낸다(reauth-return.ts).
// - 등록 전 안내(ADR-0363 결정 10): iOS 브라우저 탭·데스크톱은 키를 만들기 전에 안내(EnrollGuide)를, 인앱 브라우저는 SCR-058로 보낸다.
//   등록할 때와 이 부품이 붙을 때마다 navigator.storage.persist()를 부르고 결과를 meta.persistGranted에 둔다.
// - 15초마다 그 순간의 보정 시각(browserClock)으로 QR v1(93바이트)을 다시 서명하고 base45 140자를 QR로 그린다.
//   화면이 다시 보이면(visibilitychange) 그 순간에도 다시 서명한다. 네트워크와 무관하다.
// - 티켓 스냅샷과 마지막 동기화 시각을 IndexedDB에 남겨 서비스 워커가 셸을 연 뒤 오프라인에서도 같은 화면을 그린다.
// - 붙어 있는 동안 Web Lock `peaket.wallet.qr`(공유)을 쥐어 월렛 워커 갱신을 미룬다(docs/frontend.md §5.4 '갱신' ②, HOT-390).
import { useCallback, useEffect, useRef, useState } from 'react';
import { QrPattern, QrStatus, useScreenWakeLock } from '@peaket/ds/RotatingQR';
import { browserClock } from '@/shared/lib/clock';
import { openInBrowserHref } from '@/shared/lib/in-app-browser';
import { REAUTH_EXPIRED, REAUTH_START_UNAVAILABLE, REAUTH_UNAVAILABLE, reauthFailureText } from '@/shared/lib/reauth-failure';
import { loginHrefAfterRefresh } from '@/shared/lib/token-refresh';
import { enrollDeviceKey, syncDeviceKeyRegistration, type WalletKeyStatus } from '../enrollment';
import { browserPlatformSignals, enrollPlatformOf, needsEnrollGuide, type EnrollPlatform } from '../platform';
import { leaveForWalletReauth, resumeWalletReauth, type TabStorageLike, type WalletReauthReason } from '../reauth-return';
import { EnrollGuide } from './EnrollGuide';
import { createQrFrame, msUntilNextQrFrame, qrClockText, qrFrameStale, qrTimeSeconds, type QrFrame } from '../frame';
import { qrMatrix } from '../qr-matrix';
import { keyIdFromBase64Url } from '../qr-v1';
import { deleteDeviceKey, loadDeviceKey, requestPersistentStorage, saveLastSyncedAt, saveTicketSnapshot, type StoredDeviceKey, type WalletTicketSnapshot } from '../store';
import { holdQrLock } from '../update-hold';

/** loading: 저장소를 읽거나 다시 보내는 중 · registering: 등록 버튼을 누른 뒤 · status: 등록 흐름의 결과(WalletKeyStatus) · error: 저장소·키·서명 오류 */
type Phase = 'loading' | 'registering' | 'status' | 'error';

export interface DeviceQrSnapshot extends Omit<WalletTicketSnapshot, 'ticketId' | 'updatedAt'> {}

export interface DeviceQrProps {
  /** 티켓 UUIDv7. QR v1은 이 값을 16바이트로 싣는다 */
  ticketId: string;
  /** 대체 텍스트(티켓 표시 ID·좌석) */
  label: string;
  maxWidth?: number;
  /** 오프라인 미리보기 상태. 등록 버튼을 이유 있는 비활성으로 그리고 서버에 다시 보내지 않는다 */
  offline?: boolean;
  /** 오프라인 진입용 티켓 스냅샷. 있으면 IndexedDB에 저장한다 */
  snapshot?: DeviceQrSnapshot;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 오류입니다';
}

const CARD = 'card-flat col items-center gap-3 px-4 py-7 text-center';

/** 탭 저장소(sessionStorage). 막혀 있으면 아무것도 남기지 않는다 */
const tabStore: TabStorageLike = {
  getItem: (k) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      // 저장소가 막혀 있으면 돌아온 뒤 다시 누르게 된다
    }
  },
  removeItem: (k) => {
    try {
      sessionStorage.removeItem(k);
    } catch {
      // 없다
    }
  },
};

/** 재인증할 소셜 제공자(지금 계정에 연결된 첫 수단). 읽지 못하면 undefined */
async function linkedProvider(): Promise<string | undefined> {
  const [{ OPERATIONS }, api] = await Promise.all([import('@peaket/api-client'), import('@/shared/api')]);
  const client = api.browserApiClient();
  if (!client) return undefined;
  const r = await api.withFanRefresh(() => client.send<{ providers?: { provider?: unknown }[] }>(OPERATIONS.getIdentityProviders));
  return (r.data.providers ?? []).map((p) => p.provider).find((p): p is string => typeof p === 'string' && p.length > 0);
}

export function DeviceQr({ ticketId, label, maxWidth = 324, offline = false, snapshot }: DeviceQrProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<WalletKeyStatus | null>(null);
  const [frame, setFrame] = useState<QrFrame | null>(null);
  const [matrix, setMatrix] = useState<ReturnType<typeof qrMatrix> | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  /** 재인증 상태 위에 보일 글(돌아왔는데 실패·낡음, 떠나기 실패) */
  const [reauthText, setReauthText] = useState<string | null>(null);
  /** 등록 전 안내를 보일 기기(iOS 탭·데스크톱). ( 그래도 … 등록 › )을 누르면 null */
  const [guide, setGuide] = useState<'ios-tab' | 'desktop' | null>(null);
  const [leaving, setLeaving] = useState(false);
  const mounted = useRef(true);
  /** 마지막으로 시작한 흐름 번호. 늦게 끝난 앞 흐름이 뒤 결과를 덮지 않게 한다 */
  const run = useRef(0);
  const statusRef = useRef<WalletKeyStatus | null>(null);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  /** QR을 그릴 키: 등록 흐름이 QR을 허락한 때만(phase 'ready') */
  const qrKey: StoredDeviceKey | null = phase === 'status' && status?.phase === 'ready' ? status.key : null;

  useScreenWakeLock(qrKey !== null);

  // 이 부품이 화면에 붙어 있는 동안 QR 잠금(공유)을 쥔다. 다른 탭은 잠금이 빌 때까지 새 월렛 워커를 활성화하지 않는다(HOT-390)
  useEffect(() => holdQrLock(typeof navigator === 'undefined' ? undefined : navigator.locks), []);

  const settle = useCallback(async (start: () => Promise<WalletKeyStatus>, busy: Phase) => {
    const id = ++run.current;
    setPhase(busy);
    setError(null);
    try {
      const next = await start();
      if (!mounted.current || id !== run.current) return;
      setStatus(next);
      setPhase('status');
    } catch (e) {
      if (!mounted.current || id !== run.current) return;
      setError(errorText(e));
      setPhase('error');
    }
  }, []);

  /** 저장된 키를 읽고, 확인 전 키면 같은 공개키로 다시 보낸다(부품이 붙을 때·[다시 시도]·online) */
  const sync = useCallback(() => settle(() => syncDeviceKeyRegistration(ticketId, { offline }), 'loading'), [settle, ticketId, offline]);

  useEffect(() => {
    mounted.current = true;
    // 재인증에서 돌아왔으면 표시를 한 번 읽고 지운 뒤 토큰으로 한 번 보낸다. 표시가 없으면 지금처럼 동기화한다(O-T49)
    void settle(async () => {
      const r = await resumeWalletReauth(ticketId, { store: tabStore, now: () => Date.now(), offline });
      if (r.kind === 'none') return syncDeviceKeyRegistration(ticketId, { offline });
      if (r.kind === 'reauth-failed') setReauthText(`다시 로그인하지 못했습니다: ${reauthFailureText(r.reason)}`);
      else if (r.kind === 'stale') setReauthText('다시 로그인한 지 오래되어 처음부터 다시 받아 주세요');
      else setReauthText(null);
      return r.status;
    }, 'loading');
    // 월렛을 열 때마다 영구 저장소를 요청한다(결과는 meta.persistGranted, ADR-0363 결정 10)
    void requestPersistentStorage();
    return () => {
      mounted.current = false;
    };
    // 처음 한 번(티켓이 바뀌면 다시)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  // 오프라인 진입용 티켓 스냅샷과 마지막 동기화 시각. 온라인일 때만 동기화 시각을 올린다.
  useEffect(() => {
    if (!snapshot) return;
    void saveTicketSnapshot({ ...snapshot, ticketId, updatedAt: Date.now() });
    if (typeof navigator === 'undefined' || navigator.onLine) void saveLastSyncedAt();
  }, [snapshot, ticketId]);

  // 인터넷이 다시 연결되면 '등록 확인 전' 키를 한 번 다시 보낸다(d5 §5.13)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    const reconnect = () => {
      update();
      if (statusRef.current?.phase === 'pending') void sync();
    };
    update();
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', update);
    };
  }, [sync]);

  // 토큰 갱신 뒤에도 401: 로그인 화면으로 보낸다. 키는 그대로 둔다(docs/frontend.md §4.2.4 다시 확인)
  useEffect(() => {
    if (phase !== 'status' || status?.phase !== 'needs-login') return;
    window.location.assign(loginHrefAfterRefresh(`${window.location.pathname}${window.location.search}`));
  }, [phase, status]);

  const refresh = useCallback(
    async (atMs: number) => {
      if (!qrKey) return;
      try {
        const signer = { privateKey: qrKey.privateKey, keyId: keyIdFromBase64Url(qrKey.keyId), keyIdText: qrKey.keyId };
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
    [qrKey, ticketId],
  );

  // 15초 경계마다 다시 서명하고, '지금' 글자는 1초마다 움직인다. 화면이 다시 보이면 그 순간 다시 서명한다.
  useEffect(() => {
    if (!qrKey) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const now = browserClock().now();
      setNowMs(now);
      await refresh(now);
      if (cancelled) return;
      timer = setTimeout(() => void tick(), msUntilNextQrFrame(browserClock().now()));
    };
    // 페이지를 열거나 다시 보인 순간에는 기기 시계 + 마지막 오차로 단조 기준을 다시 잡는다.
    browserClock().reset();
    void tick();
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
  }, [qrKey, refresh]);

  const enroll = useCallback(
    () =>
      settle(async () => {
        // 등록할 때 영구 저장소를 요청한다(§5.4 '입장용 휴대폰 등록')
        await requestPersistentStorage();
        return enrollDeviceKey(ticketId, { offline });
      }, 'registering'),
    [settle, ticketId, offline],
  );

  /** '이 휴대폰을 입장용으로 등록': 인앱 브라우저면 SCR-058, iOS 탭·데스크톱이면 키를 만들기 전에 안내를 먼저 보인다 */
  const register = useCallback(() => {
    const signals = browserPlatformSignals();
    const platform: EnrollPlatform = signals ? enrollPlatformOf(signals) : 'mobile';
    if (platform === 'in-app') {
      window.location.assign(openInBrowserHref(`${window.location.pathname}${window.location.search}`));
      return;
    }
    if (needsEnrollGuide(platform) && guide === null) {
      setGuide(platform);
      return;
    }
    return enroll();
  }, [enroll, guide]);

  /** 재인증으로 떠난다(이 창에서 전체 이동). 표시에는 티켓·이유·시각만 남긴다 */
  const leaveForReauth = useCallback(
    async (reason: WalletReauthReason) => {
      setLeaving(true);
      setReauthText(null);
      try {
        const provider = await linkedProvider();
        if (!provider) {
          setReauthText('다시 로그인할 수단을 찾지 못했습니다. 로그인 수단을 확인한 뒤 다시 시도해 주세요');
          return;
        }
        leaveForWalletReauth({ ticketId, reason }, { store: tabStore, now: () => Date.now(), provider });
      } catch {
        setReauthText(REAUTH_START_UNAVAILABLE);
      } finally {
        if (mounted.current) setLeaving(false);
      }
    },
    [ticketId],
  );

  /** 확인 전(LOCAL) 키만 지우고 새로 만든다. 등록됨 키는 지우지 않는다(docs/frontend.md §4.2.4 등록된 키) */
  const resetAndRegister = useCallback(async () => {
    try {
      const stored = await loadDeviceKey(ticketId);
      if (stored?.registration === 'REGISTERED') {
        await sync();
        return;
      }
      await deleteDeviceKey(ticketId);
      setFrame(null);
      setMatrix(null);
      await register();
    } catch (e) {
      if (!mounted.current) return;
      setError(errorText(e));
      setPhase('error');
    }
  }, [register, sync, ticketId]);

  const displayStale = stale || (frame ? qrFrameStale(frame.timeSeconds, nowMs) : false);
  const now = nowMs ? qrClockText(nowMs) : '--:--:--';
  /** 오류 화면에서 '이 기기에 키 다시 만들기'를 보일 키: 확인 전(LOCAL) 키만 */
  const localKey = status && 'key' in status && status.key && status.key.registration !== 'REGISTERED' ? status.key : null;
  /** 재인증 상태 위 글: 돌아온 결과 > 서버가 알린 까닭(만료·확인 못 함) */
  const reauthNotice =
    reauthText ??
    (status && (status.phase === 'reissue-required' || status.phase === 'needs-reauth') && status.notice
      ? status.notice === 'expired'
        ? `${REAUTH_EXPIRED}. 다시 로그인해 주세요`
        : REAUTH_UNAVAILABLE
      : null);

  if (phase === 'loading') {
    return (
      <div className={CARD} style={{ minHeight: 400 }} aria-busy="true">
        <p className="t-sm muted">입장 QR을 준비하고 있습니다…</p>
      </div>
    );
  }

  if (phase === 'error' || (qrKey && stale && !frame)) {
    return (
      <div className={CARD} style={{ minHeight: 400 }} role="alert">
        <span className="state-icon is-danger">
          <i className="ic ic-warning" aria-hidden="true" />
        </span>
        <p className="t-md fw-b">입장 QR을 만들지 못했습니다</p>
        <p className="t-sm muted">{error ?? '기기 키를 읽지 못했습니다'}</p>
        <button className="btn btn-outline btn-block" type="button" onClick={() => void sync()}>
          다시 시도
        </button>
        {localKey ? (
          <button className="btn btn-ghost btn-block" type="button" onClick={() => void resetAndRegister()}>
            이 기기에 키 다시 만들기
          </button>
        ) : null}
      </div>
    );
  }

  if (phase === 'registering' || status?.phase === 'no-key') {
    const disabled = !online || offline || phase === 'registering';
    const rejected = phase === 'status' && status?.phase === 'no-key' && status.notice === 'rejected';
    if (guide !== null && phase !== 'registering') {
      // d5 §5.13: iOS 브라우저 탭·데스크톱은 키를 만들기 전에 안내를 먼저 보인다(O-T32·O-T50 ①). 등록 요청은 0건이다
      return (
        <div className={CARD} style={{ minHeight: 400 }}>
          <span className="state-icon is-primary">
            <i className="ic ic-phone" aria-hidden="true" />
          </span>
          <EnrollGuide
            platform={guide}
            disabled={disabled}
            onProceed={() => {
              setGuide(null);
              void enroll();
            }}
          />
        </div>
      );
    }
    return (
      <div className={CARD} style={{ minHeight: 400 }}>
        {rejected ? (
          <p className="t-sm fw-b" role="alert">
            등록하지 못했습니다. 다시 등록해 주세요
          </p>
        ) : null}
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
        {disabled && phase !== 'registering' ? (
          <p className="t-xs muted" id="device-qr-why">
            {offline ? '오프라인에서는 새로 등록할 수 없습니다. 이미 등록한 기기는 오프라인에서도 QR이 나옵니다.' : '인터넷에 연결되면 등록할 수 있습니다.'}
          </p>
        ) : null}
        <p className="t-xs muted">키는 이 버튼으로만 만듭니다. 등록 뒤에는 오프라인에서도 15초마다 새 QR이 나옵니다.</p>
      </div>
    );
  }

  if (status?.phase === 'pending') {
    // d5 §5.13 '등록 확인 전': 키는 남아 있고, 다시 시도해도 새로 만들지 않는다
    return (
      <div className={CARD} style={{ minHeight: 400 }} role="status">
        <span className="state-icon is-primary">
          <i className="ic ic-phone" aria-hidden="true" />
        </span>
        <p className="t-md fw-b">입장용 등록을 마치지 못했습니다</p>
        <p className="t-sm muted">인터넷 연결을 확인한 뒤 다시 시도해 주세요</p>
        <button className="btn btn-outline btn-block" type="button" onClick={() => void sync()}>
          다시 시도
        </button>
        <p className="t-xs muted">이 휴대폰의 키는 남아 있어 다시 시도해도 새로 만들지 않습니다.</p>
      </div>
    );
  }

  if (status?.phase === 'needs-reauth') {
    // d5 §5.13 '다시 확인 필요'(입장 시작 뒤 첫 등록, 403 reauth-required). 재인증으로 떠나 reason ISSUE와 토큰으로 한 번 보낸다(O-T49 ⑥)
    return (
      <div className={CARD} style={{ minHeight: 400 }} role="status">
        {reauthNotice ? (
          <p className="t-sm fw-b" role="alert">
            {reauthNotice}
          </p>
        ) : null}
        <span className="state-icon is-primary">
          <i className="ic ic-phone" aria-hidden="true" />
        </span>
        <p className="t-md fw-b">본인 확인을 다시 한 뒤 이 휴대폰을 등록할 수 있습니다</p>
        <button className="btn btn-primary btn-block" type="button" aria-disabled={leaving || offline || !online ? true : undefined} onClick={() => (leaving || offline || !online ? undefined : void leaveForReauth('ISSUE'))}>
          {leaving ? '이동 중…' : '다시 로그인하고 등록'}
        </button>
        <p className="t-xs muted">등록하면 계정 이메일로 알려 드립니다.</p>
      </div>
    );
  }

  if (status?.phase === 'reissue-required') {
    // d5 §5.13 '저장소 유실, 입장 시작 전'(403 reissue-required, CMP-045). 키는 이 기기에 남기고, 돌아와 같은 공개키로 REISSUE를 보낸다(O-T49 ①②)
    return (
      <div className={CARD} style={{ minHeight: 400 }} role="status">
        {reauthNotice ? (
          <p className="t-sm fw-b" role="alert">
            {reauthNotice}
          </p>
        ) : null}
        <span className="state-icon is-primary">
          <i className="ic ic-phone" aria-hidden="true" />
        </span>
        <p className="t-md fw-b">이 기기에서 티켓을 다시 받아야 합니다</p>
        <button className="btn btn-primary btn-block" type="button" aria-disabled={leaving || offline || !online ? true : undefined} onClick={() => (leaving || offline || !online ? undefined : void leaveForReauth('REISSUE'))}>
          {leaving ? '이동 중…' : '다시 로그인하고 받기'}
        </button>
        <p className="t-xs muted">티켓당 24시간에 1회 받을 수 있고, 받으면 이메일로 알려 드립니다.</p>
      </div>
    );
  }

  if (status?.phase === 'reissue-at-booth') {
    // d5 §5.13 '저장소 유실, 입장 시작 뒤'(403 reissue-at-booth). [ 부스 재발급 요청 ]은 GAT-190 전까지 그리지 않는다(ADR-0363 결정 9)
    return (
      <div className={CARD} style={{ minHeight: 400 }} role="status">
        <span className="state-icon is-primary">
          <i className="ic ic-phone" aria-hidden="true" />
        </span>
        <p className="t-md fw-b">현장 부스에서 다시 받을 수 있습니다</p>
        <p className="t-sm muted">입장이 시작되어 이 화면에서는 다시 받을 수 없습니다. 공연장의 현장 부스로 와 주세요.</p>
      </div>
    );
  }

  if (status?.phase === 'reissue-limit') {
    // d5 §5.13 '재발급 한도'(재인증 뒤 교체의 429, POL-018)
    return (
      <div className={CARD} style={{ minHeight: 400 }} role="status">
        <span className="state-icon is-danger">
          <i className="ic ic-warning" aria-hidden="true" />
        </span>
        <p className="t-md fw-b">24시간 안에 이미 다시 받았습니다(티켓당 24시간에 1번). 고객센터로 문의해 주세요</p>
        <a className="btn btn-text" href="/help/inquiries/new">
          문의하기
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </a>
      </div>
    );
  }

  if (status?.phase === 'needs-login') {
    return (
      <div className={CARD} style={{ minHeight: 400 }} aria-busy="true">
        <p className="t-sm muted">로그인 화면으로 이동합니다…</p>
      </div>
    );
  }

  if (!qrKey || !frame || !matrix) {
    return (
      <div className={CARD} style={{ minHeight: 400 }} aria-busy="true">
        <p className="t-sm muted">입장 QR을 준비하고 있습니다…</p>
      </div>
    );
  }

  return (
    <div className="col items-center gap-3" style={{ alignSelf: 'stretch', minHeight: 400 }}>
      <QrPattern label={label} matrix={matrix} live={!displayStale} maxWidth={maxWidth} />
      <QrStatus stale={displayStale} now={now} />
      <p className="t-xs muted">
        기기 키 <span className="mono">{qrKey.keyId}</span>
        {status?.phase === 'ready' && status.localOnly ? ' · 이 기기에만 등록됨' : ''}
      </p>
    </div>
  );
}
