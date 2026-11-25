'use client';
// 월렛 부스 재발급 화면 연결(TR-12, docs/frontend.md §4.2.4, docs/review/plans/F-05-12.md §3 결정 8).
// 동의 → 본인확인(기관 창) → 부스 코드 QR → 10초마다·online에서 BOOTH 등록 → QR.
// 흐름 클래스(flow.ts)와 기관 창 흐름(identity-verify)을 잇기만 하고, 토큰·코드 원문은 저장소·로그에 남기지 않는다.
import { QrPattern } from '@peaket/ds/RotatingQR';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { WebShellModal } from '@peaket/ds/WebShell';
import { ORIGINS } from '@/shared/config/origins';
import { refreshLock } from '@/shared/lib/refresh-lock';
import { refreshOnce } from '@/shared/lib/token-refresh';
import { browserCallerEnv, startCallerFlow, type AgencyWindow, type ResultAnswer, type ResultBody, type StartAnswer, type VerifyApi } from '@/features/identity-verify';
import { generateDeviceKey, leaveForWalletReauth, loadDeviceKey, qrMatrix, registerDeviceKey, saveDeviceKey, type DeviceKey, type StoredDeviceKey } from '@/features/wallet-device-key';
import { BoothReissueFlow, type BoothReissuePorts, type BoothState } from '@/features/booth-reissue/flow';

const CONSENT_ROWS: readonly { dt: string; dd: string }[] = [
  { dt: '목적', dd: '입장이 시작된 뒤 이 티켓을 다시 받으려는 분이 티켓을 가진 계정의 본인인지 대조합니다' },
  {
    dt: '항목',
    dd: '휴대폰 본인확인 결과의 연계정보(대조한 뒤 바로 버립니다), 대조 결과(일치 여부)와 요청 일시. 이름·생년월일 등 다른 본인확인 결과는 받는 즉시 버립니다',
  },
  { dt: '보유 기간', dd: '연계정보는 저장하지 않습니다. 대조 결과는 공연(회차)이 끝나고 1년까지' },
  {
    dt: '거부권과 불이익',
    dd: '동의를 거부할 수 있습니다. 동의하지 않으면 부스에서 티켓을 다시 받을 수 없습니다. 입장 방법은 현장 직원에게 문의해 주세요',
  },
];

function statusOf(e: unknown): number | undefined {
  return typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : undefined;
}
function typeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && typeof (e as { type?: unknown }).type === 'string' ? (e as { type: string }).type : undefined;
}

async function problemTypeOf(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { type?: unknown } | null;
    return b && typeof b.type === 'string' ? (b.type.split('/').filter(Boolean).pop() ?? 'http') : `http-${r.status}`;
  } catch {
    return `http-${r.status}`;
  }
}

function errorOf(status: number, type: string): Error {
  return Object.assign(new Error(type), { status, type });
}

/** 팬 API 호출. 401이면 창끼리 하나씩 토큰을 갱신하고 한 번 더 보낸다(원문은 메모리에만) */
async function fanJson<T>(origin: string, path: string, body: unknown): Promise<T> {
  const send = () =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  let r = await send();
  if (r.status === 401) {
    const refreshed = await refreshLock(() => refreshOnce((input, init) => fetch(input, init), `${origin}/v1/identity/access-tokens`));
    if (refreshed === 'ok') r = await send();
  }
  if (!r.ok) throw errorOf(r.status, await problemTypeOf(r));
  return (await r.json()) as T;
}

