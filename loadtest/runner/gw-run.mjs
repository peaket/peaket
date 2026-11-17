// 게이트웨이 차단 상한 측정의 실행 조립(V-T43, SR-T13 ②, 묶음 BAT-056 계획 §2 '측정 도구'). 클러스터·발생기는 deps로 받는다:
// 실제 것은 loadtest/run.mjs가 넘기고, 단위 시험은 가짜를 넘긴다(가짜 kubectl·관리 포트·부하).
//
// deps(모두 필수, 표시한 것만 빼도 된다):
//   kubectl(args: string[], o?: { input?: string }) → Promise<string>   클러스터 명령(임시 정책 적용·지우기, 파드·정책 읽기, 통계 읽기)
//   readAdmin(pod: string, path: string) → Promise<string>             프록시 관리 포트(127.0.0.1:19000)의 글(/clusters)
//   routeObject(route: string) → Record<string, any>                   생성 라우트 HTTPRoute 객체(deploy/gateways/*.routes.yaml을 읽기만 한다)
//   runLoad({ index, label, input, rate, warmS, mainS }) → Promise<{ summary, generator: { valid, reasons, dropped, cpuMeanPct?, cpuMaxPct? }, marks: { main_start, main_end }, retryAfterValues }>
//   readAccessLog(gateway: string, sinceS: number) → Promise<object[]>   프록시 접근 로그 JSON 줄
//   proxyCpuNs?(pods: string[]) → Promise<Record<string, number>>       (capacity만) 프록시 envoy 컨테이너의 누적 CPU(나노초)
//   record?(o) → Promise<void>                                           (--record) 성능 장부에 실행 하나를 남긴다
//   save(name: string, value: unknown) → void                           결과 파일(sweep.json·capacity.json·ip-limit.json)을 쓴다
//   sleep(ms) → Promise<void>, now() → number, log(m: string) → void
//   onCleanup?(fn) / offCleanup?(fn)                                     신호로 끝날 때 돌릴 정리를 실행 도구에 맡긴다
//   signal?: AbortSignal                                                 멈춤(이유 객체의 exitCode, 없으면 130)
//   inputBase: { origin, originVerify, hostNames: { <hosts 키>: 호스트 이름 }, eventId }   시나리오 입력(gw.json)의 공통 칸(접속 정보에서)
// 끝 코드: 0 실행을 마치고 결과를 씀(판정이 실패·무효여도), 1 도구 오류(부딪히는 정책, 프록시 없음, k6 실패 등), 128+신호(멈춤)
import {
  GW_NAMESPACE,
  PROXY_SELECTOR,
  STATS_PATH,
  STATS_PORT,
  SWEEP_LABEL,
  accessLogDurations,
  clusterName,
  conflictingPolicies,
  delayText,
  isOverload,
  judgeIpLimit,
  judgeSweepStep,
  limitsLoaded,
  parseClusterLimits,
  parseClusterStats,
  rateOf,
  ruleIndexFor,
  runIdOf,
  saturation,
  scenarioInput,
  statsWindow,
  streamMetrics,
  streamsFor,
  sweepChecks,
  sweepPolicy,
} from './gw.mjs';

/** 새 상한이 /clusters에 보이기를 기다리는 시간과 간격 [가정] */
export const LOAD_WAIT_MS = 90_000;
export const LOAD_POLL_MS = 2_000;
/** 통계 표본 간격 [가정] */
export const SAMPLE_MS = 2_000;

/** 멈춤 신호 */
class Stopped extends Error {
  constructor(exitCode) {
    super('멈춤 신호를 받았다');
    this.exitCode = exitCode;
  }
}
const stopIfAborted = (deps) => {
  if (deps.signal?.aborted) throw new Stopped(Number.isSafeInteger(deps.signal.reason?.exitCode) ? deps.signal.reason.exitCode : 130);
};

/** 임시 정책 지우기 명령(이름표로, 남은 것까지) */
export const SWEEP_DELETE_ARGS = Object.freeze(['-n', GW_NAMESPACE, 'delete', 'backendtrafficpolicies', '-l', `${SWEEP_LABEL}=true`, '--ignore-not-found']);

