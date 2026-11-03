// 부하 실행 곁에서 잰 값의 계산(docs/verification.md §3.10): DB 통계 차이(K3), HPA 시간선(K9), 검표 구간(K10), 변경분 연결(K4).
// Node에서만 쓴다. 변경분 받는 파드(delta-client.mjs)도 latencyBucket을 가져다 쓴다.

/** 변경분 종단 지연 칸 경계(ms). 칸 수는 이 길이 + 1(마지막은 30초 넘음) */
export const LAT_BOUNDS_MS = Object.freeze([1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000, 30000]);

const r1 = (x) => Math.round(x * 10) / 10;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * 지연 ms가 들어갈 칸 번호: ms ≤ LAT_BOUNDS_MS[i]인 가장 작은 i, 없으면 LAT_BOUNDS_MS.length.
 * 음수는 0칸(시계 차이), 유한한 수가 아니면 RangeError
 * @param {number} ms
 * @returns {number}
 */
export function latencyBucket(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new RangeError(`지연은 유한한 수다: ${ms}`);
  for (let i = 0; i < LAT_BOUNDS_MS.length; i++) if (ms <= LAT_BOUNDS_MS[i]) return i;
  return LAT_BOUNDS_MS.length;
}

const TABLE_KEYS = ['n_tup_ins', 'n_tup_upd', 'n_tup_hot_upd', 'n_tup_del', 'n_live_tup', 'n_dead_tup'];
const DB_KEYS = ['deadlocks', 'xact_commit', 'xact_rollback'];

function checkSnapshot(s, which) {
  if (!isObj(s) || !Number.isFinite(s.atMs) || !isObj(s.database) || !isObj(s.tables)) throw new RangeError(`DB 통계(${which}) 모양이 틀렸다`);
  for (const k of DB_KEYS) if (!isCount(s.database[k])) throw new RangeError(`DB 통계(${which}) ${k}는 0 이상 정수다`);
  for (const [t, v] of Object.entries(s.tables)) {
    if (!isObj(v)) throw new RangeError(`DB 통계(${which}) 표 ${t} 모양이 틀렸다`);
    for (const k of TABLE_KEYS) if (!isCount(v[k])) throw new RangeError(`DB 통계(${which}) 표 ${t}의 ${k}는 0 이상 정수다`);
  }
}

/**
 * DB 통계 두 번(실행 전·후)의 차이(K3, S-T10). 입력 모양:
 * { atMs, database: { deadlocks, xact_commit, xact_rollback }, tables: { <표>: { n_tup_ins, n_tup_upd, n_tup_hot_upd, n_tup_del, n_live_tup, n_dead_tup } } }
 * 결과: { durationS: (after.atMs − before.atMs) ÷ 1000(소수 첫째 자리), deadlocks, commits, rollbacks,
 *   tables: { <표>: { inserts, updates, hotUpdates, deletes, hotRatio, liveRows, deadRows } } }.
 * 누적 칸은 after − before이고(before에 없는 표는 0에서), liveRows·deadRows는 after의 값이다.
 * hotRatio = hotUpdates ÷ updates(소수 넷째 자리, updates가 0이면 null). 표는 after에 있는 것만, 이름 순.
 * 누적 칸이 줄었거나(통계 초기화) 수가 0 이상 정수가 아니면 RangeError
 * @param {any} before
 * @param {any} after
 */
export function dbStatsDelta(before, after) {
  checkSnapshot(before, '전');
  checkSnapshot(after, '후');
  const diff = (a, b, what) => {
    const d = a - b;
    if (d < 0) throw new RangeError(`DB 통계 ${what}가 줄었다(통계 초기화?)`);
    return d;
  };
  const tables = {};
  for (const t of Object.keys(after.tables).sort()) {
    const a = after.tables[t];
    const b = isObj(before.tables[t]) ? before.tables[t] : { n_tup_ins: 0, n_tup_upd: 0, n_tup_hot_upd: 0, n_tup_del: 0 };
    const updates = diff(a.n_tup_upd, b.n_tup_upd, `${t}.n_tup_upd`);
    const hotUpdates = diff(a.n_tup_hot_upd, b.n_tup_hot_upd, `${t}.n_tup_hot_upd`);
    tables[t] = {
      inserts: diff(a.n_tup_ins, b.n_tup_ins, `${t}.n_tup_ins`),
      updates,
      hotUpdates,
      deletes: diff(a.n_tup_del, b.n_tup_del, `${t}.n_tup_del`),
      hotRatio: updates === 0 ? null : Math.round((hotUpdates / updates) * 10000) / 10000,
      liveRows: a.n_live_tup,
      deadRows: a.n_dead_tup,
    };
  }
  return {
    durationS: r1((after.atMs - before.atMs) / 1000),
    deadlocks: diff(after.database.deadlocks, before.database.deadlocks, 'deadlocks'),
    commits: diff(after.database.xact_commit, before.database.xact_commit, 'xact_commit'),
    rollbacks: diff(after.database.xact_rollback, before.database.xact_rollback, 'xact_rollback'),
    tables,
  };
}

