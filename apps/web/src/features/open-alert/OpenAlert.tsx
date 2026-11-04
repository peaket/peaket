'use client';
// 오픈 알림·취소표 알림 신청 토글(d5 §5.1 오픈 예정 카드의 종 토글·ADR-0066, §5.2 ⑥ 하단 [오픈 알림 받기]·매진 [취소표 알림 받기]).
// - 꺼짐 aria-pressed="false" + ic-bell, 신청됨 aria-pressed="true" + ic-bell-fill(색만으로 말하지 않게 모양이 바뀐다). 이름은 그대로.
// - 처음 켤 때는 웹 푸시 권한 안내(CMP-068 ds NotifyPermissionSheet, 보드 SCR-001 '알림 권한 안내')를 먼저 보이고, 권한은 시트의 버튼을 누른 뒤에만 묻는다(NFR-019).
//   웹 푸시 권한 요청·구독 등록은 알림 단계(GAT-250)가 한다. 신청 자체는 onToggle을 넘긴 화면이 API로 한다(홈, HOT-300).
// - onToggle을 넘기면 누르는 즉시 바뀐 모양을 보이고(낙관적 갱신), 실패하면 되돌리고 토스트를 띄운다(d5 §5.1).
// - 로그인 전에 누르면 로그인(SCR-004)으로, 오프라인이면 aria-disabled + 오프라인 띠(id)로 이유를 잇는다.
// - 누르면 토스트 "오픈 알림을 신청했습니다"/"오픈 알림을 껐습니다".
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { NotifyPermissionSheet } from '@peaket/ds/NotifyPermissionSheet';
import { useToast } from '@/shared/ui/toast';

interface OpenAlertContextValue {
  guest: boolean;
  /** 오프라인이면 그 띠의 id(비활성 이유) */
  offlineReasonId?: string;
  loginHref: string;
  /** 권한 안내를 거쳐(처음 한 번) 켠다 */
  requestEnable: (enable: () => void) => void;
}

const OpenAlertContext = createContext<OpenAlertContextValue>({
  guest: false,
  loginHref: '/login',
  requestEnable: (enable) => enable(),
});

export interface OpenAlertProviderProps {
  guest?: boolean;
  offlineReasonId?: string;
  loginHref?: string;
  /** 권한 안내 시트를 연 채로 그린다(상태 '알림 권한 안내') */
  defaultSheetOpen?: boolean;
  children: ReactNode;
}

export function OpenAlertProvider({ guest = false, offlineReasonId, loginHref = '/login', defaultSheetOpen = false, children }: OpenAlertProviderProps) {
  const [asked, setAsked] = useState(false);
  const [open, setOpen] = useState(defaultSheetOpen);
  const [pending, setPending] = useState<(() => void) | null>(null);

  const requestEnable = useCallback(
    (enable: () => void) => {
      if (asked) enable();
      else {
        setPending(() => enable);
        setOpen(true);
      }
    },
    [asked],
  );

  const finish = () => {
    setAsked(true);
    setOpen(false);
    pending?.();
    setPending(null);
  };

  return (
    <OpenAlertContext.Provider value={{ guest, offlineReasonId, loginHref, requestEnable }}>
      {children}
      {/* 퍼블리싱 단계라 [알림 켜기]·[이메일로만 받기] 모두 브라우저 권한을 묻지 않고 신청만 마친다 */}
      <NotifyPermissionSheet
        open={open}
        onClose={() => {
          setOpen(false);
          setPending(null);
        }}
        title="오픈 알림을 이 기기로 보냅니다"
        description={
          <>
            <p className="t-sm muted">로비가 열리기 전에 알림을 보냅니다. 아래 버튼을 누른 뒤에만 브라우저가 알림 권한을 묻습니다.</p>
            <p className="t-sm muted">권한을 거부하거나 지원하지 않는 브라우저라면 이메일로 알려 드립니다.</p>
          </>
        }
        onAllow={finish}
        onFallback={finish}
      />
    </OpenAlertContext.Provider>
  );
}

