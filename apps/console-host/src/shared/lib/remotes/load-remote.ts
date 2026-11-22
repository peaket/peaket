// 원격 위젯 싣기(Module Federation, ADR-0100 결정 6, ADR-0360 결정 6·7).
// 원격은 따로 빌드한 webpack 컨테이너이고(apps/widgets/queue·purchase), 같은 출처 /remotes/<이름>/remoteEntry.js에서 실행 중에 받는다.
// 진입 파일 주소는 Trusted Types 정책 peaket-remote로만 <script>에 넣고, 정책은 빌드에 박은 원격 둘의 주소만 통과시킨다(목록 밖이면 던진다).
// 목록 원천(remotes.json)·sha384 무결성·계약 주판 확인·대체 카드는 F-03-2(OPS-350)가 이 자리를 바꾼다.
// 한 앱 빌드(PEAKET_CONSOLE_BUILD=single, FE-T29 기준선)는 원격을 받지 않고 같은 소스를 작업 공간 패키지로 묶는다(local-widgets).
import type { WidgetManifest } from '@peaket/console-contract';
import { loadLocalWidgets } from './local-widgets';

export type RemoteName = 'queue' | 'purchase';

/** 원격 이름 → webpack 컨테이너 이름(전역 이름)과 진입 파일 주소. 빌드에 박는다 */
export const REMOTES: Readonly<Record<RemoteName, { container: string; entry: string }>> = {
  queue: { container: 'peaket_widget_queue', entry: '/remotes/queue/remoteEntry.js' },
  purchase: { container: 'peaket_widget_purchase', entry: '/remotes/purchase/remoteEntry.js' },
};

/** 원격 진입 파일만 통과시키는 Trusted Types 정책 이름(§5.14.1 'Trusted Types' 허용 목록 안) */
export const REMOTE_POLICY = 'peaket-remote';

interface WebpackContainer {
  init(scope: unknown): Promise<void> | void;
  get(module: string): Promise<() => unknown>;
}

interface TrustedTypesLike {
  createPolicy(name: string, rules: { createScriptURL(url: string): string }): { createScriptURL(url: string): unknown };
}

let policy: { createScriptURL(url: string): unknown } | null | undefined;

/** 주소가 목록 안의 원격 진입 파일인가(같은 출처, 경로가 정확히 같다) */
export function isAllowedRemoteEntry(url: string, base: string): boolean {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return false;
  }
  const origin = new URL(base).origin;
  return u.origin === origin && u.search === '' && u.hash === '' && Object.values(REMOTES).some((r) => r.entry === u.pathname);
}

function remotePolicy(): { createScriptURL(url: string): unknown } | null {
  if (policy !== undefined) return policy;
  // Trusted Types가 없는 브라우저(iOS Safari 16.4 등)는 정책 없이 같은 목록 판정만 한다
  if (!('trustedTypes' in globalThis)) {
    policy = null;
    return policy;
  }
  const tt = (globalThis as unknown as { trustedTypes: TrustedTypesLike }).trustedTypes;
  policy = tt
    ? tt.createPolicy(REMOTE_POLICY, {
        createScriptURL(url: string) {
          if (!isAllowedRemoteEntry(url, location.href)) throw new TypeError(`원격 목록에 없는 주소: ${url}`);
          return url;
        },
      })
    : null;
  return policy;
}

const loading = new Map<RemoteName, Promise<WebpackContainer>>();

function loadEntry(name: RemoteName): Promise<WebpackContainer> {
  const hit = loading.get(name);
  if (hit) return hit;
  const { container, entry } = REMOTES[name];
  const p = new Promise<WebpackContainer>((resolve, reject) => {
    const existing = (globalThis as Record<string, unknown>)[container] as WebpackContainer | undefined;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement('script');
    const p2 = remotePolicy();
    if (!p2 && !isAllowedRemoteEntry(entry, location.href)) {
      reject(new TypeError(`원격 목록에 없는 주소: ${entry}`));
      return;
    }
    // Trusted Types가 있으면 정책을 거친 값만 넣는다(문자열을 바로 넣으면 보고 모드 위반이 난다)
    (script as unknown as { src: unknown }).src = p2 ? p2.createScriptURL(entry) : entry;
    script.async = true;
    script.onload = () => {
      const c = (globalThis as Record<string, unknown>)[container] as WebpackContainer | undefined;
      if (c) resolve(c);
      else reject(new Error(`원격 컨테이너가 없다: ${container}`));
    };
    script.onerror = () => reject(new Error(`원격 진입 파일을 받지 못했다: ${entry}`));
    document.head.appendChild(script);
  });
  // 실패하면 다음 시도가 다시 받게 지운다
  p.catch(() => loading.delete(name));
  loading.set(name, p);
  return p;
}

const initialized = new Set<RemoteName>();

/** 원격 하나의 위젯 정보 목록을 싣는다 */
export async function loadRemoteWidgets(name: RemoteName): Promise<readonly WidgetManifest[]> {
  if (__CONSOLE_BUILD__ === 'single') return loadLocalWidgets(name);
  const container = await loadEntry(name);
  if (!initialized.has(name)) {
    await __webpack_init_sharing__('default');
    await container.init(__webpack_share_scopes__.default);
    initialized.add(name);
  }
  const factory = await container.get('./widgets');
  const mod = factory() as { widgets: readonly WidgetManifest[] };
  return mod.widgets;
}
