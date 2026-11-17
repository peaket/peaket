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
  combineMetrics,
  isOverload,
  judgeIpLimit,
  judgeSweepStep,
  judgeSweepStreams,
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
import { collectArgs } from './results.mjs';

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

/** CPU 묶음의 원래 값을 남기는 EnvoyProxy 주석(docs/infra.md §4.1 '측정(V-T43)', 추천 적용 2026-11-18, BAT-056 R6) */
export const RESTORE_ANNOTATION = 'peaket.io/sweep-restore';

/**
 * 그 게이트웨이의 EnvoyProxy 이름: Gateway의 infrastructure.parametersRef, 없으면 GatewayClass의 parametersRef(나머지 넷이 함께 쓰는 peaket-proxy)
 */
async function envoyProxyName(deps, gateway) {
  const gwObj = JSON.parse(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'gateway', gateway, '-o', 'json']));
  const own = gwObj?.spec?.infrastructure?.parametersRef;
  if (own?.kind === 'EnvoyProxy' && own.name) return own.name;
  const cls = gwObj?.spec?.gatewayClassName;
  if (!cls) throw new Error(`${gateway}의 EnvoyProxy를 모른다(parametersRef·gatewayClassName이 없다)`);
  const gc = JSON.parse(await deps.kubectl(['get', 'gatewayclass', cls, '-o', 'json']));
  const ref = gc?.spec?.parametersRef;
  if (ref?.kind !== 'EnvoyProxy' || !ref.name) throw new Error(`${gateway}의 GatewayClass ${cls}에 EnvoyProxy parametersRef가 없다`);
  return ref.name;
}

/** EnvoyProxy 객체에서 CPU 요청·한도와 Envoy 일꾼 수(없으면 null) */
export function proxyResources(obj) {
  const spec = obj?.spec ?? {};
  const res = spec.provider?.kubernetes?.envoyDeployment?.container?.resources ?? {};
  return { envoyProxy: obj?.metadata?.name ?? null, cpuRequest: res.requests?.cpu ?? null, cpuLimit: res.limits?.cpu ?? null, concurrency: spec.concurrency ?? null };
}

/** 장부 notes에 넣을 프록시 자원 글 */
export const proxyText = (p) => `프록시 EnvoyProxy ${p.envoyProxy} CPU 요청 ${p.cpuRequest ?? '(없음)'}·한도 ${p.cpuLimit ?? '(없음)'}, 일꾼 수 ${p.concurrency ?? '기본(CPU 수)'}`;

/**
 * 그 게이트웨이 EnvoyProxy를 읽어 { name, obj, proxy }. CPU 묶음 주석(RESTORE_ANNOTATION)이 남아 있으면(강제 종료로 되돌리지 못한 capacity) 재지 않고 멈춘다(R6)
 */
async function readProxy(deps, gateway) {
  const name = await envoyProxyName(deps, gateway);
  const obj = JSON.parse(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'envoyproxy', name, '-o', 'json']));
  if (obj?.metadata?.annotations?.[RESTORE_ANNOTATION] !== undefined)
    throw new Error(`EnvoyProxy ${name}에 CPU 묶음 주석 ${RESTORE_ANNOTATION}이 남아 있다(앞 capacity가 되돌리지 못하고 끝났다). node loadtest/run.mjs cleanup으로 되돌린 뒤 다시 돌린다`);
  return { name, obj, proxy: proxyResources(obj) };
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

/** 요약에서 흐름마다의 값(못 읽은 흐름은 빠지고 까닭을 남긴다) */
function metricsOf(summary, names, log) {
  const out = {};
  for (const n of names) {
    try {
      out[n] = streamMetrics(summary, n);
    } catch (e) {
      log(`  요약을 읽지 못함: ${e.message}`);
    }
  }
  return out;
}

/** 장부 notes의 건수 글: 보낸 수와 상태별 수 */
const countText = (m) => `보낸 ${m.sent}(2xx ${m.status['2xx']}·503 ${m.status['503']}·429 ${m.status['429']}·그 밖 ${m.status.other})`;

