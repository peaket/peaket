// 같은 PC에서 잴 때 점마다 남기는 호스트 지표(docs/verification.md §3.5 6번·8번, docs/perf-ledger.md §2.2 `host` 칸, BUILD_ORDER MSR-020).
// - 순수 함수: /proc/stat·cgroup v2 cpu.stat·/proc/net/netstat 글을 수로 바꾼다. 칸이 없으면 그 값은 null이고 reason에 까닭을 적는다(0으로 바꾸지 않는다).
// - 읽기 함수(hostSnapshot): kind 노드의 /proc/stat과 파드마다의 cpu.stat·netstat를 읽는다. 실제로 읽는 함수(노드·파드 글 읽기)는 부르는 쪽이 넘긴다.
// 판정(호스트 포화·코어 혼합 표시)은 loadtest/runner/entry-scale.mjs hostTags가 한다.

const CPU_FIELDS = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const textOf = (t) => (typeof t === 'string' ? t : '');

/**
 * /proc/stat 글 → { cpu: { user, nice, system, idle, iowait, irq, softirq, steal }(jiffies), logicalCpus(cpuN 줄 수), procsRunning, procsBlocked }.
 * 'cpu ' 줄의 앞 여덟 칸(guest·guest_nice는 user·nice에 이미 들어 있어 뺀다)을 읽는다. 없는 칸은 null이다.
 * 하나라도 null이면 reason(빠진 칸 이름)을 더한다. 글이 아니면 빈 글로 본다
 * @param {string} text
 * @returns {{ cpu: Record<string, number|null> | null, logicalCpus: number | null, procsRunning: number | null, procsBlocked: number | null, reason?: string }}
 */
export function parseProcStat(text) {
  const lines = textOf(text).split('\n').map((l) => l.trim());
  const missing = [];
  let cpu = null;
  const agg = lines.find((l) => /^cpu\s/.test(l));
  if (agg) {
    const parts = agg.split(/\s+/).slice(1);
    cpu = {};
    CPU_FIELDS.forEach((f, i) => {
      const v = parts[i] !== undefined && /^\d+$/.test(parts[i]) ? Number(parts[i]) : null;
      cpu[f] = v;
      if (v === null) missing.push(`cpu.${f}`);
    });
  } else missing.push('cpu');
  const logical = lines.filter((l) => /^cpu\d+\s/.test(l)).length;
  const one = (name) => {
    const m = new RegExp(`^${name}\\s+(\\d+)$`).exec(lines.find((l) => l.startsWith(`${name} `)) ?? '');
    if (!m) missing.push(name);
    return m ? Number(m[1]) : null;
  };
  const procsRunning = one('procs_running');
  const procsBlocked = one('procs_blocked');
  if (logical === 0) missing.push('cpuN');
  const out = { cpu, logicalCpus: logical > 0 ? logical : null, procsRunning, procsBlocked };
  return missing.length ? { ...out, reason: `/proc/stat에 없는 칸: ${missing.join(', ')}` } : out;
}

/**
 * 두 /proc/stat 표본(parseProcStat 결과) 사이의 호스트 전체 CPU 사용률(%, 0~100, 반올림하지 않는다) = (Δ전체 − Δ쉼) ÷ Δ전체 × 100.
 * 쉼은 idle + iowait, 전체는 CPU_FIELDS의 합이다. 칸이 없거나 Δ전체가 0(흐른 시간 없음)이면 null, 어느 칸이 줄었으면(표본 순서가 뒤바뀜·다른 부팅) RangeError
 * @param {ReturnType<typeof parseProcStat>} a
 * @param {ReturnType<typeof parseProcStat>} b
 * @returns {number | null}
 */
export function cpuUtilBetween(a, b) {
  if (!a?.cpu || !b?.cpu) return null;
  if (!CPU_FIELDS.every((f) => isCount(a.cpu[f]) && isCount(b.cpu[f]))) return null;
  if (CPU_FIELDS.some((f) => b.cpu[f] < a.cpu[f])) throw new RangeError('/proc/stat 표본의 CPU 칸이 줄었다(표본 순서가 뒤바뀌었거나 다시 부팅했다)');
  const total = CPU_FIELDS.reduce((s, f) => s + (b.cpu[f] - a.cpu[f]), 0);
  if (!(total > 0)) return null;
  const idle = b.cpu.idle - a.cpu.idle + (b.cpu.iowait - a.cpu.iowait);
  // 100을 먼저 곱해 85% 같은 문턱 값이 소수 오차 없이 나오게 한다
  return ((total - idle) * 100) / total;
}