const ms = (iso) => {
  if (typeof iso !== 'string' || !iso) return NaN;
  return Date.parse(iso);
};

/**
 * HPA 시간선(K9). events는 쿠버네티스 Event 목록(items), pods는 앱 파드 목록(items), loadStartMs는 부하를 시작한 시각(이 PC 시계, ms).
 * - 사건: reason이 'SuccessfulRescale'이고 involvedObject.kind가 'HorizontalPodAutoscaler'인 것. 시각은 eventTime, 없으면 lastTimestamp,
 *   없으면 firstTimestamp. 메시지의 'New size: <n>'에서 크기를 읽는다(없으면 그 사건은 건너뛴다).
 * - 쿠버네티스 시각은 초 단위로 잘리므로 '부하 시작 뒤'는 시각 ≥ ⌊loadStartMs ÷ 1000⌋ × 1000으로 본다. 그 앞의 사건·파드는 뺀다(새 파드가 아니다).
 * - 새 파드: metadata.creationTimestamp가 위 기준 이후인 파드. 준비 시각은 status.conditions에서 type 'Ready'·status 'True'의 lastTransitionTime(없으면 null).
 * 결과(초는 loadStartMs 기준, 소수 첫째 자리): { rescales: [{ atS, size }](시각 순), firstRescaleS(없으면 null),
 *   newPods: [{ name, createdS, readyS }](만든 시각 순), firstNewReadyS(준비된 새 파드 중 가장 이른 readyS, 없으면 null), maxSize(없으면 null) }
 * loadStartMs가 유한한 수가 아니면 RangeError
 * @param {{ events: any[], pods: any[], loadStartMs: number }} o
 */
export function hpaTimeline(o) {
  if (!isObj(o) || typeof o.loadStartMs !== 'number' || !Number.isFinite(o.loadStartMs)) throw new RangeError('부하 시작 시각이 유한한 수가 아니다');
  const start = o.loadStartMs;
  const floor = Math.floor(start / 1000) * 1000;
  const rel = (t) => r1((t - start) / 1000);
  const rescales = [];
  for (const e of Array.isArray(o.events) ? o.events : []) {
    if (!isObj(e) || e.reason !== 'SuccessfulRescale' || e.involvedObject?.kind !== 'HorizontalPodAutoscaler') continue;
    const t = [e.eventTime, e.lastTimestamp, e.firstTimestamp].map(ms).find((x) => Number.isFinite(x));
    if (t === undefined || t < floor) continue;
    const m = /New size: (\d+)/.exec(String(e.message ?? ''));
    if (!m) continue;
    rescales.push({ t, size: Number(m[1]) });
  }
  rescales.sort((a, b) => a.t - b.t);
  const newPods = [];
  for (const p of Array.isArray(o.pods) ? o.pods : []) {
    const created = ms(p?.metadata?.creationTimestamp);
    if (!Number.isFinite(created) || created < floor) continue;
    const ready = (Array.isArray(p?.status?.conditions) ? p.status.conditions : []).find((c) => c?.type === 'Ready' && c?.status === 'True');
    const readyT = ms(ready?.lastTransitionTime);
    newPods.push({ name: String(p.metadata.name), created, readyT: Number.isFinite(readyT) ? readyT : null });
  }
  newPods.sort((a, b) => a.created - b.created || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const ready = newPods.filter((p) => p.readyT !== null).map((p) => rel(p.readyT));
  return {
    rescales: rescales.map((r) => ({ atS: rel(r.t), size: r.size })),
    firstRescaleS: rescales.length ? rel(rescales[0].t) : null,
    newPods: newPods.map((p) => ({ name: p.name, createdS: rel(p.created), readyS: p.readyT === null ? null : rel(p.readyT) })),
    firstNewReadyS: ready.length ? Math.min(...ready) : null,
    maxSize: rescales.length ? Math.max(...rescales.map((r) => r.size)) : null,
  };
}

const nearestRank = (xs, q) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
};