async function sweep(a, deps, restores) {
  const streams = streamsFor(a);
  const targets = streams.filter((s) => s.target);
  const px0 = await readProxy(deps, a.gateway);
  // 같은 라우트를 겨눈 정책이 있으면 임시 정책이 버려지거나 운영 정책이 빠진다(그 라우트로는 재지 않는다)
  const items = JSON.parse(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'backendtrafficpolicies', '-o', 'json'])).items ?? [];
  const conflicts = conflictingPolicies(items, a.route);
  if (conflicts.length) throw new Error(`${a.route}를 겨눈 정책이 이미 있다(${conflicts.join(', ')}). 임시 정책과 부딪혀 스윕 값이 실리지 않는다`);
  const clusters = [...new Set(targets.map((t) => targetCluster(a, deps, t)))];
  if (clusters.length !== 1) throw new Error(`재는 흐름들(${targets.map((t) => t.name).join('·')})이 서로 다른 규칙 묶음(${clusters.join(', ')})에 있다`);
  const cluster = clusters[0];
  const pods = await proxyPods(deps, a.gateway);
  const serviceIps = await commonInputs(deps, streams);
  restores.push(() => deps.kubectl([...SWEEP_DELETE_ARGS]));
  const result = { command: 'gw sweep', gateway: a.gateway, route: a.route, cluster, targets: targets.map((t) => t.name), proxyPods: pods, proxy: px0.proxy, rate: a.rate, mix: a.mix, delay: delayText(a.delay), warmS: a.warmS, mainS: a.mainS, steps: [] };
  const save = () => deps.save('sweep.json', result);
  for (const step of a.steps) {
    stopIfAborted(deps);
    const label = `p${step.maxParallelRequests}-q${step.maxPendingRequests}-c${step.maxConnections}-r${step.repeat}`;
    deps.log(`단계 ${step.index + 1}/${a.steps.length}: 동시 ${step.maxParallelRequests}·보류 ${step.maxPendingRequests}·연결 ${step.maxConnections}, 도착률 ${step.rate}/s, 지연 ${delayText(step.delay)}`);
    const proxy = (await readProxy(deps, a.gateway)).proxy;
    const base = { step: step.index, maxConnections: step.maxConnections, maxParallelRequests: step.maxParallelRequests, maxPendingRequests: step.maxPendingRequests, rate: step.rate, delay: delayText(step.delay), mix: step.mix, repeat: step.repeat, proxy };
    await deps.kubectl(['apply', '-f', '-'], { input: JSON.stringify(sweepPolicy({ route: a.route, ...step })) });
    const w = await waitLimits(deps, pods, cluster, step);
    const overload = isOverload(step);
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
    // 보낸 흐름 모두(도착률이 0이라 보내지 않은 흐름은 빠진다)의 값. 재는 흐름은 targetNames
    const sentNames = input.streams.map((s) => s.name);
    const ms = metricsOf(r.load.summary, sentNames, deps.log);
    const targetNames = targets.map((t) => t.name).filter((n) => sentNames.includes(n));
    const accessLogs = {};
    if (overload) {
      try {
        const lines = await deps.readAccessLog(a.gateway, Math.ceil((deps.now() - marks.main_start) / 1000) + 30);
        for (const t of targets) accessLogs[t.name] = accessLogDurations(lines, { fromMs: marks.main_start, toMs: marks.main_end, status: '503', pathRe: pathPattern(t.path) });
      } catch (e) {
        deps.log(`  접근 로그를 읽지 못함: ${e.message}`);
      }
    }
    const j = judgeSweepStreams({ step, overload, limitsLoaded: true, statsError, stats, streams: ms, targets: targetNames, generator: r.load.generator, accessLogs });
    const tm = targetNames.length && targetNames.every((n) => ms[n]) ? combineMetrics(targetNames.map((n) => ms[n])) : null;
    const all = Object.keys(ms).length ? combineMetrics(Object.values(ms)) : null;
    const m1 = targetNames.length === 1 ? tm : null;
    const ra = r.load.retryAfterValues ?? {};
    const row = {
      ...base,
      overload,
      targets: targetNames,
      sent: tm?.sent ?? 0,
      status: tm?.status ?? null,
      streams: Object.fromEntries(Object.entries(ms).map(([n, v]) => [n, { sent: v.sent, status: v.status, latency503: v.latency['503'], retryAfter503: v.retryAfter['503'], problem503: v.problem['503'] }])),
      overflow: stats?.overflow ?? null,
      rqActiveMax: stats?.rqActiveMax ?? null,
      rqPendingActiveMax: stats?.rqPendingActiveMax ?? null,
      latency: m1 ? { '2xx': m1.latency['2xx'], 503: m1.latency['503'] } : null,
      retryAfter: tm ? { present: tm.retryAfter['503'].num + tm.retryAfter['503'].nonnum, missing: tm.retryAfter['503'].missing, nonNumeric: tm.retryAfter['503'].nonnum, values: [...(ra['503'] ?? [])].sort() } : null,
      problemOk: tm?.problem['503'].ok ?? null,
      problemBad: tm?.problem['503'].bad ?? null,
      accessLog503: overload ? accessLogs : null,
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
    if (a.record && all) {
      await deps.record({
        index: step.index,
        runId: runIdOf(a.runIdPrefix, 'sweep', `${String(step.index + 1).padStart(2, '0')}-${label}`),
        kpi: 'NFR-001',
        rps: step.rate,
        scenario: `loadtest/scenarios/gw.js gw sweep ${a.gateway}/${a.route} maxConnections=${step.maxConnections} maxParallelRequests=${step.maxParallelRequests} maxPendingRequests=${step.maxPendingRequests} delay=${delayText(step.delay)} rate=${step.rate}/s mix=${step.mix}`,
        notes: notesOf([
          `게이트웨이 차단 상한 스윕(local-gw, V-T43, docs/infra.md §4.1): ${j.item} ${j.verdict}${j.reasons.length ? `(${j.reasons.join('; ')})` : ''}`,
          `흐름 모두 ${countText(all)}`,
          ...Object.entries(ms).map(([n, v]) => `${n} ${countText(v)}`),
          overload ? null : `정상 부하 503 ${all.status['503']}건(세 흐름 합, 허용 0건)`,
          `프록시 ${a.gateway} 파드 ${pods.length}개, ${proxyText(proxy)}`,
          `묶음 ${cluster}`,
          stats ? `넘침 ${stats.overflowTotal}, 처리 중 최대 ${stats.rqActiveMax}, 보류 최대 ${stats.rqPendingActiveMax}` : null,
        ]),
        // 0건 목표는 판정으로, 점검은 과부하의 3ms 하나(재는 흐름마다)뿐이다(R1). 무효 단계는 점검을 넘기지 않는다
        checks: j.valid ? { checks: targetNames.flatMap((n) => (ms[n] ? sweepChecks(n, overload, ms[n]).checks : [])) } : { checks: [] },
        ...(j.valid ? { verdict: j.verdict } : { invalidReason: j.invalid_reason }),
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

/** 주석에 남길 원래 값(일꾼 수·자원, 없으면 null) */
const restoreRecord = (obj) => {
  const spec = obj?.spec ?? {};
  return { concurrency: spec.concurrency ?? null, resources: spec.provider?.kubernetes?.envoyDeployment?.container?.resources ?? null };
};
/** 주석의 값에서 되돌리는 병합 패치 */
const restoreFromRecord = (rec) => {
  const spec = { provider: { kubernetes: { envoyDeployment: { container: rec?.resources ? { resources: rec.resources } : {} } } } };
  if (rec?.concurrency !== null && rec?.concurrency !== undefined) spec.concurrency = rec.concurrency;
  return envoyProxyPatches({ spec }, 1).restore;
};

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
  const { name: ep, obj: original } = await readProxy(deps, a.gateway);
  const { bind, restore } = envoyProxyPatches(original, a.proxyCpus);
  // 강제 종료로 아래 되돌리기를 건너뛰어도 cleanup이 되돌리게 원래 값을 주석에 먼저 남긴다(R6)
  await deps.kubectl(['-n', GW_NAMESPACE, 'annotate', 'envoyproxy', ep, `${RESTORE_ANNOTATION}=${JSON.stringify(restoreRecord(original))}`, '--overwrite']);
  restores.push(async () => {
    await deps.kubectl(['-n', GW_NAMESPACE, 'patch', 'envoyproxy', ep, '--type', 'merge', '-p', JSON.stringify(restore)]);
    await deps.kubectl(['-n', GW_NAMESPACE, 'annotate', 'envoyproxy', ep, `${RESTORE_ANNOTATION}-`]);
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
    const proxy = proxyResources(JSON.parse(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'envoyproxy', ep, '-o', 'json'])));
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
    const row = { step: i, rate, proxy, sent: m?.sent ?? 0, status: m?.status ?? null, latency: m ? { '2xx': m.latency['2xx'], 503: m.latency['503'] } : null, p99Ms: m?.latency['2xx'].p99 ?? null, proxyCpuPct: cpuPct, generator: { cpuMeanPct: g.cpuMeanPct ?? null, dropped_iterations: g.dropped ?? null }, valid, invalid_reason: valid ? null : reasons.join('; '), marks };
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
        notes: notesOf([`게이트웨이 프록시 포화 처리량(local-gw, V-T43 '값의 식'의 파드 포화 처리량, 계획 docs/review/plans/BAT-056.md §5 M1)`, countText(m), `프록시 ${a.gateway} 파드 ${pods.length}개, ${proxyText(proxy)}`, `프록시 CPU 사용 ${cpuPct}%`]),
        ...(valid ? { verdict: 'baseline' } : { invalidReason: row.invalid_reason }),
        marks,
      });
    }
    if (!valid) break;
  }
  return { exitCode: 0, result };
}