/** 그 게이트웨이의 프록시 파드 이름들(없으면 Error) */
export async function proxyPods(deps, gateway) {
  // 돌고 있고 지우는 중이 아닌 파드만(다시 띄운 직후 끝나 가는 옛 파드를 빼려고)
  const items = JSON.parse(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'pods', '-l', PROXY_SELECTOR(gateway), '-o', 'json'])).items ?? [];
  const pods = items
    .filter((p) => p?.status?.phase === 'Running' && !p?.metadata?.deletionTimestamp)
    .map((p) => p.metadata.name)
    .sort();
  if (!pods.length) throw new Error(`${gateway} 프록시 파드가 없다. 먼저 node tools/local/cluster.mjs gateways`);
  return pods;
}

/** 그 게이트웨이 프록시 Service의 클러스터 안 주소 */
async function serviceIp(deps, gateway) {
  const ip = String(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'svc', '-l', PROXY_SELECTOR(gateway), '-o', 'jsonpath={.items[0].spec.clusterIP}'])).trim();
  if (!/^[0-9a-f.:]+$/i.test(ip)) throw new Error(`${gateway} 프록시 Service 주소를 읽지 못했다: ${ip}`);
  return ip;
}

/** 프록시 파드마다 통계를 읽어 그 묶음 값({ <파드>: parseClusterStats 결과 }). 하나라도 못 읽으면 Error */
async function statsSample(deps, pods, cluster) {
  const out = {};
  for (const p of pods) out[p] = parseClusterStats(await deps.kubectl(['get', '--raw', `/api/v1/namespaces/${GW_NAMESPACE}/pods/${p}:${STATS_PORT}/proxy${STATS_PATH}`]), cluster);
  return out;
}

/**
 * 새 상한이 모든 프록시 파드의 /clusters에 보일 때까지 기다린다. 보이면 { loaded: true, limits }, 시간이 넘으면 { loaded: false, last }(그 단계는 부하를 넣지 않는다)
 */
export async function waitLimits(deps, pods, cluster, step, { timeoutMs = LOAD_WAIT_MS, pollMs = LOAD_POLL_MS } = {}) {
  const until = deps.now() + timeoutMs;
  let last;
  for (;;) {
    stopIfAborted(deps);
    let all = true;
    for (const p of pods) {
      try {
        last = parseClusterLimits(await deps.readAdmin(p, '/clusters'), cluster);
      } catch (e) {
        last = { error: e.message };
      }
      if (!limitsLoaded(last, step)) all = false;
    }
    if (all) return { loaded: true, limits: last };
    if (deps.now() >= until) return { loaded: false, last };
    await deps.sleep(pollMs);
  }
}

/**
 * 부하를 넣는 동안 통계 표본을 모은다: 시작 전 하나, 부하 동안 SAMPLE_MS마다, 끝난 뒤 하나. 표본을 못 읽으면 그 오류를 남기고 계속한다
 * @returns {Promise<{ load: Awaited<ReturnType<deps['runLoad']>>, samples: object[], cpu: object[], errors: string[] }>}
 */
