// 원격 위젯 적재기(docs/frontend.md §4.5 '싣는 순서', ADR-0360 결정 6, ADR-0361 결정 1·5·6). 브라우저 쪽 손잡이(스크립트 넣기·전역 컨테이너·시계·목록 받기)는
// 넘겨받는 순수 모듈이라 Node 내장 시험 실행기로 그대로 읽는다(load-remote.ts가 브라우저 값을 꽂는다).
// 순서: 원격 목록(/remotes.json) 읽기 → 항목 검사(parseRemoteList, 정식 주소·sha384 꼴) → 계약 판 확인(다르면 받지 않는다) →
//   integrity·crossorigin="anonymous"를 붙인 스크립트를 Trusted Types 정책 peaket-remote로 넣는다(시간 초과 5초 [가정]) →
//   실패(무결성·네트워크·시간 초과·컨테이너 없음)하면 한 번 다시 → 또 실패하면 RemoteLoadError{remote, reason}을 던진다(그 칸만 대체 카드).
// 판 불일치·목록 거절·정책 거절은 다시 받지 않는다. 실패 수는 마지막 실패에 한 번 센다(onFailure). 늦게 온 응답은 무시한다.
// 같은 원격의 동시 요청은 하나로 묶고, 실패하면 기억(적재·목록)을 지워 다음 호출([다시 시도])이 새로 받는다. 미리 싣기(priority 'low')는
// 이미 마지막에 실패한 원격을 다시 받지 않는다(그 실패를 그대로 돌려주고 다시 세지 않는다. 다시 받기는 사람이 [다시 시도]로 한다).
// 미리 싣기도 같은 함수(priority 'low')라 무결성·정책·판 확인을 그대로 거친다(ADR-0091 결정 1의 '거치지 않으면 미리 받지 않는다', ADR-0361 결정 6).
import { CONTRACT_MAJOR, parseRemoteList, type RemoteListEntry, type RemoteLoadFailReason, type WidgetManifest, type WidgetProps } from '@peaket/console-contract';
import type { ComponentType } from 'react';

/** 진입 파일 시간 초과 5초 [가정](frontend §4.5) */
export const REMOTE_ENTRY_TIMEOUT_MS = 5_000;
/** 진입 파일 실패 뒤 다시 받는 횟수(frontend §4.5 '한 번 다시') */
export const REMOTE_ENTRY_RETRIES = 1;

export type RemoteName = 'queue' | 'purchase';
/** 원격 이름 → webpack 컨테이너 이름(전역 이름, webpack.config.mjs REMOTES와 같다) */
export const REMOTE_CONTAINERS: Readonly<Record<RemoteName, string>> = { queue: 'peaket_widget_queue', purchase: 'peaket_widget_purchase' };
export const REMOTE_NAMES = Object.keys(REMOTE_CONTAINERS) as RemoteName[];

export class RemoteLoadError extends Error {
  constructor(
    readonly remote: string,
    readonly reason: RemoteLoadFailReason,
    message?: string,
  ) {
    super(message ?? `원격 ${remote}을 싣지 못했다(${reason})`);
    this.name = 'RemoteLoadError';
  }
}

export interface WebpackContainer {
  init(scope: unknown): Promise<void> | void;
  get(module: string): Promise<() => unknown>;
}

export interface ScriptRequest {
  /** 진입 파일 주소(목록의 entry 그대로. 정책이 정식 주소인지 다시 본다) */
  src: string;
  integrity: string;
  priority?: 'low';
  onload(): void;
  onerror(): void;
}

export interface RemoteLoaderDeps {
  /** GET /remotes.json의 JSON(실패하면 던진다) */
  fetchList(): Promise<unknown>;
  /** 스크립트 요소를 넣는다. 정책이 주소를 거절하면 'policy' 까닭의 RemoteLoadError가 아닌 아무 오류나 던진다 */
  insertScript(r: ScriptRequest, allowed: ReadonlySet<string>): { remove(): void };
  /** 전역 컨테이너(없으면 undefined) */
  container(name: string): unknown;
  /** 공유 범위를 열고(호스트 __webpack_init_sharing__) 그 범위를 돌려준다 */
  shareScope(): Promise<unknown>;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  /** 스크립트 오류가 무결성 때문인지(바이트는 받았다) 네트워크 때문인지 */
  classifyError(src: string): 'integrity' | 'network';
  /** 마지막 실패를 센다(remote_load_failed_total) */
  onFailure?(remote: string, reason: RemoteLoadFailReason): void;
  timeoutMs?: number;
  /** 호스트 계약 판(시험이 바꾼다) */
  hostMajor?: number;
}