/**
 * 검표 구간 요약(K10, O-T1의 v0 한계). probes는 { kind: 'gate_scan', startedMs, endedMs, ok, result } 목록이다
 * (ok는 판정을 받았는지, result는 ADMIT·ALREADY_ENTERED·INVALID·WRONG_EVENT 또는 null).
 * w = { mainStartMs, cutStartMs, cutEndMs, mainEndMs }(이 순서로 커진다, 아니면 RangeError). 구간은 시작 시각(startedMs)으로 나눈다:
 * online [mainStartMs, cutStartMs), cut [cutStartMs, cutEndMs), restored [cutEndMs, mainEndMs). 창 밖 시도는 뺀다.
 * 구간마다 { attempts, judged, failed, perMinute: judged ÷ 구간 초 × 60(소수 첫째 자리), p95Ms: 판정받은 시도의 (endedMs − startedMs)
 *   p95(가장 가까운 순위, 없으면 null) }.
 * maxGapS: 창 안에서 판정을 받은 시도의 endedMs를 정렬해, 창 시작 → 첫 판정, 판정 사이, 마지막 판정 → 창 끝 가운데 가장 긴 간격(초, 소수 첫째 자리).
 *   판정이 하나도 없으면 창 전체 길이. offlineRatio = cut.perMinute ÷ online.perMinute(소수 셋째 자리, online이 0이면 null).
 * results: 판정 결과별 수(창 안). 결과: { online, cut, restored, maxGapS, offlineRatio, results }
 * @param {Array<{ kind: string, startedMs: number, endedMs: number, ok: boolean, result: string | null }>} probes
 * @param {{ mainStartMs: number, cutStartMs: number, cutEndMs: number, mainEndMs: number }} w
 */
export function gateSummary(probes, w) {
  if (!isObj(w) || ![w.mainStartMs, w.cutStartMs, w.cutEndMs, w.mainEndMs].every(Number.isFinite) || !(w.mainStartMs < w.cutStartMs && w.cutStartMs < w.cutEndMs && w.cutEndMs < w.mainEndMs)) {
    throw new RangeError('검표 창은 본구간 시작 < 끊김 시작 < 끊김 끝 < 본구간 끝이어야 한다');
  }
  const phases = { online: [w.mainStartMs, w.cutStartMs], cut: [w.cutStartMs, w.cutEndMs], restored: [w.cutEndMs, w.mainEndMs] };
  const inWin = (Array.isArray(probes) ? probes : []).filter((p) => p.startedMs >= w.mainStartMs && p.startedMs < w.mainEndMs);
  const out = {};
  for (const [name, [a, b]] of Object.entries(phases)) {
    const xs = inWin.filter((p) => p.startedMs >= a && p.startedMs < b);
    const judged = xs.filter((p) => p.ok);
    out[name] = {
      attempts: xs.length,
      judged: judged.length,
      failed: xs.length - judged.length,
      perMinute: r1((judged.length / ((b - a) / 1000)) * 60),
      p95Ms: nearestRank(judged.map((p) => p.endedMs - p.startedMs), 0.95),
    };
  }
  const ends = inWin.filter((p) => p.ok).map((p) => p.endedMs).sort((a, b) => a - b);
  let gap;
  if (ends.length === 0) gap = w.mainEndMs - w.mainStartMs;
  else {
    gap = Math.max(ends[0] - w.mainStartMs, w.mainEndMs - ends[ends.length - 1]);
    for (let i = 1; i < ends.length; i++) gap = Math.max(gap, ends[i] - ends[i - 1]);
  }
  const results = {};
  for (const p of inWin) if (p.ok && typeof p.result === 'string') results[p.result] = (results[p.result] ?? 0) + 1;
  return {
    ...out,
    maxGapS: r1(gap / 1000),
    offlineRatio: out.online.perMinute === 0 ? null : Math.round((out.cut.perMinute / out.online.perMinute) * 1000) / 1000,
    results,
  };
}

/**
 * 검표의 온라인 판정 목표 점검(K10, docs/verification.md §3.10 '온라인 판정 p95 150ms'). collect.py --checks의 점검 하나다.
 * 망이 끊긴 구간·되돌린 구간의 시도는 세지 않는다(끊긴 동안의 빠른 실패가 목표 안으로 잡히지 않게). probes·w는 gateSummary와 같다.
 * 시행 수 = online 구간 [mainStartMs, cutStartMs)에 시작한(startedMs) gate_scan 시도 수, 어긴 수 = 그 가운데 판정을 받지 못했거나(ok가 아님)
 * endedMs − startedMs가 le(ms)보다 큰 시도 수(같으면 지킨 것). 결과: { name: 'scan_p95_<le>ms', allowed, trials, violations,
 * target: 'scan p95 ≤ <le>ms(온라인 구간)' }. 시행이 0이면 null. le는 양의 정수, allowed는 0 초과 1 미만(아니면 RangeError)
 * @param {Array<{ kind: string, startedMs: number, endedMs: number, ok: boolean }>} probes
 * @param {{ mainStartMs: number, cutStartMs: number, cutEndMs: number, mainEndMs: number }} w
 * @param {{ le?: number, allowed?: number }} [o]
 * @returns {{ name: string, allowed: number, trials: number, violations: number, target: string } | null}
 */