async function loadWithSamples(deps, pods, cluster, loadArgs, { cpu = false } = {}) {
  const samples = [];
  const cpuSamples = [];
  const errors = [];
  const take = async () => {
    const atMs = deps.now();
    if (cluster) {
      try {
        samples.push({ atMs, pods: await statsSample(deps, pods, cluster) });
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (cpu) {
      try {
        cpuSamples.push({ atMs, ns: await deps.proxyCpuNs(pods) });
      } catch (e) {
        errors.push(`프록시 CPU: ${e.message}`);
      }
    }
  };
  await take();
  let done = false;
  const loadP = deps.runLoad(loadArgs).finally(() => {
    done = true;
  });
  const loop = (async () => {
    while (!done) {
      await deps.sleep(SAMPLE_MS);
      if (!done) await take();
    }
  })();
  let load;
  try {
    load = await loadP;
  } finally {
    await loop;
  }
  await take();
  return { load, samples, cpu: cpuSamples, errors };
}

/** 표본으로 본구간의 프록시 CPU 사용률(한도 대비 %) */
export function proxyCpuPct(cpuSamples, fromMs, toMs, proxyCpus) {
  const list = [...cpuSamples].sort((a, b) => a.atMs - b.atMs);
  const before = list.filter((s) => s.atMs <= fromMs).pop();
  const after = list.find((s) => s.atMs >= toMs);
  if (!before || !after || after.atMs <= before.atMs) throw new Error('본구간 앞뒤의 프록시 CPU 표본이 없다');
  let ns = 0;
  for (const [p, v] of Object.entries(after.ns)) {
    if (before.ns[p] === undefined) throw new Error('본구간 앞뒤의 프록시 파드가 다르다');
    ns += v - before.ns[p];
  }
  const pods = Object.keys(after.ns).length;
  return Math.round((ns / 1e9 / ((after.atMs - before.atMs) / 1000) / (proxyCpus * pods)) * 1000) / 10;
}

const pathOnly = (p) => p.split('?')[0];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 흐름 경로 틀({id})에 맞는 접근 로그 경로 정규식(쿼리는 뺀다. 접근 로그 path는 쿼리 없는 경로다) */
export const pathPattern = (p) => new RegExp(`^${pathOnly(p).split('{id}').map(escapeRe).join('[^/]+')}$`);

/** 성능 장부 notes 한 줄 */
const notesOf = (parts) => parts.filter(Boolean).join('; ');

/**
 * gw 명령을 돌린다. a는 parseGwArgs의 결과. 결과 파일을 deps.save로 쓰고 { exitCode }를 돌려준다.
 * 임시 정책과 CPU 묶음은 정상 끝·오류·멈춤 모두에서 되돌린다(정리는 deps.onCleanup에도 맡겨 신호로 끝나도 돈다)
 */
export async function runGw(a, deps) {
  const restores = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const fn of restores.reverse()) {
      try {
        await fn();
      } catch (e) {
        deps.log(`정리 실패(손으로 되돌린다: node loadtest/run.mjs cleanup): ${e.message}`);
      }
    }
  };
  deps.onCleanup?.(cleanup);
  try {
    if (a.sub === 'sweep') return await sweep(a, deps, restores);
    if (a.sub === 'capacity') return await capacity(a, deps, restores);
    return await ipLimit(a, deps);
  } catch (e) {
    if (e instanceof Stopped) {
      deps.log(e.message);
      return { exitCode: e.exitCode };
    }
    throw e;
  } finally {
    await cleanup();
    deps.offCleanup?.(cleanup);
  }
}

/** 재는 라우트의 규칙 묶음 이름(재는 흐름의 메서드·경로로 규칙을 찾는다) */
function targetCluster(a, deps, target) {
  return clusterName(a.route, ruleIndexFor(deps.routeObject(a.route), target.method, pathOnly(target.path.replaceAll('{id}', 'x'))));
}

async function commonInputs(deps, streams) {
  const ips = {};
  for (const g of new Set(streams.map((s) => s.gateway))) ips[g] = await serviceIp(deps, g);
  return ips;
}