async function fanResult(origin: string, verificationId: string): Promise<ResultAnswer> {
  const send = () =>
    fetch(`${origin}/v1/identity/verifications/${encodeURIComponent(verificationId)}/result`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  let r = await send();
  if (r.status === 401) {
    const refreshed = await refreshLock(() => refreshOnce((input, init) => fetch(input, init), `${origin}/v1/identity/access-tokens`));
    if (refreshed === 'rejected') return { kind: 'login' };
    if (refreshed !== 'ok') return { kind: 'down' };
    r = await send();
    if (r.status === 401) return { kind: 'login' };
  }
  if (r.status === 200) {
    try {
      const body = (await r.json()) as ResultBody;
      return { kind: 'result', body } as ResultAnswer;
    } catch {
      return { kind: 'error' };
    }
  }
  const type = await problemTypeOf(r);
  if (r.status === 409 && type === 'duplicate-account') return { kind: 'duplicate' };
  if (r.status === 409 && type === 'booth-mismatch') return { kind: 'mismatch' };
  if (r.status === 403 && type === 'under-14') return { kind: 'under14' };
  if (r.status === 404) return { kind: 'notFound' };
  if (r.status === 503) return { kind: 'down' };
  return { kind: 'error' };
}

type KeyMaterial = Pick<DeviceKey, 'publicKeyJwk' | 'privateKey' | 'keyIdText'>;

function storedOf(key: KeyMaterial, ticketId: string): StoredDeviceKey {
  return {
    ticketId,
    keyId: key.keyIdText,
    privateKey: key.privateKey,
    publicKeyJwk: key.publicKeyJwk,
    createdAt: Date.now(),
    reason: 'BOOTH',
    registration: 'LOCAL',
  };
}

function timeText(ms: number): string {
  if (ms <= 0) return '0:00';
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 재인증에 쓸 지금 계정의 소셜 제공자 하나. 없으면 undefined */
async function linkedProvider(): Promise<string | undefined> {
  const [{ OPERATIONS }, api] = await Promise.all([import('@peaket/api-client'), import('@/shared/api')]);
  const client = api.browserApiClient();
  if (!client) return undefined;
  const r = await api.withFanRefresh(() => client.send<{ providers?: { provider?: unknown }[] }>(OPERATIONS.getIdentityProviders));
  return (r.data.providers ?? []).map((p) => p.provider).find((p): p is string => typeof p === 'string' && p.length > 0);
}

const tabStore = {
  getItem: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k: string, v: string) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      // 저장소가 막혀 있으면 돌아온 뒤 다시 시도한다
    }
  },
  removeItem: (k: string) => {
    try {
      sessionStorage.removeItem(k);
    } catch {
      // 없다
    }
  },
};

export interface BoothReissueLiveProps {
  seat: string;
  showButton: boolean;
  initialOpen: boolean;
  ticketId: string;
  /** 등록이 끝난 뒤 그릴 입장 QR(월렛의 DeviceQrLazy). 이 조각은 늦게 싣는다 */
  registeredQr: ReactNode;
}

/**
 * 실제 흐름. 동의 시트를 연 뒤 [동의하고 휴대폰 본인확인]을 누르면 기관 창을 열고,
 * 복귀 화면이 resultToken을 보내면 부스 코드를 받아 10초마다·online에서 BOOTH 등록을 시도한다.
 */
