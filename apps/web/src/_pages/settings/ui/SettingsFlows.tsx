'use client';
// SCR-017 위의 흐름(보드 SCR-017 겹침 창 상태, d5 §5.17 탈퇴 단계). 휴대폰은 아래 시트, 태블릿·데스크톱은 대화상자다(WebShellModal responsive).
// - 다른 기기 로그아웃 → 재인증(CMP-064 fan-social 자리, 실패 문구 role="alert") → 목록에서 빼고 토스트 '… 에서 로그아웃했습니다'
// - ( 회원 탈퇴 › ) → 재인증 → 탈퇴 확인(CMP-054 환급 예상을 결과 버튼보다 먼저, CMP-020 fan의 결과를 적은 버튼) → 완료·미룸 화면
// - 로그아웃 확인은 셸의 대화상자(AppShell defaultOpen="logout")를 쓴다.
// 재인증 창의 '회원 탈퇴' 문구는 보드에 없어 다른 기기 로그아웃 문구를 바꿔 썼다(추천안).
// 탈퇴는 실제 모드(API 출처가 있음)면 재인증(POST /reauth/{provider} → POST /reauth/token)과 DELETE /v1/identity/account에 잇는다
// (docs/features/identity.md §8 '탈퇴 화면 연결', BUILD_ORDER BOT-036). 퍼블리싱 미리보기와 출처 없는 개발 서버는 목업 흐름이다.
// 로그인한 기기도 실제 모드면 GET /v1/identity/sessions로 그리고, [로그아웃]은 재인증 뒤 DELETE /v1/identity/sessions/{sessionId}에 잇는다
// (docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현', BUILD_ORDER BOT-044, ADR-0209). 재인증 결과 받기·양식 제출은 탈퇴 흐름의 것을 쓴다.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { DeviceSessionList, type DeviceSession } from '@peaket/ds/DeviceSessionList';
import { previewHref } from '@peaket/ds/Preview';
import { Select } from '@peaket/ds/Select';
import { TextField } from '@peaket/ds/TextField';
import { WebShellModal } from '@peaket/ds/WebShell';
import { BANKS } from '@/entities/account';
import { withdrawFraudHoldText } from '@/entities/appeal';
import { formatWon } from '@/entities/production';
import { afterWithdraw, browserWithdrawApi, type FraudHold, leaveForReauth, linkedProvidersQuietly, type Provider as WithdrawProvider, reauthFailureText, submitReauthForm, tabStore, untilText } from '@/features/account-withdraw';
import { browserDevicesApi, type DeviceRow, endResultText, leaveForDeviceReauth, type LogoutScope, otherLoginsOf, type PendingLogout, toDeviceSessions } from '@/features/device-sessions';
import { loginHrefAfterRefresh } from '@/shared/lib/token-refresh';
import { useToast } from '@/shared/ui/toast';
import { PROVIDER_INFO, type WithdrawQuote } from '../model/account';
import { resumeDeviceLogout, returnOnMount } from '../model/devices';
import type { SettingsOverlay } from '../model/state';

type Overlay = Exclude<SettingsOverlay, { kind: 'logout' }>;
/** 재인증 창의 목적. 원격 로그아웃의 scope는 그 기기(device)·이 기기의 다른 로그인(others, 지금 이 기기 줄) */
type ReauthPurpose = { kind: 'device'; session: DeviceSession; scope: LogoutScope } | { kind: 'withdraw' };
/** 돌아온 할 일 → 그 기기의 재인증 창 목적 */
const devicePurpose = (p: PendingLogout): ReauthPurpose => ({ kind: 'device', session: { id: p.sessionId, name: p.name, icon: 'device' }, scope: p.scope });

interface FlowsContextValue {
  devices: readonly DeviceSession[];
  /** 지금 이 기기 줄의 같은 기기 다른 로그인 수(실제 흐름만, 0보다 크면 [이 기기의 다른 로그인 끝내기], d5 §5.17) */
  otherLogins: number;
  onEndOtherLogins: () => void;
  devicesLoading: boolean;
  /** 실제 흐름의 목록을 불러오지 못했다([다시 불러오기], d5 §5.17) */
  devicesFailed: boolean;
  reloadDevices: () => void;
  onDeviceLogout: (s: DeviceSession) => void;
  startWithdraw: () => void;
}

const FlowsContext = createContext<FlowsContextValue>({ devices: [], otherLogins: 0, onEndOtherLogins: () => {}, devicesLoading: false, devicesFailed: false, reloadDevices: () => {}, onDeviceLogout: () => {}, startWithdraw: () => {} });

