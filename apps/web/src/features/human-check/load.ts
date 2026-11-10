// 사람 확인 위젯(CMP-047, Cloudflare Turnstile, docs/frontend.md §5.14.2, ADR-0211 결정 3). 그 화면에만 늦게 싣는다.
// 스크립트는 버전 없는 주소라 SRI를 걸 수 없다(§5.14.2 외부 스크립트 결정). 사이트 키는 공개 값 NEXT_PUBLIC_PEAKET_TURNSTILE_SITEKEY다.
// 개발 서버(`next dev`)는 같은 함수 모양의 시뮬레이터를 쓴다(대기실 src/dev/human-check-sim.ts와 같다). 운영 빌드에서는 그 분기가 지워진다.
// 개발에서도 실제 위젯을 보려면 NEXT_PUBLIC_PEAKET_HUMAN_CHECK=turnstile로 띄운다.
// action은 서버가 토큰을 검증할 때 맞춰 보는 이름이다: 공연 상세 사전 검증 preverify, 추가 검증(SCR-009) 심층 챌린지 verify(bot-defense §5.2, ADR-0259).
// nonce 화면('strict-dynamic', 추가 검증 SCR-009)에서는 위젯 스크립트에 그 페이지의 nonce를 붙인다(Turnstile이 그 nonce를 동적으로 싣는 자원에 이어 붙인다,
// asvs/bot-defense 3.4.3). 해시·'self' 화면(공연 상세)은 nonce가 없어 붙이지 않고 호스트 허용으로 싣는다.

export interface WidgetApi {
  render(el: HTMLElement, o: Record<string, unknown>): string | undefined;
  remove(id: string): void;
}

export type HumanCheckAction = 'preverify' | 'verify';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SITE_KEY = process.env.NEXT_PUBLIC_PEAKET_TURNSTILE_SITEKEY ?? '';
const SIMULATOR = process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_PEAKET_HUMAN_CHECK !== 'turnstile';
/** 위젯이 화면에서 사라지면 콜백이 오지 않는다: 2분 [가정]이면 실패로 본다 */
const TIMEOUT_MS = 120_000;

let loading: Promise<WidgetApi | null> | null = null;

function loadTurnstile(): Promise<WidgetApi | null> {
  const w = window as unknown as { turnstile?: WidgetApi };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  loading ??= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    // 프레임워크 스크립트에 붙은 이 응답의 nonce(브라우저는 속성 값을 숨기고 nonce 속성으로만 준다)
    const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
    if (nonce) s.nonce = nonce;
    s.onload = () => {
      const api = w.turnstile ?? null;
      if (!api) loading = null;
      resolve(api);
    };
    s.onerror = () => {
      loading = null;
      s.remove();
      resolve(null);
    };
    document.head.append(s);
  });
  return loading;
}

/** 개발 서버 전용: 0.8초 뒤 토큰을 준다. 주소에 ?hc=fail이 있으면 실패, ?hc=interactive면 갱신 때 조작을 요구한다 */
function devSimulator(): WidgetApi {
  const timers = new Map<string, number>();
  return {
    render(el, o) {
      const q = new URLSearchParams(location.search).get('hc');
      const note = document.createElement('p');
      note.className = 't-xs muted';
      note.textContent = '개발용 사람 확인 시뮬레이터';
      el.replaceChildren(note);
      const id = crypto.randomUUID();
      timers.set(
        id,
        window.setTimeout(() => {
          timers.delete(id);
          if (q === 'fail') (o['error-callback'] as (() => void) | undefined)?.();
          else if (q === 'interactive' && o.appearance === 'interaction-only') (o['before-interactive-callback'] as (() => void) | undefined)?.();
          else (o.callback as ((t: string) => void) | undefined)?.(`sim.${String(o.action)}.${crypto.randomUUID()}`);
        }, 800),
      );
      return id;
    },
    remove(id) {
      window.clearTimeout(timers.get(id));
      timers.delete(id);
    },
  };
}

/**
 * 자리(slot)에 위젯을 그려 토큰을 받는다. 사람 확인 실패·만료·시간 초과는 null, 위젯을 불러오지 못했거나 사이트 키가 없으면 'unavailable'
 * (둘은 따로 센다, §5.14.2). silent면 조작이 필요할 때 위젯을 보이지 않고 'interactive'로 끝낸다(조용한 갱신, ADR-0211 결정 4)
 */
export async function runHumanCheck(slot: HTMLElement, action: HumanCheckAction, signal: AbortSignal, o: { silent?: boolean } = {}): Promise<string | null | 'unavailable' | 'interactive'> {
  if (!SIMULATOR && !SITE_KEY) return 'unavailable';
  const api = SIMULATOR ? devSimulator() : await loadTurnstile();
  if (signal.aborted) return null;
  if (!api) return 'unavailable';
  return new Promise((resolve) => {
    let id: string | undefined;
    let settled = false;
    const timer = window.setTimeout(() => done(null), TIMEOUT_MS);
    const done = (v: string | null | 'interactive') => {
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
        sitekey: SITE_KEY,
        action,
        appearance: o.silent ? 'interaction-only' : 'always',
        callback: (token: unknown) => done(typeof token === 'string' && token ? token : null),
        'error-callback': () => done(null),
        'expired-callback': () => done(null),
        'timeout-callback': () => done(null),
        ...(o.silent ? { 'before-interactive-callback': () => done('interactive') } : {}),
      });
    } catch {
      done(null);
    }
  });
}