export function BoothReissueLive({ seat, showButton, initialOpen, ticketId, registeredQr }: BoothReissueLiveProps) {
  const [open, setOpen] = useState(initialOpen);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [state, setState] = useState<BoothState>({ phase: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [ready, setReady] = useState(false);
  const keyRef = useRef<KeyMaterial | undefined>(undefined);
  const flowRef = useRef<BoothReissueFlow | undefined>(undefined);
  const tokenRef = useRef<string | undefined>(undefined);
  const stateRef = useRef<BoothState>({ phase: 'idle' });
  const mounted = useRef(true);
  const base = useId();
  const descId = `${base}-d`;
  const whyId = `${base}-why`;
  const agreeId = `${base}-agree`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 화면이 열릴 때 저장된 키가 있으면 그 키를 쓴다(등록됨 키를 덮지 않는다). 없을 때만 새 키를 만들어 로컬 저장한다.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await loadDeviceKey(ticketId);
        if (cancelled || !mounted.current) return;
        if (existing) {
          keyRef.current = { publicKeyJwk: existing.publicKeyJwk, privateKey: existing.privateKey, keyIdText: existing.keyId };
          setReady(true);
          return;
        }
        const generated = await generateDeviceKey();
        if (cancelled || !mounted.current) return;
        keyRef.current = generated;
        await saveDeviceKey(storedOf(generated, ticketId));
        if (!cancelled && mounted.current) setReady(true);
      } catch (e) {
        if (!cancelled && mounted.current) setError(e instanceof Error ? e.message : '이 기기의 키를 만들지 못했습니다');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  const ports = useMemo<BoothReissuePorts>(() => {
    const origin = ORIGINS.api;
    return {
      start: (i) => fanJson(origin, '/v1/identity/booth-reverifications', i),
      confirm: (i) => fanJson(origin, `/v1/identity/verifications/${encodeURIComponent(i.verificationId)}/result`, { providerResult: i.providerResult }),
      request: (i) => fanJson(origin, `/v1/tickets/${encodeURIComponent(i.ticketId)}/booth-requests`, { reverificationToken: i.reverificationToken }),
      register: async (i) => {
        const key = keyRef.current;
        if (!key) throw errorOf(503, 'device-key-unavailable');
        const r = await registerDeviceKey({
          ticketId: i.ticketId,
          publicKeyJwk: i.publicKeyJwk,
          keyId: key.keyIdText,
          reason: 'BOOTH',
          boothRequestId: i.boothRequestId,
          ...(i.reauthToken ? { reauthToken: i.reauthToken } : {}),
          origin,
          fetch: (input, init) => fetch(input, init),
        });
        if (r.kind === 'registered') {
          const current = await loadDeviceKey(i.ticketId);
          if (current && current.keyId === key.keyIdText) await saveDeviceKey({ ...current, reason: 'BOOTH', registration: 'REGISTERED' });
          return { keyId: r.keyId };
        }
        if (r.kind === 'needs-reauth') throw errorOf(403, 'reauth-required');
        if (r.kind === 'reissue-required') throw errorOf(403, 'reissue-required');
        if (r.kind === 'reissue-at-booth') throw errorOf(403, 'reissue-at-booth');
        if (r.kind === 'reissue-limit') throw errorOf(429, 'reissue-limit');
        if (r.kind === 'needs-login') throw errorOf(401, 'login');
        if (r.kind === 'rejected') throw errorOf(r.status, r.type);
        if (r.kind === 'retry') throw errorOf(r.status ?? 503, 'retry');
        throw errorOf(503, 'unavailable');
      },
    };
  }, [ticketId]);

  const ensureFlow = (): BoothReissueFlow | undefined => {
    if (flowRef.current) return flowRef.current;
    const key = keyRef.current;
    if (!key) return undefined;
    const flow = new BoothReissueFlow({
      ticketId,
      api: ports,
      now: () => Date.now(),
      deviceKey: { publicKeyJwk: key.publicKeyJwk },
      onState: (s) => {
        stateRef.current = s;
        if (mounted.current) setState(s);
      },
    });
    flowRef.current = flow;
    return flow;
  };

  const boothApi = (flow: BoothReissueFlow): VerifyApi => ({
    async start(): Promise<StartAnswer> {
      const r = await flow.startVerification();
      return r.kind === 'started' ? { kind: 'started', id: r.id, window: r.window as AgencyWindow } : { kind: 'error' };
    },
    async confirm(): Promise<ResultAnswer> {
      return { kind: 'error' };
    },
    result: (id) => fanResult(ORIGINS.api, id),
    refresh: () => refreshLock(() => refreshOnce((input, init) => fetch(input, init), `${ORIGINS.api}/v1/identity/access-tokens`)),
  });

  const begin = () => {
    const flow = ensureFlow();
    flow?.begin();
    setOpen(true);
  };

  const consent = () => {
    if (!agreed || busy) return;
    const flow = ensureFlow();
    if (!flow) {
      setError(ready ? '부스 재발급을 시작하지 못했습니다' : '이 기기의 키를 준비하는 중입니다');
      return;
    }
    flow.begin();
    setOpen(false);
    setBusy(true);
    setError(null);
    const api = boothApi(flow);
    startCallerFlow(browserCallerEnv(api), {
      purpose: 'REVERIFY',
      next: `${location.pathname}${location.search}`,
      onWaiting: () => undefined,
      onResultToken: (token) => {
        tokenRef.current = token;
      },
      onDone: (outcome) => {
        setBusy(false);
        if (outcome === 'success') {
          const token = tokenRef.current;
          if (!token) {
            flow.reset();
            setError('본인확인 결과 토큰을 받지 못했습니다. 다시 시도해 주세요');
            return;
          }
          flow.acceptResultToken(token);
          void flow.request();
          return;
        }
        flow.reset();
        if (outcome === 'mismatch') {
          setError('본인확인 결과가 이 티켓의 계정과 다릅니다');
          return;
        }
        if (stateRef.current.phase === 'mismatch') return;
        setError(outcome === 'closed' ? '본인확인 창을 닫았습니다. 다시 시도해 주세요' : '본인확인을 마치지 못했습니다. 잠시 뒤 다시 시도해 주세요');
      },
    });
  };

  // 코드를 보이는 동안 1초마다 시계를 갱신하고, 흐름은 10초 간격으로만 등록을 시도한다.
  useEffect(() => {
    if (state.phase !== 'code' && state.phase !== 'waiting') return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
      void flowRef.current?.tick();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [state.phase]);

  useEffect(() => {
    const onOnline = () => void flowRef.current?.online();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  const matrix = useMemo(() => (state.boothCode ? qrMatrix(state.boothCode) : undefined), [state.boothCode]);
  const remain = state.expiresAtMs === undefined ? undefined : state.expiresAtMs - nowMs;
  const flowError =
    state.error === 'reauth-required'
      ? '현장에서 다시 로그인한 확인이 필요합니다. 부스 직원에게 문의해 주세요'
      : state.error === 'reissue-required' || state.error === 'reissue-at-booth'
        ? '이 기기에서는 다시 받을 수 없습니다. 부스 직원에게 문의해 주세요'
        : (state.error ?? '부스 재발급을 진행하지 못했습니다');

  const retryRequest = () => {
    setError(null);
    const flow = ensureFlow();
    if (!flow) return;
    void flow.request();
  };

  const reauthNeeded = state.phase === 'waiting' && state.error === 'reauth-required' && state.boothRequestId !== undefined;
  const codeVisible = (state.phase === 'code' || state.phase === 'waiting' || state.phase === 'error') && state.boothCode !== undefined;
  const startBoothReauth = async () => {
    const boothRequestId = state.boothRequestId;
    if (!boothRequestId || leaving) return;
    setLeaving(true);
    try {
      const provider = await linkedProvider();
      if (!provider) throw new Error('다시 로그인할 수단을 찾지 못했습니다');
      leaveForWalletReauth({ ticketId, reason: 'BOOTH', boothRequestId }, { store: tabStore, now: () => Date.now(), provider });
    } catch (e) {
      setLeaving(false);
      setError(e instanceof Error ? e.message : '다시 로그인을 시작하지 못했습니다');
    }
  };

  const closeNotice = () => {
    flowRef.current?.reset();
    flowRef.current = undefined;
    tokenRef.current = undefined;
    setState({ phase: 'idle' });
    stateRef.current = { phase: 'idle' };
    setError(null);
    setAgreed(false);
    setOpen(false);
  };

  return (
    <>
      {showButton ? (
        <button
          className="btn btn-secondary btn-lg btn-block"
          type="button"
          aria-label={`${seat} 부스 재발급 요청`}
          aria-haspopup="dialog"
          disabled={!ready && !error}
          onClick={begin}
        >
          부스 재발급 요청
        </button>
      ) : null}

      <WebShellModal
        open={open}
        onClose={() => setOpen(false)}
        maxWidth={520}
        scroll
        describedBy={descId}
        eyebrow={
          <span className="eyebrow">
            부스 재발급 1/3단계<span className="hidden md:inline"> · {seat}</span>
          </span>
        }
        title="본인확인 결과 대조 동의"
      >
        <p className="t-sm" id={descId}>
          이 티켓을 가진 분과 같은 분인지 대조합니다. 대조 결과만 남기고 연계정보는 버립니다
        </p>
        <dl className="card-flat col" style={{ gap: 8, padding: '14px 16px' }}>
          {CONSENT_ROWS.map((r) => (
            <div key={r.dt} className="col" style={{ gap: 2 }}>
              <dt className="t-xs fw-b muted">{r.dt}</dt>
              <dd className="t-sm">{r.dd}</dd>
            </div>
          ))}
        </dl>
        <label className="check-row" htmlFor={agreeId}>
          <input className="cb" id={agreeId} type="checkbox" aria-describedby={whyId} checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          대조 목적에 동의합니다 (필수)
        </label>
        {agreed ? null : (
          <p className="hint" id={whyId}>
            동의해야 휴대폰 본인확인을 시작할 수 있습니다
          </p>
        )}
        {error ? (
          <p className="t-sm" role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        ) : null}
        <button
          className="btn btn-primary btn-lg btn-block"
          type="button"
          aria-disabled={agreed && ready && !busy ? undefined : true}
          aria-describedby={agreed && ready ? undefined : whyId}
          onClick={consent}
        >
          {busy ? '본인확인을 기다리는 중…' : '동의하고 휴대폰 본인확인'}
        </button>
        <button className="btn btn-ghost btn-block" type="button" onClick={() => setOpen(false)}>
          닫기
        </button>
      </WebShellModal>

      {state.phase === 'verifying' ? (
        <div className="card-flat col items-center gap-3 px-4 py-5 text-center" role="status" aria-busy="true">
          <span className="state-icon is-primary">
            <i className="ic ic-phone" aria-hidden="true" />
          </span>
          <p className="t-md fw-b">휴대폰 본인확인을 기다리고 있습니다</p>
          <p className="t-sm muted">기관 창에서 본인확인을 마치면 부스 코드가 나옵니다.</p>
        </div>
      ) : null}

      {codeVisible ? (
        <div className="card-flat col items-center gap-3 px-4 py-5 text-center" role="status">
          <span className="badge badge-solid">부스 코드 · 입장 QR이 아닙니다</span>
          {matrix ? <QrPattern label={`부스 재발급 코드 QR, ${seat}`} matrix={matrix} maxWidth={200} /> : null}
          <span className="mono t-lg">{state.boothCode}</span>
          {remain !== undefined ? (
            <span className="timer" role="timer" aria-label={`부스 코드 남은 시간 ${timeText(remain)}`}>
              <i className="ic ic-clock" aria-hidden="true" />
              {timeText(remain)} 남음
            </span>
          ) : null}
          <p className="t-md fw-b">부스 직원에게 이 화면을 보여 주세요</p>
          <p className="t-sm muted">
            {state.phase === 'waiting'
              ? '부스 직원이 코드를 찍으면 10초 안에 이 휴대폰을 다시 등록합니다.'
              : '부스 직원이 코드를 찍으면 10분 안에 이 휴대폰을 입장용으로 다시 등록합니다.'}
          </p>
          {reauthNeeded ? (
            <button className="btn btn-primary btn-block" type="button" disabled={leaving} onClick={() => void startBoothReauth()}>
              {leaving ? '이동 중…' : '다시 로그인하고 등록'}
            </button>
          ) : null}
          {error ? (
            <p className="t-sm" role="alert" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {state.phase === 'registered' ? (
        <div className="col gap-[14px]">
          <div className="banner banner-success" role="status">
            <i className="ic ic-check-circle" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">이 휴대폰을 입장용으로 다시 등록했습니다</span>
              아래 QR을 입장 게이트에 보여 주세요.
            </div>
          </div>
          {registeredQr}
        </div>
      ) : null}

      {state.phase === 'expired' ? (
        <div className="col gap-2" role="alert">
          <p className="t-sm fw-b">부스 코드가 만료되었습니다. 다시 요청해 주세요</p>
          <button className="btn btn-outline" type="button" onClick={retryRequest}>
            부스 코드 다시 받기
          </button>
        </div>
      ) : null}

      {state.phase === 'limit' ? (
        <p className="t-sm fw-b" role="alert">
          오늘은 부스 재발급을 더 요청할 수 없습니다(하루 3회)
        </p>
      ) : null}

      {state.phase === 'mismatch' ? (
        <p className="t-sm fw-b" role="alert">
          본인확인 결과가 이 티켓의 계정과 다릅니다
        </p>
      ) : null}

      {state.phase === 'before-entry' ? (
        <p className="t-sm fw-b" role="alert">
          입장 시작 전에는 온라인으로 다시 받으세요
        </p>
      ) : null}

      {state.phase === 'error' ? (
        <div className="col gap-2" role="alert">
          <p className="t-sm fw-b">{flowError}</p>
          {reauthNeeded ? (
            <button className="btn btn-primary" type="button" disabled={leaving} onClick={() => void startBoothReauth()}>
              {leaving ? '이동 중…' : '다시 로그인하고 등록'}
            </button>
          ) : (
            <button
              className="btn btn-outline"
              type="button"
              onClick={() => {
                flowRef.current?.reset();
                setState({ phase: 'idle' });
                stateRef.current = { phase: 'idle' };
                setError(null);
                setAgreed(false);
                setOpen(true);
              }}
            >
              다시 시도
            </button>
          )}
          <button className="btn btn-ghost" type="button" onClick={closeNotice}>
            닫기
          </button>
        </div>
      ) : null}

      {error && (state.phase === 'idle' || state.phase === 'consent') ? (
        <div className="col gap-2" role="alert">
          <p className="t-sm fw-b">{error}</p>
          <button className="btn btn-outline" type="button" onClick={begin}>
            다시 시도
          </button>
        </div>
      ) : null}

      {state.phase === 'verifying' && error ? (
        <p className="t-sm" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
