// F-08-5(MSR-050) 장시간 시험 자원 표본 도구.
//
// 정본: docs/verification.md §3.6·§3.5, docs/perf-ledger.md §2.3.
// 합본 파드의 inspector(CDP)에 붙어 GC 뒤 힙·RSS·열린 FD·활성 핸들을 읽고,
// PostgreSQL `pg_stat_activity`·Valkey `CLIENT LIST`는 바깥 명령으로 읽는다.
// 읽지 못한 값은 0으로 채우지 않고 null과 까닭을 남긴다.

const MB = 1024 * 1024;

const intAtLeast0 = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const finiteAtLeast0 = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** inspector Runtime.evaluate 결과(또는 그 안의 value)를 자원 표본으로 바꾼다 */
export function parseInspectorSample(cdpResult) {
  const value = cdpResult?.result?.value ?? cdpResult?.value ?? cdpResult ?? {};
  const missing = [];
  const heapUsed = finiteAtLeast0(value.heapUsed);
  const rss = finiteAtLeast0(value.rss);
  const openFds = intAtLeast0(value.openFds);
  const activeHandles = intAtLeast0(value.activeHandles);
  if (heapUsed === null) missing.push('heapUsed');
  if (rss === null) missing.push('rss');
  if (openFds === null) missing.push('openFds');
  if (activeHandles === null) missing.push('activeHandles');
  const out = {
    heapAfterGcMb: heapUsed === null ? null : heapUsed / MB,
    rssMb: rss === null ? null : rss / MB,
    openFds,
    activeHandles,
  };
  return missing.length ? { ...out, reason: `inspector에 없는 칸: ${missing.join(', ')}` } : out;
}

/** `psql -tAc`의 한 줄을 연결 수로 바꾼다. 빈 글·음수·NaN은 null */
export function parsePgActivityCount(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** DB 연결 수 질의 명령(네임스페이스·대상 application_name 접두 포함) */
export function pgActivityQuery({ namespace = 'v1', database = 'peaket_purchase', applicationNames = [] } = {}) {
  const names = Array.isArray(applicationNames) && applicationNames.length > 0
    ? applicationNames.map((n) => `application_name like '${String(n).replaceAll("'", "''")}%'`).join(' or ')
    : "application_name is not null";
  return `kubectl -n ${namespace} exec deploy/postgres -- psql -U postgres -d ${database} -tAc "select count(*) from pg_stat_activity where datname = '${database}' and (${names})"`;
}

/** `INFO clients`의 connected_clients. 없거나 NaN이면 null */
export function parseRedisClients(text) {
  const m = /(?:^|\n)connected_clients:(\d+)\s*(?:\n|$)/.exec(typeof text === 'string' ? text : '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** `CLIENT LIST`에서 name=접두가 맞는 줄만 센다. name 줄이 없으면 null */
export function parseRedisClientList(text, prefixes = []) {
  const lines = (typeof text === 'string' ? text : '').split('\n');
  const named = lines.map((l) => /(?:^|\s)name=([^\s]+)/.exec(l)?.[1]).filter(Boolean);
  if (named.length === 0) return null;
  const wanted = (Array.isArray(prefixes) ? prefixes : [prefixes]).filter((p) => typeof p === 'string' && p.length > 0);
  if (wanted.length === 0) return null;
  return named.filter((name) => wanted.some((p) => name.startsWith(p))).length;
}

/** GC 뒤 힙을 읽는 inspector 식. FD·활성 핸들도 같은 왕복에서 읽는다 */
export const INSPECTOR_EXPRESSION = `(async () => {
  const fs = await import('node:fs');
  const mem = process.memoryUsage();
  let openFds = null;
  try { openFds = fs.readdirSync('/proc/self/fd').length; } catch { openFds = null; }
  const activeHandles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : null;
  return { heapUsed: mem.heapUsed, rss: mem.rss, openFds, activeHandles };
})()`;

/**
 * GC를 먼저 부르고 한 번의 Runtime.evaluate로 힙·RSS·FD·핸들을 읽는다.
 * GC가 실패하면 evaluate를 부르지 않고 null과 까닭을 돌려준다. `cdp`는 `send(method, params)`를 가진다.
 */
export async function sampleWithGc(cdp, now = Date.now) {
  const atMs = typeof now === 'function' ? now() : Date.now();
  try {
    await cdp.send('HeapProfiler.collectGarbage', {});
  } catch (e) {
    return {
      atMs,
      heapAfterGcMb: null,
      rssMb: null,
      openFds: null,
      activeHandles: null,
      reason: `GC 실패: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`,
    };
  }
  try {
    const res = await cdp.send('Runtime.evaluate', {
      expression: INSPECTOR_EXPRESSION,
      returnByValue: true,
      awaitPromise: true,
    });
    return { atMs, ...parseInspectorSample(res) };
  } catch (e) {
    return {
      atMs,
      heapAfterGcMb: null,
      rssMb: null,
      openFds: null,
      activeHandles: null,
      reason: `inspector evaluate 실패: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`,
    };
  }
}
