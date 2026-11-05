// 사람 확인 위젯(Cloudflare Turnstile, docs/frontend.md §5.1·§5.14.2, ADR-0208 결정 3). 로비 참가 카드 안의 자리(#hc-slot)에 늦게 싣는다.
// 스크립트는 버전 없는 주소라 SRI를 걸 수 없다(§5.14.2 외부 스크립트 결정). T=0 진입 경로에는 싣지 않는다.
import { HUMAN_CHECK } from '../config';

export interface WidgetApi {
  render(el: HTMLElement, o: Record<string, unknown>): string | undefined;
  remove(id: string): void;
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<WidgetApi | null> | null = null;

function loadTurnstile(): Promise<WidgetApi | null> {
  const w = window as unknown as { turnstile?: WidgetApi };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  loading ??= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => {
      const api = w.turnstile ?? null;
      // 실렸는데 전역 값이 없으면 다음 시도에서 다시 싣는다
      if (!api) loading = null;
      resolve(api);
    };
    // 불러오기 실패는 사람 확인 실패와 같은 화면(다시 시도)이다. 다음 시도에서 다시 싣는다
    s.onerror = () => {
      loading = null;
      s.remove();
      resolve(null);
    };
    document.head.append(s);
  });
  return loading;
}

async function widgetApi(): Promise<WidgetApi | null> {
  if (import.meta.env.DEV && HUMAN_CHECK.mode === 'simulator') return (await import('../dev/human-check-sim')).simulator();
  return loadTurnstile();
}

/** 위젯을 그려 토큰을 받는다. 실패·만료·시간 초과·자리 없음·사이트 키 없음이면 null */
export async function humanCheck(signal: AbortSignal): Promise<string | null> {
  if (HUMAN_CHECK.mode === 'turnstile' && !HUMAN_CHECK.siteKey) return null;
  const api = await widgetApi();
  const slot = document.getElementById('hc-slot');
  if (!api || !slot || signal.aborted) return null;
  return new Promise((resolve) => {
    let id: string | undefined;
    let settled = false;
    // 위젯이 화면에서 사라지면 콜백이 오지 않는다: 2분 [가정]이면 실패로 보고 [다시 시도]를 보인다
    const timer = window.setTimeout(() => done(null), 120_000);
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (id !== undefined) {
        try {
          api.remove(id);
        } catch {
          /* 이미 지운 위젯 */
        }
      }
      resolve(v);
    };
    signal.addEventListener('abort', () => done(null), { once: true });
    try {
      id = api.render(slot, {
        sitekey: HUMAN_CHECK.siteKey,
        action: 'lobby',
        appearance: 'interaction-only',
        callback: (token: unknown) => done(typeof token === 'string' && token ? token : null),
        'error-callback': () => done(null),
        'expired-callback': () => done(null),
        'timeout-callback': () => done(null),
      });
    } catch {
      done(null);
    }
  });
}
