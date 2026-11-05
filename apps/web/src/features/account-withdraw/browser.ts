// 탈퇴 흐름을 실제 브라우저에 잇는다(flow.ts의 fetch·탭 저장소·양식 제출을 만든다). 규칙은 flow.ts와 docs/features/identity.md §8 '탈퇴 화면 연결'에 있다.
import { ORIGINS } from '@/shared/config/origins';
import { refreshLock } from '@/shared/lib/refresh-lock';
import { createWithdrawApi, type Provider, reauthForm, type StorageLike, type WithdrawApi } from './flow';

/** 실제 흐름인가(본인확인 흐름과 같은 판정: API 출처가 있으면 실제, 개발 서버에서 출처를 주지 않으면 목업) */
export const isLiveWithdraw = (): boolean => ORIGINS.api !== '';

/** 토큰 갱신은 본인확인 흐름과 같은 잠금(Web Locks `peaket.refresh`)으로 창끼리 하나씩 돈다 */
export function browserWithdrawApi(): WithdrawApi {
  return createWithdrawApi({ origin: ORIGINS.api, fetch: (input, init) => fetch(input, init), lock: (fn) => refreshLock(fn) });
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
      // 저장소를 못 쓰면 돌아온 뒤 탈퇴 창을 다시 열지 못할 뿐이다(재인증 결과 쿠키는 1분 뒤 사라진다)
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

/** 재인증 시작 양식을 이 창에서 제출한다(페이지가 제공자로 옮겨 간다) */
export function submitReauthForm(provider: Provider): void {
  const { action, fields } = reauthForm(provider);
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  form.hidden = true;
  for (const [name, value] of Object.entries(fields)) {
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