export interface SettingsFlowsProps {
  /** 처음 열린 채로 그릴 창(상태 미리보기) */
  initial: Overlay | null;
  devices: readonly DeviceSession[];
  /** 이미 로그아웃해 목록에서 빠진 기기 */
  removedIds?: readonly string[];
  devicesLoading?: boolean;
  /** 들어오자마자 띄울 토스트(상태 '원격 로그아웃 완료') */
  toastOnMount?: string;
  provider: { label: string; btn: string; prov: string };
  quote: WithdrawQuote;
  /** 탈퇴 409 fraudHold.until 글(state마다, 목업) */
  fraudHoldUntil: Readonly<Record<'RESTRICTED' | 'CASE_OPEN', string>>;
  /** 실제 탈퇴(API 출처가 있고 미리보기 상태가 '기본'일 때만, identity §8 '탈퇴 화면 연결'). 아니면 목업 흐름 */
  live?: boolean;
  dark: boolean;
  children: ReactNode;
}

export function SettingsFlows({
  initial,
  devices,
  removedIds = [],
  devicesLoading = false,
  toastOnMount,
  provider,
  quote,
  fraudHoldUntil,
  live = false,
  dark,
  children,
}: SettingsFlowsProps) {
  const toast = useToast();
  const router = useRouter();
  const ids = useId();
  const [removed, setRemoved] = useState<readonly string[]>(removedIds);
  const [overlay, setOverlay] = useState<Overlay | null>(initial);
  // 미리보기 상태의 재인증 창은 '다른 기기 로그아웃' 대상(Safari · iPhone)으로 연다
  const [purpose, setPurpose] = useState<ReauthPurpose>(() => {
    const target = devices.find((d) => !d.current);
    return target ? { kind: 'device', session: target, scope: 'device' } : { kind: 'withdraw' };
  });
  /** 재인증으로 떠나려고 갱신을 기다리는 중(버튼은 처리 중, 다시 눌러도 한 번만 떠난다, BOT-036이 넘긴 것) */
  const [leaving, setLeaving] = useState(false);
  const leaveRef = useRef<{ cancelled: boolean; cancel(): void } | null>(null);
  /** 창을 닫은 횟수. 탈퇴 요청이 도는 동안 닫았는지 가른다(닫은 뒤 온 응답은 완료만 반영한다, 새 맥락 마지막 검토) */
  const closedRef = useRef(0);
  const close = () => {
    closedRef.current += 1;
    // 갱신을 기다리는 사이 창을 닫으면 갱신이 끝나도 제공자로 떠나지 않는다(identity §8 '탈퇴 화면 연결')
    leaveRef.current?.cancel();
    leaveRef.current = null;
    setLeaving(false);
    // 탈퇴 확인 창을 닫으면 메모리의 재인증 토큰과 보관 안내 상태도 지운다. 다시 열면 재인증부터 한다(새 맥락 재검토)
    setToken(null);
    setLiveHold(null);
    setOverlay(null);
  };
  // 실제 탈퇴(identity §8 '탈퇴 화면 연결'): 재인증할 제공자, 메모리에만 둔 재인증 토큰, 409 fraudHold, 완료
  const api = useMemo(() => (live ? browserWithdrawApi() : null), [live]);
  const [liveProvider, setLiveProvider] = useState<WithdrawProvider | null>(null);
  /** 연결한 로그인 수단(둘 이상이면 재인증 창에서 고른다, identity §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BOT-036이 넘긴 것) */
  const [liveProviders, setLiveProviders] = useState<WithdrawProvider[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [liveHold, setLiveHold] = useState<FraudHold | null>(null);
  const [liveDone, setLiveDone] = useState<'done' | 'deferred' | null>(null);
  const [busy, setBusy] = useState(false);
  /** 재인증 실패 문구(이유마다, 없으면 기본 문구) */
  const [failText, setFailText] = useState<string | null>(null);
  /** forPurpose: 실패를 보일 재인증 창의 목적(기본 탈퇴. 원격 로그아웃이면 그 기기) */
  const failWith = (text: string, forPurpose: ReauthPurpose = { kind: 'withdraw' }) => {
    setFailText(text);
    setPurpose(forPurpose);
    setOverlay({ kind: 'reauth', failed: true });
  };
  // 실제 로그인한 기기(identity §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현'): 목록과 불러오기 상태
  const devicesApi = useMemo(() => (live ? browserDevicesApi() : null), [live]);
  const [liveRows, setLiveRows] = useState<DeviceRow[]>([]);
  const [devicesState, setDevicesState] = useState<'loading' | 'ok' | 'error'>('loading');
  const loadDevices = async () => {
    if (!devicesApi) return;
    setDevicesState('loading');
    const r = await devicesApi.list();
    if (r.kind === 'ok') {
      setLiveRows(r.items);
      setDevicesState('ok');
    } else if (r.kind === 'login') toLogin();
    else setDevicesState('error');
  };
  const shown = live && liveProvider ? PROVIDER_INFO[liveProvider] : provider;
  function toLogin() {
    window.location.assign(loginHrefAfterRefresh('/my/settings'));
  }
  const sorry = () => toast('지금은 탈퇴를 진행할 수 없습니다. 잠시 뒤 다시 시도해 주세요', 'ic-alert-circle');
  /** 원격 로그아웃의 '잠시 뒤 다시'(d5 §5.17 '원격 로그아웃 못 함') */
  const sorryDevice = () => toast(endResultText({ kind: 'error' }, { name: '', scope: 'device' })!.text, 'ic-alert-circle');

  /** 재인증할 제공자를 로그인 수단 목록에서 고른다(연결한 순서의 첫 제공자). onError: 목록이 실패했을 때의 안내(기본 탈퇴) */
  const pickProvider = async (onError: () => void = sorry): Promise<WithdrawProvider | null> => {
    const r = await api!.providers();
    if (r.kind === 'ok') {
      setLiveProvider(r.providers[0]!);
      setLiveProviders(r.providers);
      return r.providers[0]!;
    }
    if (r.kind === 'login') toLogin();
    else onError();
    return null;
  };

  /** 재인증에서 돌아와 그 기기를 끈다(규칙은 model/devices resumeDeviceLogout). 결과는 토스트, 실패면 그 기기의 재인증 창, 로그인 필요면 로그인 화면. 끝나면 목록을 다시 불러온다 */
  const resumeDevice = async (pending: PendingLogout) => {
    const step = await resumeDeviceLogout({
      pending,
      pickup: async () => {
        const r = await api!.pickupReauth();
        if (r.kind === 'token' && r.provider) setLiveProvider(r.provider);
        return r;
      },
      end: (sessionId, reauthToken) => devicesApi!.end(sessionId, reauthToken),
    });
    if (step.kind === 'login') {
      toLogin();
      return;
    }
    if (step.kind === 'toast') toast(step.text, step.icon);
    else if (await pickProvider(sorryDevice)) failWith(step.text, devicePurpose(step.target));
    await loadDevices();
  };

  /**
   * 탈퇴 확인 창이 열린 동안 제공자를 채운다. 목록이 실패해도(로그인 필요 포함) 화면을 떠나거나 안내를 띄우지 않고 비운 채로 둔다.
   * 떠나면 메모리의 재인증 토큰을 잃는다(identity §8 '탈퇴 화면 연결', 새 맥락 리뷰). 403 뒤 재인증은 pickProvider가 다시 고른다
   */
  const fillProviderQuietly = async () => {
    const list = await linkedProvidersQuietly(api!);
    if (!list?.length) return;
    setLiveProvider(list[0]!);
    setLiveProviders(list);
  };

  useEffect(() => {
    if (toastOnMount) toast(toastOnMount, 'ic-check');
    // 재인증에서 돌아왔으면(탭 저장소 표시) 토큰을 한 번 받아, 원격 로그아웃이면 그 기기를 끄고 탈퇴면 탈퇴 확인 창을 연다. 실패면 재인증 창의 실패 문구.
    // 두 표시가 함께 있으면 나중에 남긴 쪽만 잇는다(둘 다 지운다, BOT-044)
    const back = returnOnMount(tabStore, Date.now(), { devices: api !== null && devicesApi !== null, withdraw: api !== null });
    if (back?.kind === 'device') void resumeDevice(back.pending);
    else if (devicesApi) void loadDevices();
    if (api && back?.kind === 'withdraw') {
      void (async () => {
        // 재인증 결과를 먼저 받는다(그 응답의 제공자를 쓰고, 목록은 실패해서 재인증 창을 다시 보일 때만 부른다)
        const r = await api.pickupReauth();
        setPurpose({ kind: 'withdraw' });
        if (r.kind === 'token') {
          // 결과 응답에 제공자가 없으면 로그인 수단 목록의 첫 제공자로 채운다(확인 창의 '…로 다시 로그인했습니다'와 403 뒤 재인증, BOT-036이 넘긴 것)
          if (r.provider) setLiveProvider(r.provider);
          else void fillProviderQuietly();
          setToken(r.token);
          setOverlay({ kind: 'withdraw', refund: 'none' });
          return;
        }
        if (await pickProvider()) failWith(reauthFailureText(r.reason));
      })();
    }
    // 처음 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 재인증으로 떠난 뒤 뒤로 가기 캐시(bfcache)로 그대로 돌아오면 처리 중을 푼다(로그인 수단 화면과 같다)
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      leaveRef.current = null;
      setLeaving(false);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  /** chosen: 연결한 수단이 둘 이상이라 재인증 창에서 고른 제공자(없으면 목록의 첫 제공자) */
  const confirmReauth = (chosen?: WithdrawProvider) => {
    if (api && devicesApi && purpose.kind === 'device') {
      // 실제 원격 로그아웃: 탈퇴와 같이 갱신 뒤 표시를 남기고 제공자로 떠난다(돌아오면 위 효과가 그 기기를 끈다, BOT-044)
      if (leaveRef.current) return;
      const ticket = {
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
      };
      leaveRef.current = ticket;
      setLeaving(true);
      const target = { sessionId: purpose.session.id, name: purpose.session.name, scope: purpose.scope };
      const forPurpose = purpose;
      void (async () => {
        const r = await leaveForDeviceReauth({
          api: devicesApi,
          storage: tabStore,
          now: () => Date.now(),
          provider: chosen ?? liveProvider,
          pickProvider: () => pickProvider(sorryDevice),
          target,
          submit: submitReauthForm,
          cancelled: () => ticket.cancelled,
        });
        if (r === 'left' || ticket.cancelled) return;
        leaveRef.current = null;
        setLeaving(false);
        if (r === 'login') toLogin();
        else if (r === 'retry') failWith(reauthFailureText('unavailable'), forPurpose);
      })();
      return;
    }
    if (api && purpose.kind === 'withdraw') {
      // 실제 탈퇴는 제공자를 몰라도 목록을 다시 읽어 실제 재인증으로 간다(목업 갈래로 빠지지 않는다, BOT-036이 넘긴 것).
      // 연타는 다시 그리기 전에도 막도록 상태 대신 ref로 본다
      if (leaveRef.current) return;
      const ticket = {
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
      };
      leaveRef.current = ticket;
      setLeaving(true);
      void (async () => {
        // 떠나기 직전에 액세스 토큰을 갱신한다(만료된 토큰이면 재인증 시작이 401 막다른 페이지가 된다, 새 맥락 리뷰 중간 1).
        // 401이면 로그인 화면, 연결 끊김·5xx면 잠시 뒤 다시. 성공하면 탭 저장소에 표시를 남기고 이 창을 제공자로 옮긴다(돌아오면 위 효과가 잇는다)
        const r = await leaveForReauth({
          api,
          storage: tabStore,
          now: () => Date.now(),
          provider: chosen ?? liveProvider,
          pickProvider,
          submit: submitReauthForm,
          cancelled: () => ticket.cancelled,
        });
        if (r === 'left' || ticket.cancelled) return;
        leaveRef.current = null;
        setLeaving(false);
        if (r === 'login') toLogin();
        else if (r === 'retry') failWith(reauthFailureText('unavailable'));
      })();
      return;
    }
    if (purpose.kind === 'device') {
      setRemoved((r) => [...r, purpose.session.id]);
      setOverlay(null);
      toast(`${purpose.session.name}에서 로그아웃했습니다`, 'ic-check');
    } else {
      setOverlay({ kind: 'withdraw', refund: 'none' });
    }
  };

  const confirmWithdraw = async (refund: 'none' | 'vb-now' | 'vb-later') => {
    if (api) {
      if (busy) return;
      if (!token) {
        failWith(reauthFailureText('expired'));
        return;
      }
      setBusy(true);
      const opened = closedRef.current;
      // 보관 안내(fraudHold)를 보인 뒤 다시 누르면 같은 토큰에 acknowledgeFraudHold를 싣는다(ADR-0173 결정 7)
      const r = await api.withdraw(token, liveHold !== null);
      setBusy(false);
      // 요청이 도는 동안 창을 닫았으면 완료만 반영하고 나머지는 버린다(닫은 창을 다시 열지 않는다)
      const step = afterWithdraw(r, { closed: opened !== closedRef.current });
      if (step === 'done' || step === 'deferred') {
        setToken(null);
        setOverlay(null);
        setLiveDone(step);
      } else if (step === 'hold' && r.kind === 'fraudHold') setLiveHold({ state: r.state, until: r.until });
      else if (step === 'reauth') {
        setToken(null);
        failWith(reauthFailureText('expired'));
      } else if (step === 'login') toLogin();
      else if (step === 'error') sorry();
      return;
    }
    const next = refund === 'vb-later' ? '탈퇴 접수(미룸)' : '탈퇴 완료';
    router.push(previewHref('/my/settings', next, { theme: dark ? 'dark' : undefined }));
  };

  const ctx: FlowsContextValue = {
    // 실제 흐름은 API의 목록, 그 밖은 목업 목록(identity §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현')
    devices: devicesApi ? toDeviceSessions(liveRows) : devices.filter((d) => !removed.includes(d.id)),
    otherLogins: devicesApi ? otherLoginsOf(liveRows) : 0,
    onEndOtherLogins: () => {
      // 지금 이 기기 줄을 보낸다: 서버가 지금 세션만 남기고 같은 기기의 다른 로그인을 끝낸다(ADR-0209 결정 4)
      const me = liveRows.find((r) => r.current);
      if (!me || !api || !devicesApi) return;
      setPurpose({ kind: 'device', session: { id: me.sessionId, name: '이 기기의 다른 로그인', icon: 'device' }, scope: 'others' });
      setFailText(null);
      void pickProvider(sorryDevice).then((p) => p && setOverlay({ kind: 'reauth', failed: false }));
    },
    devicesLoading: devicesApi ? devicesState === 'loading' : devicesLoading,
    devicesFailed: devicesApi !== null && devicesState === 'error',
    reloadDevices: () => void loadDevices(),
    onDeviceLogout: (session) => {
      setPurpose({ kind: 'device', session, scope: 'device' });
      if (api && devicesApi) {
        setFailText(null);
        void pickProvider(sorryDevice).then((p) => p && setOverlay({ kind: 'reauth', failed: false }));
        return;
      }
      setOverlay({ kind: 'reauth', failed: false });
    },
    startWithdraw: () => {
      setPurpose({ kind: 'withdraw' });
      if (api) {
        setFailText(null);
        void pickProvider().then((p) => p && setOverlay({ kind: 'reauth', failed: false }));
        return;
      }
      setOverlay({ kind: 'reauth', failed: false });
    },
  };

  const reauthWhat = purpose.kind === 'device' ? '다른 기기 로그아웃' : '회원 탈퇴';

  return (
    <FlowsContext.Provider value={ctx}>
      {liveDone ? (
        <main className="page-main" id="main" tabIndex={-1}>
          <LiveDoneView done={liveDone} />
        </main>
      ) : (
        children
      )}

      <WebShellModal
        open={overlay?.kind === 'reauth'}
        onClose={close}
        title="다시 로그인하고 계속"
        icon={<i className="ic ic-shield" aria-hidden="true" />}
        iconTone="primary"
        describedBy={`${ids}-ra`}
        maxWidth={440}
      >
        {overlay?.kind === 'reauth' && overlay.failed ? (
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-alert-circle" aria-hidden="true" />
            <div className="banner-body">{failText ?? '다시 로그인하지 못했습니다. 다시 시도해 주세요'}</div>
          </div>
        ) : null}
        <p className="t-sm" id={`${ids}-ra`}>
          {reauthWhat}
          {purpose.kind === 'device' ? '은 되돌리기 어려운' : '는 되돌릴 수 없는'} 작업이라 로그인한 분이 맞는지 한 번 더 확인합니다.{' '}
          {live && liveProviders.length > 1 ? '이 계정에 연결된 로그인 수단 가운데 하나로 다시 로그인해 주세요.' : `지금 로그인한 ${shown.label} 계정으로 다시 로그인해 주세요.`}
        </p>
        <p className="t-sm muted">
          다시 로그인한 뒤 5분 안에 {reauthWhat}
          {purpose.kind === 'device' ? '을' : '를'} 마쳐야 합니다.
        </p>
        <div className="col" style={{ gap: 8 }}>
          {live && liveProviders.length > 1 ? (
            // 연결한 로그인 수단이 둘 이상이면 고른다(고른 수단으로 재인증 양식을 보낸다)
            liveProviders.map((p) => (
              <button
                key={p}
                className={`btn ${PROVIDER_INFO[p].btn} btn-lg btn-block`}
                type="button"
                // 처리 중에도 초점이 버튼에 남게 disabled 대신 aria-disabled(누름은 confirmReauth가 막는다)
                aria-disabled={leaving || undefined}
                aria-busy={leaving || undefined}
                onClick={() => {
                  if (leaving) return;
                  setLiveProvider(p);
                  confirmReauth(p);
                }}
              >
                <i className={`prov ${PROVIDER_INFO[p].prov}`} aria-hidden="true" />
                {PROVIDER_INFO[p].label}로 다시 로그인하고 계속
              </button>
            ))
          ) : (
            <button className={`btn ${shown.btn} btn-lg btn-block`} type="button" aria-disabled={leaving || undefined} aria-busy={leaving || undefined} onClick={() => confirmReauth()}>
              <i className={`prov ${shown.prov}`} aria-hidden="true" />
              {shown.label}로 다시 로그인하고 계속
            </button>
          )}
          <button className="btn btn-ghost btn-block" type="button" onClick={close}>
            닫기
          </button>
        </div>
      </WebShellModal>

      {overlay?.kind === 'withdraw' ? (
        <WithdrawSheet
          refund={overlay.refund}
          fraudHold={
            api
              ? liveHold
                ? { state: liveHold.state, untilText: untilText(liveHold.until) }
                : undefined
              : overlay.fraudHold
                ? { state: overlay.fraudHold, untilText: fraudHoldUntil[overlay.fraudHold] }
                : undefined
          }
          // 실제 탈퇴에서 제공자를 아직 모르면 이름 없이 '다시 로그인했습니다'(목업 제공자 이름을 보이지 않게)
          provider={api && !liveProvider ? null : shown.label}
          quote={quote}
          live={api !== null}
          busy={busy}
          descId={`${ids}-wd`}
          onClose={close}
          onConfirm={() => void confirmWithdraw(overlay.refund)}
        />
      ) : null}
    </FlowsContext.Provider>
  );
}

/** ② 로그인한 기기 목록(CMP-052). 로그아웃 버튼은 재인증 창을 연다. 실제 흐름에서 목록을 못 불러오면 [다시 불러오기](d5 §5.17) */
export function SettingsDevices() {
  const { devices, otherLogins, onEndOtherLogins, devicesLoading, devicesFailed, reloadDevices, onDeviceLogout } = useContext(FlowsContext);
  if (devicesFailed) {
    return (
      <div className="col" style={{ gap: 8, alignItems: 'flex-start' }}>
        <p className="t-sm muted" role="status">
          로그인한 기기를 불러오지 못했습니다
        </p>
        <button className="btn btn-outline btn-sm" type="button" onClick={reloadDevices}>
          다시 불러오기
        </button>
      </div>
    );
  }
  return (
    <>
      <DeviceSessionList label="로그인한 기기 목록" sessions={devices} loading={devicesLoading} onLogout={onDeviceLogout} />
      {/* 같은 브라우저에서 다시 로그인해 앞 세션이 지금 이 기기 줄에 남았을 때만(otherSessions > 0, 새 맥락 리뷰 중간 1) */}
      {!devicesLoading && otherLogins > 0 ? (
        <div className="row between wrap" style={{ gap: 8, marginTop: 4 }}>
          <p className="t-sm muted">이 기기에 다른 로그인이 {otherLogins}개 남아 있습니다</p>
          <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" onClick={onEndOtherLogins}>
            이 기기의 다른 로그인 끝내기
          </button>
        </div>
      ) : null}
    </>
  );
}

/** ⑥ ( 회원 탈퇴 › ) — 재인증부터 연다 */
export function WithdrawStartButton({ className }: { className?: string }) {
  const { startWithdraw } = useContext(FlowsContext);
  return (
    <button className={className} type="button" aria-haspopup="dialog" onClick={startWithdraw}>
      회원 탈퇴
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </button>
  );
}

/** 회원 코드 복사(이름에 코드를 담는다) */
export function CopyCodeButton({ code }: { code: string }) {
  const toast = useToast();
  return (
    <button
      className="btn btn-outline btn-sm"
      type="button"
      aria-label={`회원 코드 ${code} 복사`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          toast('회원 코드를 복사했습니다', 'ic-copy');
        } catch {
          toast('복사하지 못했습니다', 'ic-copy');
        }
      }}
    >
      <i className="ic ic-copy" aria-hidden="true" />
      복사
    </button>
  );
}

const DESTRUCTIVE_BUTTON_STYLE = { height: 'auto', minHeight: 52, padding: '12px 16px', whiteSpace: 'normal', flexDirection: 'column', gap: 2 } as const;

function WithdrawSheet({
  refund,
  fraudHold,
  provider,
  quote,
  live = false,
  busy = false,
  descId,
  onClose,
  onConfirm,
}: {
  refund: 'none' | 'vb-now' | 'vb-later';
  /** 실제 탈퇴: 탈퇴 참여자(티켓·양도·가상계좌 등)가 없는 동안 티켓·환급 줄을 보이지 않는다(목업 수를 실제처럼 보이지 않게, identity §8 '탈퇴 화면 연결') */
  live?: boolean;
  busy?: boolean;
  /** 탈퇴 409 fraudHold(있으면 대조값 보관 안내를 보이고 '바로 다시 가입' 줄을 숨긴다, d5 §5.17, ADR-0173 결정 7) */
  fraudHold?: { state: 'RESTRICTED' | 'CASE_OPEN'; untilText: string };
  /** 다시 로그인한 제공자 이름. null이면 이름 없이 보인다 */
  provider: string | null;
  quote: WithdrawQuote;
  descId: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const basic = refund === 'none';
  return (
    <WebShellModal
      open
      onClose={onClose}
      // 보드처럼 재인증 결과 줄을 제목 위에 둔다
      eyebrow={
        <p className="row t-sm tx-success" style={{ gap: 6 }}>
          <i className="ic ic-check-circle ic-16" aria-hidden="true" />
          {provider ? `${provider}로 다시 로그인했습니다` : '다시 로그인했습니다'}
        </p>
      }
      title="회원 탈퇴"
      describedBy={descId}
      maxWidth={480}
      scroll
    >
      <p className="t-sm" id={descId}>
        탈퇴하면 주문·결제 기록은 법에 따라 5년간 분리 보관 후 파기됩니다
      </p>
      {/* 환급 예상(CMP-054)을 결과 버튼보다 먼저 읽게 둔다(d2 §4) */}
      {live ? null : (
      <section className="card-flat col px-4 py-3.5 md:p-4" style={{ gap: 10 }} aria-labelledby={`${descId}-rq`}>
        <h3 className="t-sm fw-b" id={`${descId}-rq`}>
          미사용 티켓 환급 예상
        </h3>
        <p className="t-sm">
          미사용 티켓 {quote.ticketCount}장은 취소되고 예상 환급액은 {formatWon(quote.refund)}입니다. 다른 분에게 넘기려면 탈퇴 전에 양도해 주세요(받는 분이 수락해야 넘어갑니다).
        </p>
        {basic ? <p className="t-xs muted">{quote.summary}</p> : null}
        <dl className="kv">
          <dt>결제 금액</dt>
          <dd>{formatWon(quote.paid)}</dd>
          <dt>취소 수수료</dt>
          <dd>{formatWon(quote.fee)}</dd>
          <dt className="kv-total">예상 환급액</dt>
          <dd className="kv-total">{formatWon(quote.refund)}</dd>
        </dl>
        {basic ? (
          <p className="t-xs muted">관람일 10일 전까지는 취소 수수료가 없습니다(공정거래위원회 소비자분쟁해결기준). 환급은 3영업일 안에 결제한 수단으로 돌아갑니다.</p>
        ) : null}
      </section>
      )}
      {live ? null : basic ? (
        <div className="card-flat col px-4 py-3.5 md:p-4" style={{ gap: 8 }}>
          <p className="t-sm">받은 티켓 {quote.receivedCount}장은 결제한 분에게 돌아갑니다. 환급은 결제한 분이 정합니다.</p>
          <p className="t-sm">
            양도 요청 중인 티켓 {quote.transferPendingCount}장은 요청을 철회하고 취소합니다. 양도를 마치려면 받는 분이 수락한 뒤 탈퇴해 주세요.
          </p>
          <Link className="link-more" href={quote.transferPendingHref} style={{ alignSelf: 'flex-start' }}>
            요청 보기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className="card-flat col px-4 py-3.5" style={{ gap: 10 }}>
          <p className="t-sm">받은 양도 요청 1건은 거절됩니다.</p>
          {refund === 'vb-now' ? (
            <>
              <p className="t-sm" id={`${descId}-vb`}>
                가상계좌로 결제한 티켓 1장은 환불받을 계좌가 필요합니다.
              </p>
              {/* CMP-062 refund와 같은 칸(autocomplete off, 계좌번호 inputmode numeric). 보드에 제출 버튼이 따로 없어 칸만 둔다 */}
              <Select id="wd-bank" label="은행" requiredMark autoComplete="off" placeholder="은행을 고르세요" options={BANKS} defaultValue="" />
              <TextField
                id="wd-acct"
                label="계좌번호"
                requiredMark
                type="text"
                inputMode="numeric"
                autoComplete="off"
                hint="계좌번호는 저장하지 않고 환불 요청에만 씁니다"
              />
              <TextField id="wd-holder" label="예금주" requiredMark type="text" autoComplete="off" />
            </>
          ) : (
            <p className="t-sm">가상계좌로 결제한 티켓 1장은 입장 기록이 마감된 뒤 환급합니다. 그때 알림으로 계좌를 받고, 환급이 끝나면 탈퇴가 처리됩니다.</p>
          )}
          <p className="t-sm">입금 대기 중인 주문 1건은 취소합니다. 탈퇴한 뒤에는 그 계좌로 입금하지 마세요.</p>
          <p className="t-sm">내가 결제해 다른 분에게 양도한 티켓 2장은 그대로 남습니다. 공연이 취소되면 환급은 결제한 수단으로 갑니다.</p>
          <p className="t-sm">보내기 전 굿즈·부가 상품 주문 1건은 취소하고 환급합니다. 배송 중인 주문은 그대로 보내고, 반품은 고객센터로 받습니다.</p>
        </div>
      )}
      <div className="row between wrap" style={{ gap: 8 }}>
        {live ? null : (
          <Link className="link-more" href="/my/tickets">
            먼저 양도하기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        )}
        {fraudHold ? null : <span className="t-xs muted">탈퇴 뒤 바로 다시 가입할 수 있습니다</span>}
      </div>
      {/* 이 줄이 보였으면 다시 보낼 때 acknowledgeFraudHold: true를 싣는다(퍼블리싱은 서버로 보내지 않는다).
          실제 탈퇴의 409 뒤에 나타나므로 화면 낭독기가 바로 읽게 alert로 두고, 탈퇴 버튼의 설명으로 잇는다(새 맥락 리뷰 중간 5) */}
      {fraudHold ? (
        <div className="banner banner-warning" role={live ? 'alert' : 'note'} id={`${descId}-hold`}>
          <i className="ic ic-shield" aria-hidden="true" />
          <div className="banner-body">{withdrawFraudHoldText(fraudHold)}</div>
        </div>
      ) : null}
      <div className="col" style={{ gap: 8 }}>
        <button
          className="btn btn-danger btn-lg btn-block"
          type="button"
          style={DESTRUCTIVE_BUTTON_STYLE}
          onClick={onConfirm}
          // 처리 중에도 초점이 버튼에 남게 disabled 대신 aria-disabled(누름은 처리기가 막는다)
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          aria-describedby={fraudHold ? `${descId}-hold` : undefined}
        >
          <span>탈퇴합니다.</span> <span className="t-sm fw-m">주문·결제 기록은 법에 따라 분리 보관 후 파기됩니다</span>
        </button>
        <button className="btn btn-ghost btn-block" type="button" onClick={onClose}>
          탈퇴하지 않고 닫기
        </button>
      </div>
    </WebShellModal>
  );
}

/** 실제 탈퇴 뒤 화면(d5 §5.17 완료·미룸). 환급할 것이 없으면 환급 문장을 뺀다(identity §8 '탈퇴 화면 연결') */
function LiveDoneView({ done }: { done: 'done' | 'deferred' }) {
  // 창을 연 버튼이 사라지므로 초점을 제목으로 옮긴다(낭독기가 결과를 읽게, 다시 보기 낮음 1)
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const title = done === 'done' ? '탈퇴했습니다' : '탈퇴를 접수했습니다';
  const body = done === 'done' ? '언제든 다시 가입할 수 있습니다' : '결제 결과·환급이 끝나면 처리하고 이메일로 알려 드립니다. 그동안 새 예매와 양도는 할 수 없습니다.';
  return (
    <div className="col gap-6 px-4 pt-14 pb-6 md:mx-auto md:w-full md:max-w-[480px] md:px-0 md:py-20 lg:py-24">
      <div className="state" role="status" style={{ padding: 0 }}>
        <span className={done === 'done' ? 'state-icon is-success' : 'state-icon'}>
          <i className={done === 'done' ? 'ic ic-check-circle' : 'ic ic-clock'} aria-hidden="true" />
        </span>
        <h1 className="t-xl lg:text-[32px] lg:leading-[42px] lg:tracking-[-.01em]" ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <p className="t-md muted">{body}</p>
      </div>
      <p className="t-sm muted">주문·결제 기록은 법에 따라 5년간 분리 보관 후 파기됩니다</p>
      {/* 세션이 끝났으므로 새 문서로 연다(남은 화면 상태를 들고 가지 않게) */}
      <a className="btn btn-primary btn-lg btn-block" href="/">
        홈으로 가기
      </a>
    </div>
  );
}