async function sweep(a, deps, restores) {
  const streams = streamsFor(a);
  const target = streams.find((s) => s.target);
  // 같은 라우트를 겨눈 정책이 있으면 임시 정책이 버려지거나 운영 정책이 빠진다(그 라우트로는 재지 않는다)
  const items = JSON.parse(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'backendtrafficpolicies', '-o', 'json'])).items ?? [];
  const conflicts = conflictingPolicies(items, a.route);
  if (conflicts.length) throw new Error(`${a.route}를 겨눈 정책이 이미 있다(${conflicts.join(', ')}). 임시 정책과 부딪혀 스윕 값이 실리지 않는다`);
  const cluster = targetCluster(a, deps, target);
  const pods = await proxyPods(deps, a.gateway);
  const serviceIps = await commonInputs(deps, streams);
  restores.push(() => deps.kubectl([...SWEEP_DELETE_ARGS]));
  const result = { command: 'gw sweep', gateway: a.gateway, route: a.route, cluster, proxyPods: pods, rate: a.rate, mix: a.mix, delay: delayText(a.delay), warmS: a.warmS, mainS: a.mainS, steps: [] };
  const save = () => deps.save('sweep.json', result);
  for (const step of a.steps) {
    stopIfAborted(deps);
    const label = `p${step.maxParallelRequests}-q${step.maxPendingRequests}-c${step.maxConnections}-r${step.repeat}`;
    deps.log(`단계 ${step.index + 1}/${a.steps.length}: 동시 ${step.maxParallelRequests}·보류 ${step.maxPendingRequests}·연결 ${step.maxConnections}, 도착률 ${step.rate}/s, 지연 ${delayText(step.delay)}`);
    const base = { step: step.index, maxConnections: step.maxConnections, maxParallelRequests: step.maxParallelRequests, maxPendingRequests: step.maxPendingRequests, rate: step.rate, delay: delayText(step.delay), mix: step.mix, repeat: step.repeat };
    await deps.kubectl(['apply', '-f', '-'], { input: JSON.stringify(sweepPolicy({ route: a.route, ...step })) });
    const w = await waitLimits(deps, pods, cluster, step);
    const overload = isOverload(step, rateOf(target, step.rate));
    if (!w.loaded) {
      const j = judgeSweepStep({ step, overload, limitsLoaded: false });
      result.steps.push({ ...base, overload, sent: 0, valid: false, invalid_reason: j.invalid_reason, verdict: j.verdict, item: j.item, reasons: j.reasons, clustersSeen: w.last ?? null });
      save();
      deps.log(`  무효: ${j.invalid_reason}(본 값 ${JSON.stringify(w.last ?? null)})`);
      continue;
    }
    const input = scenarioInput({ ...deps.inputBase, streams, rate: step.rate, delay: step.delay, serviceIps, memoryMi: a.memoryMi, generators: a.generators });
    const r = await loadWithSamples(deps, pods, cluster, { index: step.index, label, input, rate: step.rate, warmS: a.warmS, mainS: a.mainS });
    stopIfAborted(deps);
    const { marks } = r.load;
    let stats = null;
    let statsError = null;
    try {
      stats = statsWindow(r.samples, marks.main_start, marks.main_end);
    } catch (e) {
      statsError = [e.message, ...r.errors].join('; ');
    }
    let m = null;
    try {
      m = streamMetrics(r.load.summary, target.name);
    } catch (e) {
      // m이 없으면 판정이 '보낸 요청 0건'으로 무효다
      deps.log(`  요약을 읽지 못함: ${e.message}`);
    }
    let accessLog = null;
    try {
      const lines = await deps.readAccessLog(a.gateway, Math.ceil((deps.now() - marks.main_start) / 1000) + 30);
      accessLog = accessLogDurations(lines, { fromMs: marks.main_start, toMs: marks.main_end, status: '503', pathRe: pathPattern(target.path) });
    } catch (e) {
      deps.log(`  접근 로그를 읽지 못함: ${e.message}`);
    }
    const j = judgeSweepStep({ step, overload, limitsLoaded: true, statsError, stats, m, generator: r.load.generator, accessLog });
    const ra = r.load.retryAfterValues ?? {};
    const row = {
      ...base,
      overload,
      sent: m?.sent ?? 0,
      status: m?.status ?? null,
      overflow: stats?.overflow ?? null,
      rqActiveMax: stats?.rqActiveMax ?? null,
      rqPendingActiveMax: stats?.rqPendingActiveMax ?? null,
      latency: m ? { '2xx': m.latency['2xx'], 503: m.latency['503'] } : null,
      retryAfter: m ? { present: m.retryAfter['503'].num + m.retryAfter['503'].nonnum, missing: m.retryAfter['503'].missing, nonNumeric: m.retryAfter['503'].nonnum, values: [...(ra['503'] ?? [])].sort() } : null,
      problemOk: m?.problem['503'].ok ?? null,
      problemBad: m?.problem['503'].bad ?? null,
      accessLog503: accessLog,
      generator: { cpuMeanPct: r.load.generator?.cpuMeanPct ?? null, cpuMaxPct: r.load.generator?.cpuMaxPct ?? null, dropped_iterations: r.load.generator?.dropped ?? null },
      valid: j.valid,
      invalid_reason: j.invalid_reason,
      verdict: j.verdict,
      item: j.item,
      reasons: j.reasons,
      marks,
    };
    result.steps.push(row);
    save();
    deps.log(`  ${j.item} ${j.verdict}${j.reasons.length ? `: ${j.reasons.join('; ')}` : ''}`);
    if (a.record && m) {
      await deps.record({
        index: step.index,
        runId: runIdOf(a.runIdPrefix, 'sweep', `${String(step.index + 1).padStart(2, '0')}-${label}`),
        kpi: 'NFR-001',
        rps: step.rate,
        scenario: `loadtest/scenarios/gw.js gw sweep ${a.gateway}/${a.route} maxConnections=${step.maxConnections} maxParallelRequests=${step.maxParallelRequests} maxPendingRequests=${step.maxPendingRequests} delay=${delayText(step.delay)} rate=${step.rate}/s mix=${step.mix}`,
        notes: notesOf([`게이트웨이 차단 상한 스윕(local-gw, V-T43, docs/infra.md §4.1): ${j.item} ${j.verdict}${j.reasons.length ? `(${j.reasons.join('; ')})` : ''}`, `프록시 ${a.gateway} 파드 ${pods.length}개`, `묶음 ${cluster}`, stats ? `넘침 ${stats.overflowTotal}, 처리 중 최대 ${stats.rqActiveMax}, 보류 최대 ${stats.rqPendingActiveMax}` : null]),
        checks: sweepChecks(target.name, overload, m),
        ...(j.valid ? {} : { invalidReason: j.invalid_reason }),
        marks,
      });
    }
  }
  return { exitCode: 0, result };
}

