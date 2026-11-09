// 로그인 수단 흐름을 실제 브라우저에 잇는다(flow.ts의 fetch·탭 저장소·양식 제출을 만든다). 규칙은 flow.ts와 docs/features/identity.md §2.1에 있다.
import { ORIGINS } from '@/shared/config/origins';
import { browserClock } from '@/shared/lib/clock';
import { refreshLock } from '@/shared/lib/refresh-lock';
import { createLoginMethodsApi, type LoginMethodsApi, type StorageLike } from './flow';

/** 실제 흐름인가(API 출처가 있으면 실제, 개발 서버에서 출처를 주지 않으면 목업) */
export const isLiveLoginMethods = (): boolean => ORIGINS.api !== '';

/**
 * 토큰 갱신은 탈퇴·본인확인 흐름과 같은 잠금(Web Locks `peaket.refresh`)으로 창끼리 하나씩 돈다.
 * 합치기 제안의 끝 시각은 화면들이 함께 쓰는 보정 시계(docs/frontend.md §3.3)로 기기 시계 값으로 옮긴다(BOT-043이 넘긴 것)
 */
export function browserLoginMethodsApi(): LoginMethodsApi {
  return createLoginMethodsApi({ origin: ORIGINS.api, fetch: (input, init) => fetch(input, init), lock: (fn) => refreshLock(fn), clock: browserClock() });
}

export const tabStore: StorageLike = {
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
      // 저장소를 못 쓰면 돌아온 뒤 할 일을 잇지 못할 뿐이다(재인증 결과 쿠키는 1분 뒤 사라진다)
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

/** 양식을 이 창에서 제출한다(페이지가 제공자로 옮겨 간다) */
export function submitForm(f: { action: string; fields: Record<string, string> }): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = f.action;
  form.hidden = true;
  for (const [k, v] of Object.entries(f.fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = k;
    input.value = v;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}