export function gateOnlineCheck(probes, w, o = {}) {
  const le = o.le ?? 150;
  const allowed = o.allowed ?? 0.05;
  if (!Number.isSafeInteger(le) || le < 1) throw new RangeError(`목표 시간은 양의 정수(ms)다: ${le}`);
  if (typeof allowed !== 'number' || !(allowed > 0 && allowed < 1)) throw new RangeError(`허용 비율은 0과 1 사이다: ${allowed}`);
  if (!Array.isArray(probes)) throw new RangeError('검표 시도 목록이 아니다');
  const keys = ['mainStartMs', 'cutStartMs', 'cutEndMs', 'mainEndMs'];
  if (w === null || typeof w !== 'object' || !keys.every((k) => Number.isFinite(w[k])) || !(w.mainStartMs < w.cutStartMs && w.cutStartMs < w.cutEndMs && w.cutEndMs < w.mainEndMs)) {
    throw new RangeError('구간 시각이 차례대로 커지지 않는다');
  }
  let trials = 0;
  let violations = 0;
  for (const p of probes) {
    if (p === null || typeof p !== 'object' || p.kind !== 'gate_scan' || !Number.isFinite(p.startedMs) || !Number.isFinite(p.endedMs)) throw new RangeError('검표 시도 줄이 아니다');
    if (p.startedMs < w.mainStartMs || p.startedMs >= w.cutStartMs) continue;
    trials += 1;
    if (p.ok !== true || p.endedMs - p.startedMs > le) violations += 1;
  }
  return trials === 0 ? null : { name: `scan_p95_${le}ms`, allowed, trials, violations, target: `scan p95 ≤ ${le}ms(온라인 구간)` };
}

/**
 * 변경분 연결 요약(K4, S-T12의 v0 쪽). lines는 받는 파드들이 낸 줄이다:
 * - { kind: 'delta_bucket', pod, sec, msgs, bytes, lat, opened, closed, errors }: 1초(에포크 초 sec) 칸. lat은 LAT_BOUNDS_MS 칸 수(길이 LAT_BOUNDS_MS.length + 1)
 * - { kind: 'delta_conn', pod, connected, failed }: 파드마다 연결을 다 맺은 뒤 한 번
 * 창 { fromMs, toMs } 안에 온전히 든 초(sec × 1000 ≥ fromMs이고 (sec + 1) × 1000 ≤ toMs)만 더한다.
 * 결과: { seconds: 더한 서로 다른 초의 수, msgsPerS, bytesPerS(초 수로 나눔, 소수 첫째 자리, 초가 0이면 0),
 *   latency: { count, p50Ms, p99Ms, over300 }(p50·p99는 누적이 그 비율에 처음 닿는 칸의 경계 ms, 마지막 칸이면 null, count가 0이면 둘 다 null.
 *   over300은 300ms 칸 위의 수), opened, closed, errors(창 안 합), connected·failed(delta_conn 합) }.
 * 모르는 kind, lat 길이가 틀림, 음수·정수가 아닌 수, toMs ≤ fromMs는 RangeError
 * @param {any[]} lines
 * @param {{ fromMs: number, toMs: number }} w
 */
