// 본인확인 창 흐름을 실제 브라우저에 잇는다(flow.ts의 환경 값을 window·BroadcastChannel·sessionStorage로 만든다).
// 화면 컴포넌트(ui/VerifyFlow.tsx, _pages/verify-return)만 부른다. 규칙은 flow.ts와 docs/features/identity.md §5에 있다.
import { ORIGINS } from '@/shared/config/origins';
import { type AgencyWindow, type CallerEnv, type ChannelLike, createVerifyApi, REFRESH_LOCK, type ReturnEnv, type StorageLike, VERIFY_CHANNEL, type VerifyApi } from './flow';

/**
 * 실제 흐름인가. 운영 빌드는 늘 실제 흐름이다(API 출처를 주지 않으면 운영 기본값). 시험 창이 운영에 나가 가짜 '완료'를 보이지 않게 한다.
 * 개발 서버(next dev)에서 NEXT_PUBLIC_API_ORIGIN을 주지 않았을 때만 d5 §5.6 '시연 흉내 방법'의 시험 창을 연다(새 맥락 리뷰)
 */
export const isLiveVerify = (): boolean => ORIGINS.api !== '';

/** 토큰 갱신을 창끼리 하나씩(Web Locks). 잠금이 없는 브라우저는 그대로 부른다 */
function refreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? (locks.request(REFRESH_LOCK, fn) as Promise<T>) : fn();
}

export function browserVerifyApi(): VerifyApi {
  return createVerifyApi({ origin: ORIGINS.api, fetch: (input, init) => fetch(input, init), lock: refreshLock });
}

const sessionStore: StorageLike = {
  get(k) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      // 저장소를 못 쓰면 페이지 이동으로 돌아온 뒤 대화상자를 띄우지 못할 뿐이다(결과는 서버에 있다)
    }
  },
  remove(k) {
    try {
      sessionStorage.removeItem(k);
    } catch {
      // 위와 같다
    }
  },
};

/** 기관 창 양식을 target(창 이름이나 '_self')에 제출한다. GET이면 칸이 쿼리로 간다(브라우저 양식 규칙) */
export function submitAgencyForm(target: string, w: AgencyWindow): void {
  const form = document.createElement('form');
  form.method = w.method.toLowerCase();
  form.action = w.url;
  form.target = target;
  form.hidden = true;
  for (const [name, value] of Object.entries(w.fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 같은 출처 BroadcastChannel('peaket.verify')을 흐름의 채널 모양으로 감싼다 */
function browserChannel(): ChannelLike {
  const bc = new BroadcastChannel(VERIFY_CHANNEL);
  const ch: ChannelLike = {
    onmessage: null,
    postMessage: (data) => bc.postMessage(data),
    close: () => bc.close(),
  };
  bc.onmessage = (e: MessageEvent) => ch.onmessage?.({ data: e.data as unknown });
  return ch;
}

export function browserCallerEnv(api: VerifyApi = browserVerifyApi()): CallerEnv {
  return {
    api,
    openWindow(name, features) {
      let w: Window | null = null;
      try {
        w = window.open('about:blank', name, features);
      } catch {
        return null;
      }
      if (!w) return null;
      try {
        // 기관 쪽에서 이 화면을 움직이지 못하게 창 사이 연결을 끊는다(흐름은 window.opener에 기대지 않는다, identity §5)
        w.opener = null;
        w.document.title = '휴대폰 본인확인';
      } catch {
        // 이미 다른 출처로 넘어간 창(같은 이름의 지난 창)이면 그대로 쓴다
      }
      return w;
    },
    channel: browserChannel,
    submitForm: submitAgencyForm,
    sleep,
    currentPath: () => `${location.pathname}${location.search}`,
    goLogin: (next) => location.assign(`/login?next=${encodeURIComponent(next)}`),
  };
}

export function browserReturnEnv(api: VerifyApi = browserVerifyApi()): ReturnEnv {
  return {
    api,
    channel: browserChannel,
    sleep,
    search: () => location.search,
    replaceUrl: (p) => history.replaceState(null, '', p),
    closeWindow: () => window.close(),
    navigate: (p) => location.replace(p),
    storage: sessionStore,
  };
}

export { sessionStore as browserSessionStore };