async function ipLimit(a, deps) {
  const streams = streamsFor(a);
  const { proxy } = await readProxy(deps, 'gw-fan');
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
    proxy,
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
      notes: notesOf([
        `검색 IP 한도(local-gw, SR-T13 ②, docs/features/search.md §12 '측정 판정'): ${j.verdict}${j.reasons.length ? `(${j.reasons.join('; ')})` : ''}`,
        ...Object.entries(ms).map(([n, v]) => `${n} ${countText(v)}`),
        `프록시 gw-fan 복제 ${pods.length}, ${proxyText(proxy)}`,
        j.cap ? `한 IP 통과 상한 ${j.cap}` : null,
      ]),
      // 관찰(v6-64)은 판정 없이 baseline으로 남긴다
      ...(j.valid ? { verdict: j.verdict === 'pass' || j.verdict === 'fail' ? j.verdict : 'baseline' } : { invalidReason: j.invalid_reason }),
      marks: load.marks,
    });
  }
  return { exitCode: 0, result };
}

/**
 * 성능 장부로 옮기는 collect.py 인자(docs/perf-ledger.md §2.2 checks, 추천 적용 2026-11-18, BAT-056 R1). o는 runGw가 deps.record에 넘긴 값,
 * ctx = { mainS, warmS, summaryFile, infraFile, checksFile, generator }. 돌려주는 꼴: { args(첫 원소 'tools/perf-ledger/collect.py'), checks(ctx.checksFile에 쓸 JSON, 없으면 null) }.
 * - 무효(o.invalidReason): --invalid-reason만 주고 --verdict·--checks는 주지 않는다
 * - 점검이 있으면(과부하의 503 p99 3ms): --checks를 준다. 판정이 pass면 --verdict를 주지 않아 장부가 점검에서 판정을 정하고(시행 수가 최소 시행 수 미달이면 비움),
 *   fail이면 --verdict fail(Retry-After·Problem 빠짐 같은 점검 밖의 까닭)
 * - 점검이 없으면 --verdict <o.verdict>(pass·fail·baseline, 없으면 baseline)
 */
