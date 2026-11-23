// 원격 위젯 싣기의 브라우저 연결(Module Federation, ADR-0100 결정 6, ADR-0360 결정 6, ADR-0361). 적재 순서·다시 받기·실패 까닭은 remote-loader.ts가 정한다.
// - 원격 목록: 같은 출처 /remotes.json(no-cache). 빌드가 만든 dist/remotes.json(scripts/remotes-manifest.mjs), 개발 서버는 메모리 원격으로 그 순간 계산한다
// - 진입 파일: integrity·crossorigin="anonymous"를 붙인 <script>를 Trusted Types 정책 peaket-remote로 넣는다. 정책은 읽은 목록의 정식 주소
//   (/remotes/<이름>/<sha>/remoteEntry.js, 같은 출처 경로 그대로·쿼리·조각 없음)만 통과시키고 그 밖은 던진다(빌드에 박은 주소 없음)
// - 실패 수: remote_load_failed_total{remote, reason}을 같은 출처 /_t/rum counters로 보낸다(remote-failures.ts)
// 한 앱 빌드(PEAKET_CONSOLE_BUILD=single, FE-T29 기준선)는 원격을 받지 않고 같은 소스를 작업 공간 패키지로 묶는다(local-widgets).
import type { WidgetManifest, WidgetProps } from '@peaket/console-contract';
import type { ComponentType } from 'react';
import { loadLocalWidgets } from './local-widgets';
import { remoteFailures } from './remote-failures';
import { createRemoteLoader, type RemoteLoader, type RemoteName, type ScriptRequest } from './remote-loader';

export { RemoteLoadError, REMOTE_CONTAINERS, REMOTE_ENTRY_TIMEOUT_MS, REMOTE_NAMES, type RemoteName } from './remote-loader';

/** 원격 진입 파일만 통과시키는 Trusted Types 정책 이름(§5.14.1 'Trusted Types' 허용 목록 안) */
export const REMOTE_POLICY = 'peaket-remote';
/** 원격 목록 주소(같은 출처) */
export const REMOTE_LIST_PATH = '/remotes.json';

/** 주소가 목록이 허락한 원격 진입 파일인가(같은 출처 경로 그대로, 쿼리·조각·점 경로 없음, 정식 주소 가운데 하나와 정확히 같다) */
export function isAllowedRemoteEntry(url: string, base: string, allowed: ReadonlySet<string>): boolean {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return false;
  }
  return u.origin === new URL(base).origin && u.search === '' && u.hash === '' && url === u.pathname && allowed.has(u.pathname);
}

interface TrustedTypesLike {
  createPolicy(name: string, rules: { createScriptURL(url: string): string }): { createScriptURL(url: string): unknown };
}

/** 정책이 지금 허락하는 주소(목록을 읽을 때마다 바뀐다). 정책은 한 번만 만든다(같은 이름을 두 번 만들 수 없다) */
let allowedNow: ReadonlySet<string> = new Set();
let policy: { createScriptURL(url: string): unknown } | null | undefined;