export function deltaSummary(lines, w) {
  if (!isObj(w) || !Number.isFinite(w.fromMs) || !Number.isFinite(w.toMs) || w.toMs <= w.fromMs) throw new RangeError('창은 fromMs < toMs여야 한다');
  if (!Array.isArray(lines)) throw new RangeError('줄 목록이 아니다');
  const nb = LAT_BOUNDS_MS.length + 1;
  const lat = new Array(nb).fill(0);
  const secs = new Set();
  let msgs = 0;
  let bytes = 0;
  let opened = 0;
  let closed = 0;
  let errors = 0;
  let connected = 0;
  let failed = 0;
  for (const l of lines) {
    if (!isObj(l)) throw new RangeError('줄이 객체가 아니다');
    if (l.kind === 'delta_conn') {
      if (!isCount(l.connected) || !isCount(l.failed)) throw new RangeError('delta_conn 수는 0 이상 정수다');
      connected += l.connected;
      failed += l.failed;
      continue;
    }
    if (l.kind !== 'delta_bucket') throw new RangeError(`모르는 줄 종류: ${String(l.kind)}`);
    for (const k of ['sec', 'msgs', 'bytes', 'opened', 'closed', 'errors']) if (!isCount(l[k])) throw new RangeError(`delta_bucket ${k}는 0 이상 정수다`);
    if (!Array.isArray(l.lat) || l.lat.length !== nb || !l.lat.every(isCount)) throw new RangeError(`delta_bucket lat은 칸 ${nb}개의 0 이상 정수다`);
    if (l.sec * 1000 < w.fromMs || (l.sec + 1) * 1000 > w.toMs) continue;
    secs.add(l.sec);
    msgs += l.msgs;
    bytes += l.bytes;
    opened += l.opened;
    closed += l.closed;
    errors += l.errors;
    for (let i = 0; i < nb; i++) lat[i] += l.lat[i];
  }
  const n = lat.reduce((a, b) => a + b, 0);
  const q = (p) => {
    if (n === 0) return null;
    let acc = 0;
    for (let i = 0; i < nb; i++) {
      acc += lat[i];
      if (acc >= p * n) return i < LAT_BOUNDS_MS.length ? LAT_BOUNDS_MS[i] : null;
    }
    return null;
  };
  const i300 = LAT_BOUNDS_MS.indexOf(300);
  const s = secs.size;
  return {
    seconds: s,
    msgsPerS: s ? r1(msgs / s) : 0,
    bytesPerS: s ? r1(bytes / s) : 0,
    latency: { count: n, p50Ms: q(0.5), p99Ms: q(0.99), over300: lat.slice(i300 + 1).reduce((a, b) => a + b, 0) },
    opened,
    closed,
    errors,
    connected,
    failed,
  };
}

/**
 * 변경분 연결 측정(K4)의 무효 사유(2026-11-03 새 맥락 리뷰). 받는 파드가 끝 표시를 다 남기지 않았거나, 맺은 연결이 계획보다 적거나,
 * 맺지 못한 연결이 있거나, 본구간에 서버가 끊은 연결이 있거나(다 맺은 뒤 입구가 다시 시작하면 받은 양이 0이 된다, 2차 리뷰), 받는 파드 CPU(본구간 평균,
 * 한도 대비 %)가 cpuLimitPct를 넘으면 그 실행의 전송량·지연은 계획한 연결 수의 값이 아니다.
 * o = { done: 끝 표시 수, listeners: 받는 파드 수, connected, failed, closed: 본구간에 서버가 끊은 수(deltaSummary의 closed), connections: 계획한 연결 수,
 *   clientCpuPct: 받는 파드 CPU 최고(%) }.
 * 사유(한국어, 이 차례): `받는 파드 끝 표시 <done>/<listeners>`, `맺은 연결 <connected>/<connections>`, `맺지 못한 연결 <failed>`,
 * `서버가 끊은 연결 <closed>`, `받는 파드 CPU <pct>%(<limit>% 초과)`. 모두 0 이상 정수(CPU는 0 이상 유한한 수)가 아니면 RangeError. cpuLimitPct 기본 80
 * @param {{ done: number, listeners: number, connected: number, failed: number, closed: number, connections: number, clientCpuPct: number }} o
 * @param {number} [cpuLimitPct]
 * @returns {string[]}
 */
export function deltaJudge(o, cpuLimitPct = 80) {
  const ints = ['done', 'listeners', 'connected', 'failed', 'closed', 'connections'];
  if (o === null || typeof o !== 'object' || !ints.every((k) => Number.isSafeInteger(o[k]) && o[k] >= 0)) throw new RangeError('변경분 판정 입력은 0 이상 정수다');
  if (typeof o.clientCpuPct !== 'number' || !Number.isFinite(o.clientCpuPct) || o.clientCpuPct < 0) throw new RangeError('받는 파드 CPU는 0 이상 유한한 수다');
  const reasons = [];
  if (o.done < o.listeners) reasons.push(`받는 파드 끝 표시 ${o.done}/${o.listeners}`);
  if (o.connected < o.connections) reasons.push(`맺은 연결 ${o.connected}/${o.connections}`);
  if (o.failed > 0) reasons.push(`맺지 못한 연결 ${o.failed}`);
  if (o.closed > 0) reasons.push(`서버가 끊은 연결 ${o.closed}`);
  if (o.clientCpuPct > cpuLimitPct) reasons.push(`받는 파드 CPU ${o.clientCpuPct}%(${cpuLimitPct}% 초과)`);
  return reasons;
}