const CPU_STAT_KEYS = { usage_usec: 'usageUsec', nr_periods: 'nrPeriods', nr_throttled: 'nrThrottled', throttled_usec: 'throttledUsec' };

/**
 * cgroup v2 cpu.stat 글 → { usageUsec, nrPeriods, nrThrottled, throttledUsec }. 없는 칸(cgroup v1은 usage_usec·throttled_usec가 없다,
 * CPU 한도가 없는 cgroup은 nr_periods 줄이 없다)은 null이고 reason에 빠진 칸 이름을 적는다
 * @param {string} text
 * @returns {{ usageUsec: number|null, nrPeriods: number|null, nrThrottled: number|null, throttledUsec: number|null, reason?: string }}
 */
export function parseCpuStat(text) {
  const out = { usageUsec: null, nrPeriods: null, nrThrottled: null, throttledUsec: null };
  for (const raw of textOf(text).split('\n')) {
    const m = /^([a-z_]+)\s+(\d+)$/.exec(raw.trim());
    if (m && Object.hasOwn(CPU_STAT_KEYS, m[1])) out[CPU_STAT_KEYS[m[1]]] = Number(m[2]);
  }
  const missing = Object.entries(CPU_STAT_KEYS).filter(([, k]) => out[k] === null).map(([name]) => name);
  return missing.length ? { ...out, reason: `cgroup v2 cpu.stat에 없는 칸: ${missing.join(', ')}` } : out;
}

/**
 * /proc/net/netstat(또는 /proc/<pid>/net/netstat) 글 → { listenOverflows, listenDrops }(TcpExt 이름 줄과 값 줄의 짝에서 읽는다).
 * TcpExt 줄이 없거나 그 칸이 없으면 null이고 reason을 적는다
 * @param {string} text
 * @returns {{ listenOverflows: number|null, listenDrops: number|null, reason?: string }}
 */