/** EnvoyProxy를 CPU·일꾼 수로 묶는 병합 패치와 되돌리는 패치(원래 칸이 없으면 null로 지운다) */
export function envoyProxyPatches(original, cpus) {
  const spec = original?.spec ?? {};
  const container = spec.provider?.kubernetes?.envoyDeployment?.container ?? {};
  const milli = `${Math.round(cpus * 1000)}m`;
  const bind = { spec: { concurrency: Math.max(1, Math.floor(cpus)), provider: { kubernetes: { envoyDeployment: { container: { resources: { requests: { cpu: milli }, limits: { cpu: milli } } } } } } } };
  const restore = {
    spec: {
      concurrency: spec.concurrency === undefined ? null : spec.concurrency,
      provider: { kubernetes: { envoyDeployment: { container: { resources: container.resources === undefined ? null : { requests: container.resources.requests ?? null, limits: container.resources.limits ?? null } } } } },
    },
  };
  return { bind, restore };
}

/** EnvoyProxy를 고친 뒤 컨트롤러가 프록시 Deployment를 고칠 시간 [가정] */
export const PATCH_SETTLE_MS = 10_000;

async function rollout(deps, gateway) {
  await deps.sleep(PATCH_SETTLE_MS);
  const name = String(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'deploy', '-l', PROXY_SELECTOR(gateway), '-o', 'jsonpath={.items[0].metadata.name}'])).trim();
  if (!name) throw new Error(`${gateway} 프록시 Deployment가 없다`);
  await deps.kubectl(['-n', GW_NAMESPACE, 'rollout', 'status', `deploy/${name}`, '--timeout=300s']);
}