export function gwCollectArgs(o, ctx) {
  const checks = !o.invalidReason && o.checks?.checks?.length ? { checks: o.checks.checks } : null;
  const args = collectArgs({
    runId: o.runId,
    kpi: o.kpi,
    // Envoy Gateway는 최종 아키텍처(v1)의 게이트웨이다(docs/perf-ledger.md §4 local-gw)
    version: 'v1',
    profile: 'local-gw',
    rps: o.rps,
    durationS: ctx.mainS,
    warmupS: ctx.warmS,
    scenario: o.scenario,
    summaryFile: ctx.summaryFile,
    infraFile: ctx.infraFile,
    notes: o.notes,
    start: new Date(o.marks.main_start - ctx.warmS * 1000).toISOString(),
    end: new Date(o.marks.main_end).toISOString(),
    ...(o.invalidReason ? { invalidReason: o.invalidReason } : {}),
    ...(checks ? { checks: ctx.checksFile } : {}),
    ...(ctx.generator ? { generator: ctx.generator } : {}),
  });
  // collectArgs는 늘 --verdict baseline을 넣는다. 위 규칙대로 바꾼다
  const v = args.indexOf('--verdict');
  if (v >= 0) args.splice(v, 2);
  if (!o.invalidReason) {
    const verdict = checks && o.verdict === 'pass' ? null : (o.verdict ?? 'baseline');
    if (verdict !== null) args.push('--verdict', verdict);
  }
  return { args, checks };
}

/**
 * node loadtest/run.mjs cleanup의 게이트웨이 몫(R6): 이름표 peaket.io/sweep 임시 정책을 지우고, CPU 묶음 주석(RESTORE_ANNOTATION)이 남은 EnvoyProxy를
 * 주석의 값으로 되돌린 뒤 주석을 지운다. 주석 없는 EnvoyProxy는 건드리지 않는다. deps는 runGw의 꼴(kubectl·log)
 */
export async function cleanupGw(deps) {
  await deps.kubectl([...SWEEP_DELETE_ARGS]);
  const items = JSON.parse(await deps.kubectl(['-n', GW_NAMESPACE, 'get', 'envoyproxies', '-o', 'json'])).items ?? [];
  for (const ep of items) {
    const raw = ep?.metadata?.annotations?.[RESTORE_ANNOTATION];
    if (raw === undefined) continue;
    const name = ep.metadata.name;
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      throw new Error(`EnvoyProxy ${name}의 주석 ${RESTORE_ANNOTATION}을 읽지 못했다: ${String(raw).slice(0, 200)}`);
    }
    await deps.kubectl(['-n', GW_NAMESPACE, 'patch', 'envoyproxy', name, '--type', 'merge', '-p', JSON.stringify(restoreFromRecord(rec))]);
    await deps.kubectl(['-n', GW_NAMESPACE, 'annotate', 'envoyproxy', name, `${RESTORE_ANNOTATION}-`]);
    deps.log?.(`EnvoyProxy ${name}를 주석의 원래 값(일꾼 수 ${rec?.concurrency ?? '기본'}, 자원 ${JSON.stringify(rec?.resources ?? null)})으로 되돌렸다`);
  }
}