export function parseNetstat(text) {
  const lines = textOf(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines.findIndex((l) => l.startsWith('TcpExt:') && /[A-Za-z]/.test(l.slice(7).trim().split(/\s+/)[0] ?? ''));
  const values = head >= 0 ? lines[head + 1] : undefined;
  if (head < 0 || !values?.startsWith('TcpExt:')) return { listenOverflows: null, listenDrops: null, reason: 'netstat에 TcpExt 줄이 없다' };
  const names = lines[head].split(/\s+/).slice(1);
  const nums = values.split(/\s+/).slice(1);
  const read = (name) => {
    const i = names.indexOf(name);
    return i >= 0 && /^\d+$/.test(nums[i] ?? '') ? Number(nums[i]) : null;
  };
  const out = { listenOverflows: read('ListenOverflows'), listenDrops: read('ListenDrops') };
  const missing = [out.listenOverflows === null ? 'ListenOverflows' : '', out.listenDrops === null ? 'ListenDrops' : ''].filter(Boolean);
  return missing.length ? { ...out, reason: `TcpExt에 없는 칸: ${missing.join(', ')}` } : out;
}

/**
 * 호스트 표본 하나: kind 노드의 /proc/stat과 파드마다의 cpu.stat, netstat를 읽는 파드는 netstat도 읽는다. 읽기 실패는 errors에 남기고 그 값은 null이다(삼키지 않는다).
 * deps = { nodeText(path) → Promise<string>(노드 컨테이너 안 파일), podText(namespace, pod, path) → Promise<string>(파드 컨테이너 안 파일), now?() → ms }.
 * targets = [{ namespace, pod, role, cpus, netstat?: boolean }](role은 bundle·valkey·generator 같은 무리 이름, cpus는 그 파드에 준 CPU 몫)
 * @param {{ nodeText: (path: string) => Promise<string>, podText: (ns: string, pod: string, path: string) => Promise<string>, now?: () => number }} deps
 * @param {Array<{ namespace: string, pod: string, role: string, cpus: number, netstat?: boolean }>} targets
 */
export async function hostSnapshot(deps, targets) {
  const errors = [];
  const atMs = (deps.now ?? Date.now)();
  let procStat = null;
  try {
    procStat = parseProcStat(await deps.nodeText('/proc/stat'));
  } catch (e) {
    errors.push(`노드 /proc/stat: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`);
  }
  const pods = [];
  for (const t of targets) {
    const row = { namespace: t.namespace, pod: t.pod, role: t.role, cpus: t.cpus, wantNetstat: Boolean(t.netstat), cpuStat: null, netstat: null };
    try {
      row.cpuStat = parseCpuStat(await deps.podText(t.namespace, t.pod, '/sys/fs/cgroup/cpu.stat'));
    } catch (e) {
      errors.push(`${t.pod} cpu.stat: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`);
    }
    if (t.netstat) {
      try {
        row.netstat = parseNetstat(await deps.podText(t.namespace, t.pod, '/proc/net/netstat'));
      } catch (e) {
        errors.push(`${t.pod} netstat: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`);
      }
    }
    pods.push(row);
  }
  return { atMs, procStat, pods, errors };
}

const delta = (a, b) => (isCount(a) && isCount(b) && b >= a ? b - a : null);

/**
 * 두 표본(hostSnapshot 결과, 본구간 시작·끝) → 장부 `host` 칸의 재료(표시는 붙이지 않는다, entry-scale.mjs hostTags가 붙인다):
 * { cpuUtil(%), procsRunning(두 표본 가운데 큰 값), logicalCpus, throttle: { <role>: { ratio, nrThrottled, nrPeriods, throttledUsec, pods } },
 *   cpuAssigned(파드에 준 CPU 몫의 합), kernel: { listenOverflows, listenDrops }(netstat를 읽은 파드의 차이 합), errors }.
 * 한 파드라도 값을 못 읽으면 그 무리·카운터는 null이다(일부만 더해 작게 보이지 않게). ratio = Δnr_throttled ÷ Δnr_periods(Δnr_periods가 0이면 0, CPU 한도가 없으면 null)
 * @param {Awaited<ReturnType<typeof hostSnapshot>>} a
 * @param {Awaited<ReturnType<typeof hostSnapshot>>} b
 */
export function hostBetween(a, b) {
  const errors = [...(a?.errors ?? []), ...(b?.errors ?? [])];
  let cpuUtil = null;
  try {
    cpuUtil = cpuUtilBetween(a?.procStat, b?.procStat);
  } catch (e) {
    errors.push(`호스트 CPU: ${e.message}`);
  }
  const pr = [a?.procStat?.procsRunning, b?.procStat?.procsRunning];
  const procsRunning = pr.every(isCount) ? Math.max(...pr) : null;
  const logicalCpus = b?.procStat?.logicalCpus ?? a?.procStat?.logicalCpus ?? null;
  const throttle = {};
  const kernel = { listenOverflows: 0, listenDrops: 0 };
  let kernelSeen = 0;
  let cpuAssigned = 0;
  for (const pb of b?.pods ?? []) {
    const pa = (a?.pods ?? []).find((p) => p.pod === pb.pod && p.namespace === pb.namespace);
    cpuAssigned += Number.isFinite(pb.cpus) ? pb.cpus : 0;
    const t = (throttle[pb.role] ??= { ratio: null, nrThrottled: 0, nrPeriods: 0, throttledUsec: 0, pods: 0, missing: 0 });
    const dn = delta(pa?.cpuStat?.nrThrottled, pb.cpuStat?.nrThrottled);
    const dp = delta(pa?.cpuStat?.nrPeriods, pb.cpuStat?.nrPeriods);
    const du = delta(pa?.cpuStat?.throttledUsec, pb.cpuStat?.throttledUsec);
    if (dn === null || dp === null || du === null) t.missing += 1;
    else {
      t.nrThrottled += dn;
      t.nrPeriods += dp;
      t.throttledUsec += du;
    }
    t.pods += 1;
    if (pb.wantNetstat) {
      kernelSeen += 1;
      const o = delta(pa?.netstat?.listenOverflows, pb.netstat?.listenOverflows);
      const d = delta(pa?.netstat?.listenDrops, pb.netstat?.listenDrops);
      kernel.listenOverflows = o === null || kernel.listenOverflows === null ? null : kernel.listenOverflows + o;
      kernel.listenDrops = d === null || kernel.listenDrops === null ? null : kernel.listenDrops + d;
    }
  }
  for (const t of Object.values(throttle)) {
    if (t.missing > 0) Object.assign(t, { ratio: null, nrThrottled: null, nrPeriods: null, throttledUsec: null });
    else t.ratio = t.nrPeriods === 0 ? 0 : t.nrThrottled / t.nrPeriods;
    delete t.missing;
  }
  if (kernelSeen === 0) {
    kernel.listenOverflows = null;
    kernel.listenDrops = null;
  }
  return { cpuUtil, procsRunning, logicalCpus, throttle, cpuAssigned: Math.round(cpuAssigned * 1000) / 1000, kernel, errors };
}