export interface OpenAlertToggleProps {
  /** 공연명(아이콘 버튼 이름에 넣는다) */
  title: string;
  defaultPressed?: boolean;
  /** icon: 카드 오른쪽 위 종 아이콘 버튼 · button: 글자 버튼(btn-secondary) */
  variant?: 'icon' | 'button';
  /** open: 오픈 알림 · cancel: 취소표 알림(매진) */
  kind?: 'open' | 'cancel';
  /** 글자 버튼을 휴대폰(md 미만)에서 아이콘만 보인다(글자는 화면 낭독용으로 남긴다) */
  iconOnlyBelowMd?: boolean;
  className?: string;
  /** 바깥이 정한 신청 상태(서버에서 받은 값). 없으면 defaultPressed로 시작해 이 버튼이 들고 있는다 */
  pressed?: boolean;
  /** 신청·끄기를 서버에 보낸다. 성공하면 true, 실패면 false나 보일 문구(되돌리고 토스트) */
  onToggle?: (next: boolean) => Promise<boolean | string>;
  /** 지금은 누를 수 없다(신청 상태를 아직 모를 때 등) */
  disabled?: boolean;
}

export function OpenAlertToggle({ title, defaultPressed = false, variant = 'icon', kind = 'open', iconOnlyBelowMd = false, className, pressed: outer, onToggle, disabled: blocked = false }: OpenAlertToggleProps) {
  const ctx = useContext(OpenAlertContext);
  const toast = useToast();
  const router = useRouter();
  const [local, setLocal] = useState(defaultPressed);
  /** 보내는 동안 보일 모양(낙관적 갱신) */
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const pressed = optimistic ?? outer ?? local;
  const disabled = Boolean(ctx.offlineReasonId) || blocked;
  const noun = kind === 'open' ? '오픈 알림' : '취소표 알림';

  function apply(next: boolean) {
    const done = () => toast(next ? `${noun}을 신청했습니다` : `${noun}을 껐습니다`, next ? 'ic-bell-fill' : 'ic-bell');
    if (!onToggle) {
      setLocal(next);
      done();
      return;
    }
    setOptimistic(next);
    // 실패(거절 포함)면 되돌린다. 거절을 받지 않으면 낙관 상태가 남아 버튼이 잠긴다(HOT-300 새 맥락 리뷰 낮음 10)
    void onToggle(next)
      .catch(() => false as const)
      .then((r) => {
        setOptimistic(null);
        if (r === true) {
          setLocal(next);
          done();
        } else toast(typeof r === 'string' && r ? r : `${noun}을 바꾸지 못했습니다. 잠시 뒤 다시 해 주세요`, 'ic-bell');
      });
  }

  function onClick() {
    if (disabled || optimistic !== null) return;
    if (ctx.guest) {
      router.push(ctx.loginHref);
      return;
    }
    if (pressed) {
      apply(false);
      return;
    }
    ctx.requestEnable(() => apply(true));
  }

  const icon = <i className={`ic ${pressed ? 'ic-bell-fill' : 'ic-bell'}`} aria-hidden="true" />;
  if (variant === 'icon') {
    return (
      <button
        className={['icon-btn icon-btn-outline', disabled ? 'is-disabled' : '', className ?? ''].join(' ').trim()}
        type="button"
        aria-pressed={pressed}
        aria-label={`${title} ${noun} 받기`}
        aria-disabled={disabled}
        aria-describedby={disabled ? ctx.offlineReasonId : undefined}
        style={pressed && !disabled ? { background: 'var(--primary-subtle)', borderColor: 'var(--primary)', alignSelf: 'start' } : { alignSelf: 'start' }}
        onClick={onClick}
      >
        {icon}
      </button>
    );
  }
  return (
    <button
      className={['btn btn-secondary', iconOnlyBelowMd ? 'max-md:px-4' : '', className ?? ''].join(' ').trim()}
      type="button"
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled ? ctx.offlineReasonId : undefined}
      onClick={onClick}
    >
      {icon}
      <span className={iconOnlyBelowMd ? 'max-md:sr-only' : undefined}>{noun} 받기</span>
    </button>
  );
}
