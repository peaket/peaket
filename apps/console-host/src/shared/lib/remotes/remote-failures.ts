// 원격 싣기 실패 수 remote_load_failed_total{remote, reason}(docs/frontend.md §5.7 '원격 실패'·§5.16, ASVS 16.3.3, ADR-0361 결정 5).
// 본문은 계약 RumSample 판 2(asyncapi, 브라우저 지표 묶음)의 표본 하나이고 수는 선택 칸 counters = [{name, labels, value}]다
// (소비자 웹 검색 품질 수와 같은 꼴, apps/web/src/widgets/app-shell/model/search-quality.ts). 같은 출처 /_t/rum으로만 보내고
// 주소·쿼리·사람 식별값을 싣지 않는다(route는 원격 위젯이 있는 화면의 경로 템플릿 '/dashboard'). 첫 실패 뒤 1초 [가정] 묶어 보내고,
// 화면을 숨길 때·떠날 때 남은 것을 보낸다. 보내기는 fetch(keepalive, 쿠키 없음, Referer 없음)이고 keepalive를 모르면 sendBeacon이다.
// 수집기가 없어 보내기가 실패해도 화면은 그대로다(지표는 잃어도 된다).
import { REMOTE_LOAD_FAIL_REASONS, type RemoteLoadFailReason } from '@peaket/console-contract';

export const REMOTE_FAILURE_PATH = '/_t/rum';
export const REMOTE_FAILURE_METRIC = 'remote_load_failed_total';
/** 첫 실패 뒤 묶어 보내기까지 1초 [가정] */
export const REMOTE_FAILURE_FLUSH_MS = 1_000;
const KNOWN_REMOTES = ['queue', 'purchase'];

export interface RemoteFailures {
  count(remote: string, reason: RemoteLoadFailReason): void;
  flush(): Promise<void>;
}

export interface RemoteFailuresDeps {
  send(path: string, body: string): Promise<void>;
  timers: { setTimeout(fn: () => void, ms: number): unknown };
  uuid(): string;
  flushMs?: number;
}

export function createRemoteFailures(d: RemoteFailuresDeps): RemoteFailures {
  const counts = new Map<string, { remote: string; reason: RemoteLoadFailReason; value: number }>();
  let scheduled = false;
  async function flush(): Promise<void> {
    scheduled = false;
    if (counts.size === 0) return;
    const counters = [...counts.values()].map((c) => ({ name: REMOTE_FAILURE_METRIC, labels: { remote: c.remote, reason: c.reason }, value: c.value }));
    counts.clear();
    const body = JSON.stringify({ schemaVersion: 2, eventKey: d.uuid(), app: 'console', route: '/dashboard', counters });
    try {
      await d.send(REMOTE_FAILURE_PATH, body);
    } catch {
      // 지표는 잃어도 된다
    }
  }
  return {
    count(remote, reason) {
      // 라벨 값은 정해진 것만(라벨 수를 늘리지 않게)
      if (!KNOWN_REMOTES.includes(remote) || !REMOTE_LOAD_FAIL_REASONS.includes(reason)) return;
      const key = `${remote} ${reason}`;
      const c = counts.get(key);
      if (c) c.value += 1;
      else counts.set(key, { remote, reason, value: 1 });
      if (!scheduled) {
        scheduled = true;
        d.timers.setTimeout(() => void flush(), d.flushMs ?? REMOTE_FAILURE_FLUSH_MS);
      }
    },
    flush,
  };
}

/** fetch(keepalive, 쿠키 없음)로 보내고 keepalive가 안 되는 브라우저만 sendBeacon(@peaket/telemetry lite sendBatch와 같은 규칙) */
async function sendBatch(path: string, body: string): Promise<void> {
  if (!(typeof Request === 'function' && 'keepalive' in Request.prototype)) {
    navigator.sendBeacon(path, body);
    return;
  }
  await fetch(path, { method: 'POST', body, keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'content-type': 'application/json' } });
}

let failures: RemoteFailures | undefined;

/** 브라우저의 실패 수(한 번만 만든다) */
export function remoteFailures(): RemoteFailures {
  if (failures) return failures;
  const f = createRemoteFailures({ send: sendBatch, timers: { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) }, uuid: () => globalThis.crypto.randomUUID() });
  failures = f;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void f.flush();
    });
    window.addEventListener('pagehide', () => void f.flush());
  }
  return f;
}