async function capacity(a, deps, restores) {
  const streams = streamsFor({ ...a, mix: 'single' });
  const target = streams[0];
  const gwObj = JSON.parse(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'gateway', a.gateway, '-o', 'json']));
  const ep = gwObj?.spec?.infrastructure?.parametersRef?.name;
  if (!ep) throw new Error(`${a.gateway}의 EnvoyProxy(infrastructure.parametersRef)를 모른다`);
  const original = JSON.parse(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'envoyproxy', ep, '-o', 'json']));
  const { bind, restore } = envoyProxyPatches(original, a.proxyCpus);
  restores.push(async () => {
    await deps.kubectl(['-n', GW_NAMESPACE, 'patch', 'envoyproxy', ep, '--type', 'merge', '-p', JSON.stringify(restore)]);
    await rollout(deps, a.gateway);
  });
  deps.log(`프록시 ${a.gateway}(EnvoyProxy ${ep})를 CPU ${a.proxyCpus}·일꾼 ${bind.spec.concurrency}로 묶는다`);
  await deps.kubectl(['-n', GW_NAMESPACE, 'patch', 'envoyproxy', ep, '--type', 'merge', '-p', JSON.stringify(bind)]);
  await rollout(deps, a.gateway);
  const pods = await proxyPods(deps, a.gateway);
  const serviceIps = await commonInputs(deps, streams);
  const result = { command: 'gw capacity', gateway: a.gateway, route: a.route, proxyCpus: a.proxyCpus, concurrency: bind.spec.concurrency, proxyPods: pods, delay: delayText(a.delay), warmS: a.warmS, mainS: a.mainS, steps: [], saturation: null };
  const save = () => deps.save('capacity.json', result);
  for (const [i, rate] of a.rates.entries()) {
    stopIfAborted(deps);
    deps.log(`단계 ${i + 1}/${a.rates.length}: 도착률 ${rate}/s, 지연 ${delayText(a.delay)}`);
    const input = scenarioInput({ ...deps.inputBase, streams, rate, delay: a.delay, serviceIps, memoryMi: a.memoryMi, generators: a.generators });
    const r = await loadWithSamples(deps, pods, null, { index: i, label: `r${rate}`, input, rate, warmS: a.warmS, mainS: a.mainS }, { cpu: true });
    stopIfAborted(deps);
    const { marks } = r.load;
    const reasons = [];
    let m = null;
    try {
      m = streamMetrics(r.load.summary, target.name);
    } catch (e) {
      reasons.push(e.message);
    }
    let cpuPct = null;
    try {
      cpuPct = proxyCpuPct(r.cpu, marks.main_start, marks.main_end, a.proxyCpus);
    } catch (e) {
      reasons.push(`프록시 CPU를 못 읽음: ${e.message}`);
    }
    const g = r.load.generator ?? {};
    if (!Number.isSafeInteger(g.dropped)) reasons.push('발생기 dropped_iterations를 모름');
    else if (g.dropped >= 1) reasons.push(`발생기가 반복을 시작하지 못함(dropped_iterations ${g.dropped})`);
    if (!g.valid) reasons.push(`발생기 무효: ${(g.reasons ?? []).join('; ')}`);
    if (m && !(m.sent > 0)) reasons.push('보낸 요청 0건');
    const valid = reasons.length === 0;
    const row = { step: i, rate, sent: m?.sent ?? 0, status: m?.status ?? null, latency: m ? { '2xx': m.latency['2xx'], 503: m.latency['503'] } : null, p99Ms: m?.latency['2xx'].p99 ?? null, proxyCpuPct: cpuPct, generator: { cpuMeanPct: g.cpuMeanPct ?? null, dropped_iterations: g.dropped ?? null }, valid, invalid_reason: valid ? null : reasons.join('; '), marks };
    result.steps.push(row);
    result.saturation = saturation(result.steps, a.proxyCpus, a.delay.ms);
    save();
    deps.log(`  p99 ${row.p99Ms}ms, 프록시 CPU ${cpuPct}%${valid ? '' : `, 무효: ${row.invalid_reason}`}`);
    if (a.record && m) {
      await deps.record({
        index: i,
        runId: runIdOf(a.runIdPrefix, 'capacity', `${String(i + 1).padStart(2, '0')}-r${rate}`),
        kpi: 'NFR-001',
        rps: rate,
        scenario: `loadtest/scenarios/gw.js gw capacity ${a.gateway}/${a.route} proxyCpus=${a.proxyCpus} concurrency=${bind.spec.concurrency} delay=${delayText(a.delay)} rate=${rate}/s`,
        notes: notesOf([`게이트웨이 프록시 포화 처리량(local-gw, V-T43 '값의 식'의 파드 포화 처리량, 계획 docs/review/plans/BAT-056.md §5 M1)`, `프록시 ${a.gateway} 파드 ${pods.length}개 CPU ${a.proxyCpus}·일꾼 ${bind.spec.concurrency}`, `프록시 CPU ${cpuPct}%`]),
        ...(valid ? {} : { invalidReason: row.invalid_reason }),
        marks,
      });
    }
    if (!valid) break;
  }
  return { exitCode: 0, result };
}

