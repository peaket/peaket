// 개발 서버 전용 사람 확인 시뮬레이터(ADR-0208 결정 3). Turnstile의 render·remove와 같은 함수 모양이고 운영 빌드에는 들지 않는다.
// 0.8초 뒤 토큰을 준다. 주소에 ?hc=fail이 있으면 실패를 낸다(사람 확인 실패 화면을 보려고). 캡차를 흉내 내지 않는다.
import type { WidgetApi } from '../live/human-check';

const timers = new Map<string, number>();

export function simulator(): WidgetApi {
  return {
    render(el, o) {
      const fail = new URLSearchParams(location.search).get('hc') === 'fail';
      const note = document.createElement('p');
      note.className = 't-xs muted';
      note.textContent = '개발용 사람 확인 시뮬레이터';
      el.replaceChildren(note);
      const id = crypto.randomUUID();
      timers.set(id, window.setTimeout(() => {
        timers.delete(id);
        if (fail) (o['error-callback'] as (() => void) | undefined)?.();
        else (o.callback as ((t: string) => void) | undefined)?.(`sim.${String(o.action)}.${crypto.randomUUID()}`);
      }, 800));
      return id;
    },
    remove(id) {
      window.clearTimeout(timers.get(id));
      timers.delete(id);
    },
  };
}