const isContainer = (c: unknown): c is WebpackContainer =>
  !!c && (typeof c === 'object' || typeof c === 'function') && typeof (c as WebpackContainer).get === 'function' && typeof (c as WebpackContainer).init === 'function';

/** strictVersion 공유 싱글턴 판이 맞지 않을 때 webpack이 내는 오류(계약 패키지 판 범위 밖) */
const UNSATISFIED = /Unsatisfied version/;

export interface RemoteLoader {
  /** 원격 하나의 위젯 정보 목록을 싣는다(실패는 RemoteLoadError) */
  loadRemoteWidgets(name: RemoteName, o?: { priority?: 'low' }): Promise<readonly WidgetManifest[]>;
  /** 원격 하나의 위젯 하나를 싣는다(위젯 정보의 계약 판도 다시 본다) */
  loadRemoteWidget(name: RemoteName, widget: string, o?: { priority?: 'low' }): Promise<ComponentType<WidgetProps>>;
}

export function createRemoteLoader(d: RemoteLoaderDeps): RemoteLoader {
  const hostMajor = d.hostMajor ?? CONTRACT_MAJOR;
  const timeoutMs = d.timeoutMs ?? REMOTE_ENTRY_TIMEOUT_MS;
  let list: Promise<{ entries: RemoteListEntry[]; allowed: ReadonlySet<string> }> | undefined;
  const loads = new Map<RemoteName, Promise<readonly WidgetManifest[]>>();
  /** 마지막에 실패한 원격과 그 오류(미리 싣기가 다시 받지 않게) */
  const failed = new Map<RemoteName, RemoteLoadError>();
  const initialized = new Set<RemoteName>();

  function readList() {
    list ??= d.fetchList().then((json) => {
      const { entries } = parseRemoteList(json, { known: REMOTE_NAMES });
      // 정책이 통과시키는 주소: 받아들인 항목의 정식 주소만
      return { entries, allowed: new Set(entries.map((e) => `/remotes/${e.name}/${e.sha}/remoteEntry.js`)) };
    });
    return list;
  }

  /** 진입 파일 한 번 받기 */
  function attempt(name: RemoteName, e: RemoteListEntry, allowed: ReadonlySet<string>, priority?: 'low'): Promise<WebpackContainer> {
    return new Promise<WebpackContainer>((resolve, reject) => {
      const existing = d.container(REMOTE_CONTAINERS[name]);
      if (isContainer(existing)) {
        // 앞서 늦게 온 응답이 무결성 확인을 거쳐 실행됐다
        resolve(existing);
        return;
      }
      let settled = false;
      let handle: { remove(): void } | undefined;
      const done = (f: () => void) => {
        if (settled) return;
        settled = true;
        d.timers.clearTimeout(timer);
        f();
      };
      const timer = d.timers.setTimeout(() => {
        done(() => {
          handle?.remove();
          reject(new RemoteLoadError(name, 'timeout', `원격 진입 파일이 ${timeoutMs}ms 안에 오지 않았다: ${e.entry}`));
        });
      }, timeoutMs);
      try {
        handle = d.insertScript(
          {
            src: e.entry,
            integrity: e.integrity,
            ...(priority ? { priority } : {}),
            onload: () =>
              done(() => {
                const c = d.container(REMOTE_CONTAINERS[name]);
                if (isContainer(c)) resolve(c);
                else reject(new RemoteLoadError(name, 'container', `원격 컨테이너가 없다: ${REMOTE_CONTAINERS[name]}`));
              }),
            onerror: () =>
              done(() => {
                handle?.remove();
                reject(new RemoteLoadError(name, d.classifyError(e.entry), `원격 진입 파일을 받지 못했다: ${e.entry}`));
              }),
          },
          allowed,
        );
      } catch (err) {
        done(() => reject(new RemoteLoadError(name, 'policy', `peaket-remote 정책이 주소를 거절했다: ${e.entry} (${String(err)})`)));
      }
    });
  }

  async function entryWithRetry(name: RemoteName, e: RemoteListEntry, allowed: ReadonlySet<string>, priority?: 'low'): Promise<WebpackContainer> {
    let last: RemoteLoadError | undefined;
    for (let i = 0; i <= REMOTE_ENTRY_RETRIES; i += 1) {
      try {
        return await attempt(name, e, allowed, priority);
      } catch (err) {
        last = err instanceof RemoteLoadError ? err : new RemoteLoadError(name, 'network', String(err));
        if (last.reason === 'policy') break;
      }
    }
    throw last ?? new RemoteLoadError(name, 'network');
  }

  async function load(name: RemoteName, priority?: 'low'): Promise<readonly WidgetManifest[]> {
    let l: Awaited<ReturnType<typeof readList>>;
    try {
      l = await readList();
    } catch (err) {
      throw new RemoteLoadError(name, 'list', `원격 목록을 읽지 못했다: ${String(err)}`);
    }
    const e = l.entries.find((x) => x.name === name);
    if (!e) throw new RemoteLoadError(name, 'list', `원격 목록에 ${name}이 없거나 항목이 틀렸다`);
    if (e.contractMajor !== hostMajor) throw new RemoteLoadError(name, 'contract', `원격 ${name}의 계약 판 ${e.contractMajor} ≠ 호스트 ${hostMajor}`);
    const container = await entryWithRetry(name, e, l.allowed, priority);
    try {
      if (!initialized.has(name)) {
        await container.init(await d.shareScope());
        initialized.add(name);
      }
      const factory = await container.get('./widgets');
      const mod = factory() as { widgets?: unknown };
      if (!Array.isArray(mod?.widgets)) throw new Error('노출 모듈에 widgets 목록이 없다');
      return mod.widgets as readonly WidgetManifest[];
    } catch (err) {
      if (err instanceof RemoteLoadError) throw err;
      throw new RemoteLoadError(name, UNSATISFIED.test(String(err)) ? 'contract' : 'container', String(err));
    }
  }

  function fail(name: RemoteName, err: unknown): never {
    const r = err instanceof RemoteLoadError ? err : new RemoteLoadError(name, 'container', String(err));
    d.onFailure?.(name, r.reason);
    throw r;
  }

  function loadRemoteWidgets(name: RemoteName, o: { priority?: 'low' } = {}): Promise<readonly WidgetManifest[]> {
    const hit = loads.get(name);
    if (hit) return hit;
    const last = failed.get(name);
    if (last && o.priority === 'low') return Promise.reject(last);
    failed.delete(name);
    const p = load(name, o.priority).catch((err: unknown) => {
      // 다음 호출([다시 시도])이 목록부터 새로 받게 지운다
      loads.delete(name);
      list = undefined;
      failed.set(name, err instanceof RemoteLoadError ? err : new RemoteLoadError(name, 'container', String(err)));
      return fail(name, err);
    });
    loads.set(name, p);
    return p;
  }

  async function loadRemoteWidget(name: RemoteName, widget: string, o: { priority?: 'low' } = {}): Promise<ComponentType<WidgetProps>> {
    const widgets = await loadRemoteWidgets(name, o);
    const m = widgets.find((w) => w.name === widget);
    if (!m) return fail(name, new RemoteLoadError(name, 'container', `원격 ${name}에 위젯 ${widget}이 없다`));
    if (m.contractMajor !== hostMajor) return fail(name, new RemoteLoadError(name, 'contract', `위젯 ${widget}의 계약 판 ${String(m.contractMajor)} ≠ 호스트 ${hostMajor}`));
    try {
      return (await m.load()).default;
    } catch (err) {
      return fail(name, new RemoteLoadError(name, UNSATISFIED.test(String(err)) ? 'contract' : 'container', String(err)));
    }
  }

  return { loadRemoteWidgets, loadRemoteWidget };
}