async function ipLimit(a, deps) {
  const streams = streamsFor(a);
  const pods = await proxyPods(deps, 'gw-fan');
  const serviceIps = await commonInputs(deps, streams);
  const input = scenarioInput({ ...deps.inputBase, streams, rate: a.rate, delay: { kind: 'normal' }, serviceIps, memoryMi: a.memoryMi, generators: a.generators });
  stopIfAborted(deps);
  deps.log(`SR-T13 ② 경우 ${a.case}: ${streams.map((s) => `${s.name} ${rateOf(s, a.rate)}/s(${s.ip.kind}${s.ip.count ? ` ${s.ip.count}개` : ''})`).join(', ')}, 프록시 복제 ${pods.length}`);
  const load = await deps.runLoad({ index: 0, label: a.case, input, rate: a.rate + (a.singleRate ?? 0), warmS: a.warmS, mainS: a.mainS });
  stopIfAborted(deps);
  const ms = {};
  const reasons = [];
  for (const s of streams) {
    try {
      ms[s.name] = streamMetrics(load.summary, s.name);
    } catch (e) {
      reasons.push(e.message);
    }
  }
  const j = reasons.length ? { verdict: 'invalid', valid: false, invalid_reason: reasons.join('; '), reasons } : judgeIpLimit({ case: a.case, mainS: a.mainS, replicas: pods.length, streams: ms, generator: load.generator });
  const result = {
    command: 'gw ip-limit',
    case: a.case,
    replicas: pods.length,
    warmS: a.warmS,
    mainS: a.mainS,
    streams: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, { sent: v.sent, status: v.status, retryAfter429: v.retryAfter['429'], problem429: v.problem['429'], latency429: v.latency['429'] }])),
    retryAfterValues: [...(load.retryAfterValues?.['429'] ?? [])].sort(),
    generator: { cpuMeanPct: load.generator?.cpuMeanPct ?? null, dropped_iterations: load.generator?.dropped ?? null },
    cap: j.cap ?? null,
    valid: j.valid,
    invalid_reason: j.invalid_reason,
    verdict: j.verdict,
    item: 'SR-T13 ②',
    reasons: j.reasons,
    marks: load.marks,
  };
  deps.save('ip-limit.json', result);
  deps.log(`SR-T13 ② ${a.case}: ${j.verdict}${j.reasons.length ? `(${j.reasons.join('; ')})` : ''}`);
  if (a.record) {
    await deps.record({
      index: 0,
      runId: runIdOf(a.runIdPrefix, 'ip-limit', a.case),
      kpi: 'NFR-028',
      rps: a.rate + (a.singleRate ?? 0),
      scenario: `loadtest/scenarios/gw.js gw ip-limit case=${a.case} ${streams.map((s) => `${s.name}=${rateOf(s, a.rate)}/s`).join(' ')}`,
      notes: notesOf([`검색 IP 한도(local-gw, SR-T13 ②, docs/features/search.md §12 '측정 판정'): ${j.verdict}${j.reasons.length ? `(${j.reasons.join('; ')})` : ''}`, `프록시 gw-fan 복제 ${pods.length}`, j.cap ? `한 IP 통과 상한 ${j.cap}` : null]),
      ...(j.valid ? {} : { invalidReason: j.invalid_reason }),
      marks: load.marks,
    });
  }
  return { exitCode: 0, result };
}