function remotePolicy(): { createScriptURL(url: string): unknown } | null {
  if (policy !== undefined) return policy;
  // Trusted Types가 없는 브라우저(Firefox·iOS Safari 16.4 등)는 정책 없이 같은 목록 판정만 한다
  if (!('trustedTypes' in globalThis)) {
    policy = null;
    return policy;
  }
  const tt = (globalThis as unknown as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  policy = tt
    ? tt.createPolicy(REMOTE_POLICY, {
        createScriptURL(url: string) {
          if (!isAllowedRemoteEntry(url, location.href, allowedNow)) throw new TypeError(`원격 목록에 없는 주소: ${url}`);
          return url;
        },
      })
    : null;
  return policy;
}

function insertScript(r: ScriptRequest, allowed: ReadonlySet<string>): { remove(): void } {
  allowedNow = allowed;
  const p = remotePolicy();
  if (!p && !isAllowedRemoteEntry(r.src, location.href, allowed)) throw new TypeError(`원격 목록에 없는 주소: ${r.src}`);
  // 정책 판정을 요소를 만들기 전에 한다(거절이면 요청이 없다)
  const src = p ? p.createScriptURL(r.src) : r.src;
  const script = document.createElement('script');
  script.integrity = r.integrity;
  script.crossOrigin = 'anonymous';
  script.async = true;
  // 미리 싣기는 낮은 우선순위(속성을 모르는 브라우저는 무시한다)
  if (r.priority === 'low') script.setAttribute('fetchpriority', 'low');
  script.onload = () => r.onload();
  script.onerror = () => r.onerror();
  // Trusted Types가 있으면 정책을 거친 값만 넣는다(문자열을 바로 넣으면 보고 모드 위반이 난다)
  (script as unknown as { src: unknown }).src = src;
  document.head.appendChild(script);
  return { remove: () => script.remove() };
}

/**
 * 스크립트 오류의 까닭: 같은 출처 자원 시간 기록에 응답(2xx 상태, 상태를 모르는 브라우저는 받은 본문 바이트)이 있으면 무결성, 없거나 2xx가 아니면 네트워크로 본다.
 * 상태 칸(responseStatus)이 없는 브라우저(WebKit)는 transferSize가 머리 바이트만으로도 0보다 커서(본문 없는 404) 본문 크기(encodedBodySize)만 본다.
 * 브라우저가 오류 사건에 까닭을 싣지 않아 고른 추정이다(자원 시간 기록이 가득 차면 네트워크로 센다, ADR-0361 결정 5·'남는 한계')
 */
function classifyError(src: string): 'integrity' | 'network' {
  try {
    const abs = new URL(src, location.href).href;
    const e = performance.getEntriesByName(abs, 'resource').at(-1) as (PerformanceResourceTiming & { responseStatus?: number }) | undefined;
    if (!e) return 'network';
    if (typeof e.responseStatus === 'number' && e.responseStatus > 0) return e.responseStatus >= 200 && e.responseStatus < 300 ? 'integrity' : 'network';
    return e.encodedBodySize > 0 ? 'integrity' : 'network';
  } catch {
    return 'network';
  }
}

let loader: RemoteLoader | undefined;

function browserLoader(): RemoteLoader {
  loader ??= createRemoteLoader({
    async fetchList() {
      const r = await fetch(REMOTE_LIST_PATH, { cache: 'no-cache', credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as unknown;
    },
    insertScript,
    container: (name) => (globalThis as Record<string, unknown>)[name],
    async shareScope() {
      await __webpack_init_sharing__('default');
      return __webpack_share_scopes__.default;
    },
    timers: {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    classifyError,
    onFailure: (remote, reason) => remoteFailures().count(remote, reason),
  });
  return loader;
}

/** 원격 하나의 위젯 정보 목록을 싣는다(실패는 RemoteLoadError). priority 'low'는 미리 싣기다 */
export async function loadRemoteWidgets(name: RemoteName, o: { priority?: 'low' } = {}): Promise<readonly WidgetManifest[]> {
  if (__CONSOLE_BUILD__ === 'single') return loadLocalWidgets(name);
  return browserLoader().loadRemoteWidgets(name, o);
}

/** 원격 하나의 위젯 하나를 싣는다(위젯 정보의 계약 판을 다시 본다) */
export async function loadRemoteWidget(name: RemoteName, widget: string, o: { priority?: 'low' } = {}): Promise<ComponentType<WidgetProps>> {
  if (__CONSOLE_BUILD__ === 'single') {
    const m = (await loadLocalWidgets(name)).find((w) => w.name === widget);
    if (!m) throw new Error(`위젯이 없다: ${widget}`);
    return (await m.load()).default;
  }
  return browserLoader().loadRemoteWidget(name, widget, o);
}
