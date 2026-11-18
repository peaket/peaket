// 게이트웨이 차단 상한 측정 도구의 순수 함수(V-T43, SR-T13 ②, BUILD_ORDER BAS-090, 묶음 BAT-056 계획 §2 '측정 도구'). 클러스터를 건드리지 않는다.
// 정본: docs/infra.md §4.1 '게이트웨이 차단 상한'(자리와 칸·값의 식·측정(V-T43)), docs/features/search.md §12 SR-T13 ② '측정 판정',
// docs/perf-ledger.md §4 프로파일 local-gw. 실행 조립은 gw-run.mjs, 명령은 node loadtest/run.mjs gw sweep|capacity|ip-limit|limits(loadtest/README.md).
// 일꾼 수 확인·발생기 가중 평균·gw limits는 묶음 BAT-058(ADR-0287 결정 6·7·10, docs/infra.md §4.1 '값의 식'·'측정(V-T43)' 끝 ①~⑤).
//
// 명령과 인자(클러스터를 건드리기 전에 모두 검사한다. 틀리면 UsageError, 실행 도구의 끝 코드 2):
//   gw sweep    [--gateway gw-queue] [--route gw-queue-buy] [--rate 1500] [--mix normal|single] [--delay normal|fixed:<ms>]
//               --max-parallel <목록> [--max-pending <수 또는 목록>(1024)] [--max-connections same|<수>(same)] [--workers <1~64>]
//               [--warm 10] [--main 60] [--repeat 1] [--generators N] [--cpus 4] [--memory-mi 4096] [--record --run-id-prefix <접두>] [--out <폴더>]
//   gw capacity [--gateway gw-queue] [--route gw-queue-buy] [--proxy-cpus 0.5] [--rates 500,1000,1500,2000,3000] [--delay fixed:5]
//               [--warm 10] [--main 30] [--generators N] [--cpus 4] [--memory-mi 4096] [--record --run-id-prefix <접두>] [--out <폴더>]
//   gw ip-limit --case single|many|mixed|v6-64 [--rate <초당>] [--ips <수>] [--warm 10] [--main 60] [--generators N] [--cpus 4] [--memory-mi 4096]
//               [--record --run-id-prefix <접두>] [--out <폴더>]
//   gw limits   --from <sweep.json>[,<sweep.json>…] --saturation <vCPU 하나의 초당 건수> --pod-cpus <코어> [--out <폴더>]   (클러스터를 쓰지 않는다)
import { UsageError } from './args.mjs';

/** 게이트웨이 프록시와 정책의 네임스페이스(deploy/gateways) */
export const GW_NAMESPACE = 'envoy-gateway-system';
/** 임시 정책(스윕)의 이름표. node loadtest/run.mjs cleanup도 이 이름표로 지운다 */
export const SWEEP_LABEL = 'peaket.io/sweep';
/** 프록시 파드 고르개 틀(Envoy Gateway가 단다) */
export const PROXY_SELECTOR = (gw) => `gateway.envoyproxy.io/owning-gateway-name=${gw}`;
/** Envoy 통계 포트·경로(Envoy Gateway 기본, tools/local/gateway-objects.mjs 접속 정보 stats) */
export const STATS_PORT = 19001;
export const STATS_PATH = '/stats/prometheus';
/** Envoy 관리 포트(파드 안 127.0.0.1에만 열려 있어 포트 전달로만 읽는다. 부하는 거치지 않는다) */
export const ADMIN_PORT = 19000;
export const GATEWAYS = Object.freeze(['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops', 'gw-scanner']);
/** 차단 상한 칸의 범위(Envoy Gateway v1.10.0 CRD: 0~4,294,967,295. 0은 모든 요청을 막아 측정 값으로 받지 않는다) */
export const LIMIT_MAX = 4294967295;

// ---- 정본 값(docs/infra.md §4.1 '게이트웨이 차단 상한' '측정(V-T43)') ----
/** 게이트웨이가 만든 503의 응답 시간 p99 상한(ms). 넘은 수를 셀 때는 '이 값보다 큼'이다(3.0은 통과) */
export const FAST_FAIL_MS = 3;
/** 정상 부하의 비율 [가정]: 진입 1,500 : 홀드 15 : 결제 접수 3(진입 도착률에 대한 몫) */
export const NORMAL_MIX = Object.freeze({ entry: 1, hold: 15 / 1500, pay: 3 / 1500 });
/** 정상 부하의 업스트림 지연 분포 [가정]: 5ms 90%·20ms 9%·100ms 1% */
export const NORMAL_DELAY = Object.freeze([
  Object.freeze({ ms: 5, weight: 90 }),
  Object.freeze({ ms: 20, weight: 9 }),
  Object.freeze({ ms: 100, weight: 1 }),
]);
/** SR-T13 ② 검색 IP 한도(docs/features/search.md §8, 초당 50건·버킷 50건 [가정]) */
export const SEARCH_PER_IP_PER_S = 50;
/** 포화 판정(계획 §5 M1): 프록시 CPU가 한도의 90% 이상이거나 'p99 − 고정 지연'이 3ms를 넘으면 포화 */
export const SATURATION_CPU_PCT = 90;
export const SATURATION_EXTRA_MS = 3;
/** 발생기 하나가 놓침 없이 보내는 도착률(2026-11-03 보정, loadtest/runner/merge.mjs GENERATOR_RATE_CAP과 같은 근거) */
const GEN_RATE_CAP = 1000;
/** 발생기 파드 실행 시간 상한(loadtest/runner/manifests.mjs generatorPod) */
const POD_DEADLINE_MAX_S = 11400;
/** 단계마다 더 드는 시간(초): 정책 적용·상한이 실리기 기다림·k6 시작·통계 읽기·접근 로그 읽기 [가정] */
export const STEP_OVERHEAD_S = 120;

/**
 * 요청 흐름(스트림). 경로의 {id}는 시나리오가 회차 ID로 바꾼다. host는 접속 정보 hosts의 키다
 * - entry: 대기열 진입(gw-queue gw-queue-buy), hold: 좌석 홀드(gw-fan gw-fan-buy), pay: 결제 접수(gw-fan gw-fan-buy)
 * - search: 검색(gw-fan gw-fan-search, SR-T13 ②)
 */
export const STREAMS = Object.freeze({
  entry: Object.freeze({ gateway: 'gw-queue', route: 'gw-queue-buy', host: 'queue', method: 'POST', path: '/v1/queues/{id}/entries', token: true }),
  hold: Object.freeze({ gateway: 'gw-fan', route: 'gw-fan-buy', host: 'api', method: 'POST', path: '/v1/events/{id}/holds', token: true }),
  pay: Object.freeze({ gateway: 'gw-fan', route: 'gw-fan-buy', host: 'api', method: 'POST', path: '/v1/orders/{id}/payment-acceptance', token: true }),
  search: Object.freeze({ gateway: 'gw-fan', route: 'gw-fan-search', host: 'api', method: 'GET', path: '/v1/search?q=peaket', token: false }),
});

/** SR-T13 ② 경우마다의 기본값(계획 §5 M-S) */
export const IP_CASES = Object.freeze({
  single: Object.freeze({ rate: 150, ips: 1 }),
  many: Object.freeze({ rate: 1000, ips: 1000 }),
  mixed: Object.freeze({ rate: 1000, ips: 20000, singleRate: 150 }),
  'v6-64': Object.freeze({ rate: 1000, ips: 100 }),
});

export const SWEEP_DEFAULTS = Object.freeze({ gateway: 'gw-queue', route: 'gw-queue-buy', rate: 1500, mix: 'normal', delay: 'normal', maxPending: Object.freeze([1024]), maxConnections: 'same', warmS: 10, mainS: 60, repeat: 1, cpus: 4, memoryMi: 4096 });
export const CAPACITY_DEFAULTS = Object.freeze({ gateway: 'gw-queue', route: 'gw-queue-buy', proxyCpus: 0.5, rates: Object.freeze([500, 1000, 1500, 2000, 3000]), delay: 'fixed:5', warmS: 10, mainS: 30, cpus: 4, memoryMi: 4096 });
export const IP_LIMIT_DEFAULTS = Object.freeze({ warmS: 10, mainS: 60, cpus: 4, memoryMi: 4096 });

const fail = (m) => {
  throw new UsageError(m);
};

const ROUTE_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PREFIX = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,40}$/;

function int(flag, raw, lo, hi) {
  if (!/^\d+$/.test(raw)) fail(`${flag}는 10진수 정수다: ${raw}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < lo || n > hi) fail(`${flag}는 ${lo}~${hi}다: ${raw}`);
  return n;
}

/** 쉼표 목록(빈 칸·겹침은 거부). 각 값은 lo~hi 정수 */
function intList(flag, raw, lo, hi) {
  const parts = raw.split(',');
  if (parts.some((p) => p === '')) fail(`${flag} 목록에 빈 값이 있다: ${raw}`);
  if (parts.length > 20) fail(`${flag}는 1~20개다`);
  const out = parts.map((p) => int(flag, p, lo, hi));
  if (new Set(out).size !== out.length) fail(`${flag} 목록에 같은 값이 두 번 있다: ${raw}`);
  return out;
}

/**
 * 지연 꼴: 'normal'(정본 분포) 또는 'fixed:<ms>'(0~60,000 정수, 대역 백엔드 x-e2e-delay-ms의 범위)
 * @returns {{ kind: 'normal' } | { kind: 'fixed', ms: number }}
 */
export function parseDelay(raw, flag = '--delay') {
  if (raw === 'normal') return { kind: 'normal' };
  const m = /^fixed:(\d+)$/.exec(raw ?? '');
  if (!m) fail(`${flag}는 normal이나 fixed:<밀리초>다: ${raw}`);
  return { kind: 'fixed', ms: int(flag, m[1], 0, 60000) };
}

/** 지연 꼴의 평균(ms) */
export function meanDelayMs(delay) {
  if (delay.kind === 'fixed') return delay.ms;
  const w = NORMAL_DELAY.reduce((s, d) => s + d.weight, 0);
  return NORMAL_DELAY.reduce((s, d) => s + d.ms * d.weight, 0) / w;
}

/** 지연 꼴의 글(성능 장부 scenario·결과 파일): normal(5/20/100ms 90/9/1%) 또는 fixed:<ms> */
export const delayText = (delay) => (delay.kind === 'fixed' ? `fixed:${delay.ms}` : 'normal');

/** 프록시 CPU(--proxy-cpus): 0.1~16, 소수 둘째 자리까지 */
function proxyCpus(raw) {
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) fail(`--proxy-cpus는 소수 둘째 자리까지의 수다: ${raw}`);
  const n = Number(raw);
  if (!(n >= 0.1 && n <= 16)) fail(`--proxy-cpus는 0.1~16이다: ${raw}`);
  return n;
}

const ALLOWED = {
  sweep: ['--gateway', '--route', '--rate', '--mix', '--delay', '--max-parallel', '--max-pending', '--max-connections', '--workers', '--warm', '--main', '--repeat', '--generators', '--cpus', '--memory-mi', '--record', '--run-id-prefix', '--out'],
  capacity: ['--gateway', '--route', '--proxy-cpus', '--rates', '--delay', '--warm', '--main', '--generators', '--cpus', '--memory-mi', '--record', '--run-id-prefix', '--out'],
  'ip-limit': ['--case', '--rate', '--ips', '--warm', '--main', '--generators', '--cpus', '--memory-mi', '--record', '--run-id-prefix', '--out'],
  limits: ['--from', '--saturation', '--pod-cpus', '--out'],
};
/** gw sweep --workers의 범위(기대 일꾼 수, 1~64 정수) */
export const WORKERS_MAX = 64;
const BOOLS = new Set(['--record']);

/**
 * gw 명령의 인자(argv는 'gw' 다음부터)를 읽어 검사한다. 돌려주는 꼴:
 * - sweep: { command: 'gw', sub: 'sweep', gateway, route, rate, mix, delay, maxParallel: number[], maxPending: number[], pendingDefault: boolean, maxConnections: 'same'|number,
 *            workers: number|null(--workers, 1~64 정수. 없으면 null이고 기대 일꾼 수는 EnvoyProxy spec.concurrency), warmS, mainS, repeat, generators, cpus, memoryMi, record,
 *            runIdPrefix?, out?, steps }(steps는 expandSweepSteps의 결과)
 * - capacity: { command: 'gw', sub: 'capacity', gateway, route, proxyCpus, rates, delay, warmS, mainS, generators, cpus, memoryMi, record, runIdPrefix?, out? }
 * - ip-limit: { command: 'gw', sub: 'ip-limit', case, rate, ips, singleRate?, warmS, mainS, generators, cpus, memoryMi, record, runIdPrefix?, out? }
 * - limits: { command: 'gw', sub: 'limits', from: string[], saturation, podCpus, out? }(--from·--saturation·--pod-cpus는 꼭 있어야 한다. 기본값을 두지 않는다.
 *           --from은 쉼표 목록(빈 값·겹침 거부, 1~200개), --saturation은 1~1,000,000, --pod-cpus는 1~64 정수)
 * 규칙: 인자는 `--이름 값` 꼴만, 모르는 인자·그 명령에 없는 인자·값 없음·두 번은 거부. --workers는 sweep에만 있다. --record에는 --run-id-prefix가 꼭 있어야 하고
 * (`^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,40}$`), --run-id-prefix는 --record 없이 주지 않는다. --generators를 주지 않으면 ⌈최고 도착률 ÷ 1,000⌉.
 * 전체 길이(단계 수 × (warm + main + STEP_OVERHEAD_S))가 발생기 파드 실행 시간 상한 11,400초를 넘으면 거부
 * @param {string[]} argv
 */
export function parseGwArgs(argv) {
  if (!Array.isArray(argv)) fail('인자 목록이 없다');
  const [sub, ...rest] = argv;
  if (!Object.hasOwn(ALLOWED, sub ?? '')) fail(`gw 명령은 sweep·capacity·ip-limit·limits 가운데 하나다: ${sub ?? '(없음)'}`);
  const seen = new Map();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!ALLOWED[sub].includes(flag)) fail(Object.values(ALLOWED).some((l) => l.includes(flag)) ? `${flag}는 gw ${sub}에 없는 인자다` : `모르는 인자: ${flag}`);
    if (seen.has(flag)) fail(`${flag}를 두 번 줬다`);
    if (BOOLS.has(flag)) {
      seen.set(flag, true);
      continue;
    }
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${flag}에 값이 없다`);
    seen.set(flag, v);
    i++;
  }
  const get = (f) => seen.get(f);
  if (sub === 'limits') {
    for (const f of ['--from', '--saturation', '--pod-cpus']) if (get(f) === undefined) fail(`gw limits에는 ${f}가 꼭 있어야 한다(기본값이 없다)`);
    const from = get('--from').split(',');
    if (from.some((p) => p === '')) fail(`--from 목록에 빈 값이 있다: ${get('--from')}`);
    if (from.length > 200) fail('--from은 1~200개다');
    if (new Set(from).size !== from.length) fail(`--from 목록에 같은 파일이 두 번 있다: ${get('--from')}`);
    const lo = get('--out');
    if (lo !== undefined && lo.length === 0) fail('--out은 비지 않은 경로다');
    return { command: 'gw', sub, from, saturation: int('--saturation', get('--saturation'), 1, 1000000), podCpus: int('--pod-cpus', get('--pod-cpus'), 1, 64), ...(lo !== undefined ? { out: lo } : {}) };
  }
  const record = seen.has('--record');
  const runIdPrefix = get('--run-id-prefix');
  if (record && runIdPrefix === undefined) fail('--record에는 --run-id-prefix가 꼭 있어야 한다');
  if (!record && runIdPrefix !== undefined) fail('--run-id-prefix는 --record와 함께만 준다');
  if (runIdPrefix !== undefined && !PREFIX.test(runIdPrefix)) fail(`--run-id-prefix 꼴이 틀렸다(YYYY-MM-DD-영소문자·숫자·-): ${runIdPrefix}`);
  const out = get('--out');
  if (out !== undefined && out.length === 0) fail('--out은 비지 않은 경로다');
  const D = sub === 'sweep' ? SWEEP_DEFAULTS : sub === 'capacity' ? CAPACITY_DEFAULTS : IP_LIMIT_DEFAULTS;
  const common = {
    command: 'gw',
    sub,
    warmS: get('--warm') === undefined ? D.warmS : int('--warm', get('--warm'), 1, 600),
    mainS: get('--main') === undefined ? D.mainS : int('--main', get('--main'), 5, 1800),
    cpus: get('--cpus') === undefined ? D.cpus : int('--cpus', get('--cpus'), 1, 16),
    memoryMi: get('--memory-mi') === undefined ? D.memoryMi : int('--memory-mi', get('--memory-mi'), 256, 32768),
    record,
    ...(runIdPrefix !== undefined ? { runIdPrefix } : {}),
    ...(out !== undefined ? { out } : {}),
  };
  const gens = (maxRate) => (get('--generators') === undefined ? Math.max(1, Math.ceil(maxRate / GEN_RATE_CAP)) : int('--generators', get('--generators'), 1, 64));
  const checkLength = (nSteps) => {
    const total = nSteps * (common.warmS + common.mainS + STEP_OVERHEAD_S);
    if (total > POD_DEADLINE_MAX_S) fail(`전체 길이(${nSteps}단계 × ${common.warmS + common.mainS + STEP_OVERHEAD_S}초 = ${total}초)가 발생기 파드 실행 시간 상한 ${POD_DEADLINE_MAX_S}초를 넘는다. 단계를 나눠 돌린다`);
  };
  const gatewayRoute = () => {
    const gateway = get('--gateway') ?? D.gateway;
    if (!GATEWAYS.includes(gateway)) fail(`--gateway는 ${GATEWAYS.join('·')} 가운데 하나다: ${gateway}`);
    const route = get('--route') ?? D.route;
    if (!ROUTE_NAME.test(route)) fail(`--route는 HTTPRoute 이름이다: ${route}`);
    return { gateway, route };
  };

  if (sub === 'sweep') {
    const { gateway, route } = gatewayRoute();
    const rate = get('--rate') === undefined ? D.rate : int('--rate', get('--rate'), 1, 100000);
    const mix = get('--mix') ?? D.mix;
    if (mix !== 'normal' && mix !== 'single') fail(`--mix는 normal·single 가운데 하나다: ${mix}`);
    const delay = parseDelay(get('--delay') ?? D.delay);
    if (get('--max-parallel') === undefined) fail('gw sweep에는 --max-parallel이 꼭 있어야 한다');
    const maxParallel = intList('--max-parallel', get('--max-parallel'), 1, LIMIT_MAX);
    const pendingDefault = get('--max-pending') === undefined;
    const maxPending = pendingDefault ? [...D.maxPending] : intList('--max-pending', get('--max-pending'), 1, LIMIT_MAX);
    const mc = get('--max-connections') ?? D.maxConnections;
    const maxConnections = mc === 'same' ? 'same' : int('--max-connections', mc, 1, LIMIT_MAX);
    const repeat = get('--repeat') === undefined ? D.repeat : int('--repeat', get('--repeat'), 1, 10);
    const workers = get('--workers') === undefined ? null : int('--workers', get('--workers'), 1, WORKERS_MAX);
    const routeOf = streamsFor({ sub, gateway, route, mix }).find((s) => s.target);
    if (!routeOf) fail(`--gateway ${gateway} --route ${route}로 보낼 요청 흐름이 없다(아는 짝: ${Object.values(STREAMS).map((s) => `${s.gateway} ${s.route}`).join(', ')})`);
    const a = { ...common, gateway, route, rate, mix, delay, maxParallel, maxPending, pendingDefault, maxConnections, workers, repeat };
    const steps = expandSweepSteps(a);
    // 과부하 꼴(고정 지연)인데 재는 흐름들의 도착률 × 지연이 동시 상한 이하이면 과부하가 아니다(R8, docs/infra.md §4.1 '측정(V-T43)'). 정수로 견준다
    if (delay.kind === 'fixed') {
      const targetRate = streamsFor(a)
        .filter((s) => s.target)
        .reduce((s, x) => s + rateOf(x, rate), 0);
      for (const st of steps)
        if (targetRate * delay.ms <= st.maxParallelRequests * 1000)
          fail(`과부하 단계(--delay fixed:${delay.ms})인데 도착률 ${targetRate}/s × ${delay.ms}ms = 평균 동시 ${(targetRate * delay.ms) / 1000}가 동시 상한 ${st.maxParallelRequests} 이하다(과부하가 아니다)`);
    }
    checkLength(steps.length);
    const peak = streamsFor(a).reduce((s, x) => s + rateOf(x, rate), 0);
    return { ...a, generators: gens(peak), steps };
  }
  if (sub === 'capacity') {
    const { gateway, route } = gatewayRoute();
    if (!streamsFor({ sub, gateway, route, mix: 'single' }).length) fail(`--gateway ${gateway} --route ${route}로 보낼 요청 흐름이 없다`);
    const pc = get('--proxy-cpus') === undefined ? D.proxyCpus : proxyCpus(get('--proxy-cpus'));
    let rates = [...D.rates];
    if (get('--rates') !== undefined) {
      rates = intList('--rates', get('--rates'), 1, 100000);
      for (let i = 1; i < rates.length; i++) if (rates[i] <= rates[i - 1]) fail('--rates는 엄격히 오름차순이어야 한다');
    }
    const delay = parseDelay(get('--delay') ?? D.delay);
    if (delay.kind !== 'fixed') fail('gw capacity의 --delay는 fixed:<밀리초>다(포화 판정이 p99에서 고정 지연을 뺀다)');
    checkLength(rates.length);
    return { ...common, gateway, route, proxyCpus: pc, rates, delay, generators: gens(rates[rates.length - 1]) };
  }
  // ip-limit
  const c = get('--case');
  if (c === undefined) fail('gw ip-limit에는 --case가 꼭 있어야 한다');
  if (!Object.hasOwn(IP_CASES, c)) fail(`--case는 ${Object.keys(IP_CASES).join('·')} 가운데 하나다: ${c}`);
  const d = IP_CASES[c];
  const rate = get('--rate') === undefined ? d.rate : int('--rate', get('--rate'), 1, 100000);
  const ips = get('--ips') === undefined ? d.ips : int('--ips', get('--ips'), 1, 131072);
  if (c === 'single' && ips !== 1) fail('--case single은 IP 하나다(--ips 1)');
  if (c === 'v6-64' && ips > 65535) fail('--case v6-64의 --ips는 65,535 이하다');
  // many·v6-64는 IP마다 한도 아래여야 '정상' 경우다(초당 IP 하나 몫 = rate ÷ ips)
  if ((c === 'many' || c === 'mixed') && rate > SEARCH_PER_IP_PER_S * ips) fail(`--case ${c}는 IP마다 초당 ${SEARCH_PER_IP_PER_S}건 아래여야 한다(rate ${rate} ÷ ips ${ips})`);
  checkLength(1);
  const singleRate = c === 'mixed' ? d.singleRate : undefined;
  return { ...common, case: c, rate, ips, ...(singleRate !== undefined ? { singleRate } : {}), generators: gens(rate + (singleRate ?? 0)) };
}

/**
 * 스윕 단계 목록: 동시(maxParallel 목록) × 보류(maxPending 목록) × 되풀이(repeat) 차례. 연결은 'same'이면 동시와 같다.
 * 단계 = { index(0부터), maxConnections, maxParallelRequests, maxPendingRequests, rate, delay, mix, repeat(1부터) }.
 * 보류가 동시보다 크면 UsageError(정본 '값의 식': 보류 = ⌈동시 × q⌉, q ≤ 1). 다만 --max-pending을 주지 않은 기본 1024(Envoy 기본값, pendingDefault true)는
 * 보류로 막지 않고 동시 상한만 재는 단계(계획 §5 M-A '보류 1024 고정')라 이 검사를 하지 않는다
 * @param {{ maxParallel: number[], maxPending: number[], pendingDefault?: boolean, maxConnections: 'same'|number, repeat: number, rate: number, delay: object, mix: string }} a
 */
export function expandSweepSteps(a) {
  if (!Array.isArray(a?.maxParallel) || a.maxParallel.length === 0) fail('--max-parallel 목록이 비었다');
  if (!Array.isArray(a.maxPending) || a.maxPending.length === 0) fail('--max-pending 목록이 비었다');
  const ok = (v) => Number.isSafeInteger(v) && v >= 1 && v <= LIMIT_MAX;
  const steps = [];
  for (const p of a.maxParallel) {
    if (!ok(p)) fail(`동시 상한은 1~${LIMIT_MAX} 정수다: ${p}`);
    for (const q of a.maxPending) {
      if (!ok(q)) fail(`보류 상한은 1~${LIMIT_MAX} 정수다: ${q}`);
      if (q > p && a.pendingDefault !== true) fail(`보류 상한(${q})이 동시 상한(${p})보다 크다`);
      const c = a.maxConnections === 'same' ? p : a.maxConnections;
      if (!ok(c)) fail(`연결 상한은 1~${LIMIT_MAX} 정수이거나 same이다: ${c}`);
      for (let r = 1; r <= a.repeat; r++) steps.push({ index: steps.length, maxConnections: c, maxParallelRequests: p, maxPendingRequests: q, rate: a.rate, delay: a.delay, mix: a.mix, repeat: r });
    }
  }
  return steps;
}

/**
 * 보낼 요청 흐름들. 각 = { name, gateway, route, host, method, path, token, share(진입 도착률에 대한 몫), target(재는 라우트인가), ip }.
 * - sweep·capacity의 single: --route에 맞는 흐름 하나(몫 1). sweep의 normal: 진입·홀드·결제 접수(몫 1 : 15/1500 : 3/1500)이고 target은 --route에 맞는 것
 * - ip-limit: 경우마다 검색 흐름(몫은 rate, ip 꼴은 'single'·'pool'·'v6')
 */
export function streamsFor(a) {
  if (a.sub === 'ip-limit') {
    const base = { ...STREAMS.search, target: true };
    if (a.case === 'single') return [{ name: 'one', ...base, absRate: a.rate, ip: { kind: 'single', addr: '203.0.113.7' } }];
    if (a.case === 'many') return [{ name: 'many', ...base, absRate: a.rate, ip: { kind: 'pool', count: a.ips } }];
    if (a.case === 'v6-64') return [{ name: 'v6', ...base, absRate: a.rate, ip: { kind: 'v6', count: a.ips } }];
    return [
      { name: 'pool', ...base, absRate: a.rate, ip: { kind: 'pool', count: a.ips } },
      { name: 'one', ...base, absRate: a.singleRate, ip: { kind: 'single', addr: '203.0.113.7' } },
    ];
  }
  const names = a.mix === 'normal' && a.sub === 'sweep' ? ['entry', 'hold', 'pay'] : Object.keys(STREAMS).filter((n) => n !== 'search');
  const out = [];
  for (const n of names) {
    const s = STREAMS[n];
    const target = s.gateway === a.gateway && s.route === a.route;
    if (a.mix !== 'normal' || a.sub !== 'sweep') {
      if (!target) continue;
      out.push({ name: n, ...s, share: 1, target, ip: { kind: 'user' } });
      break;
    }
    out.push({ name: n, ...s, share: NORMAL_MIX[n], target, ip: { kind: 'user' } });
  }
  return out;
}

/** 흐름의 초당 도착률(정수, 0이면 보내지 않는다): ip-limit은 absRate, 그 밖은 round(진입 도착률 × 몫) */
export function rateOf(stream, rate) {
  if (stream.absRate !== undefined) return stream.absRate;
  return Math.round(rate * stream.share);
}

/**
 * 임시 정책(스윕 단계 하나): 이름 peaket-sweep-<라우트>, 이름표 peaket.io/sweep: "true", 대상은 그 HTTPRoute 하나, mergeType StrategicMerge
 * (게이트웨이 정책의 503 응답 고치기·Retry-After가 그대로 닿아야 한다), 칸은 circuitBreaker 셋뿐
 * @param {{ route: string, maxConnections: number, maxParallelRequests: number, maxPendingRequests: number }} o
 */
export function sweepPolicy(o) {
  if (typeof o?.route !== 'string' || !ROUTE_NAME.test(o.route)) throw new RangeError(`라우트 이름이 틀렸다: ${o?.route}`);
  for (const k of ['maxConnections', 'maxParallelRequests', 'maxPendingRequests'])
    if (!Number.isSafeInteger(o[k]) || o[k] < 1 || o[k] > LIMIT_MAX) throw new RangeError(`${k}는 1~${LIMIT_MAX} 정수다: ${o[k]}`);
  return {
    apiVersion: 'gateway.envoyproxy.io/v1alpha1',
    kind: 'BackendTrafficPolicy',
    metadata: { name: `peaket-sweep-${o.route}`, namespace: GW_NAMESPACE, labels: { [SWEEP_LABEL]: 'true' } },
    spec: {
      targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: o.route }],
      mergeType: 'StrategicMerge',
      circuitBreaker: { maxConnections: o.maxConnections, maxParallelRequests: o.maxParallelRequests, maxPendingRequests: o.maxPendingRequests },
    },
  };
}

/**
 * 임시 정책과 부딪히는 정책(같은 라우트 전체를 겨눈 BackendTrafficPolicy, 이름표 peaket.io/sweep이 없는 것)의 이름들.
 * 같은 대상을 두 정책이 겨누면 Envoy Gateway가 하나를 버려 스윕 값이 실리지 않거나 운영 정책이 빠진다
 * @param {Array<Record<string, any>>} policies `kubectl get backendtrafficpolicies -o json`의 items
 * @param {string} route
 */
export function conflictingPolicies(policies, route) {
  return (policies ?? [])
    .filter((p) => p?.metadata?.labels?.[SWEEP_LABEL] !== 'true')
    .filter((p) => (p?.spec?.targetRefs ?? []).some((t) => t?.kind === 'HTTPRoute' && t.name === route && t.sectionName === undefined))
    .map((p) => p.metadata.name)
    .sort();
}

/** 규칙 묶음(Envoy cluster) 이름: httproute/<네임스페이스>/<라우트>/rule/<번호>(Envoy Gateway v1.10.0 internal/gatewayapi/helpers.go irRouteDestinationName) */
export function clusterName(route, ruleIndex, namespace = GW_NAMESPACE) {
  if (!Number.isSafeInteger(ruleIndex) || ruleIndex < 0) throw new RangeError(`규칙 번호는 0 이상 정수다: ${ruleIndex}`);
  return `httproute/${namespace}/${route}/rule/${ruleIndex}`;
}

/**
 * 생성 라우트(HTTPRoute 객체)에서 (메서드, 경로)가 맞는 첫 규칙 번호. 경로 맞춤은 Exact·PathPrefix·RegularExpression(전체 일치). 없으면 Error
 * @param {Record<string, any>} routeObj @param {string} method @param {string} path 쿼리 없는 경로
 */
export function ruleIndexFor(routeObj, method, path) {
  const rules = routeObj?.spec?.rules ?? [];
  for (const [i, r] of rules.entries()) {
    for (const m of r?.matches ?? []) {
      if (m.method !== undefined && m.method !== method) continue;
      const p = m.path ?? { type: 'PathPrefix', value: '/' };
      const ok =
        p.type === 'Exact' ? path === p.value : p.type === 'RegularExpression' ? new RegExp(`^(?:${p.value})$`).test(path) : path === p.value || path.startsWith(p.value.endsWith('/') ? p.value : `${p.value}/`) || p.value === '/';
      if (ok) return i;
    }
  }
  throw new Error(`${routeObj?.metadata?.name}: ${method} ${path}에 맞는 규칙이 없다`);
}

/**
 * 관리 포트 /clusters 글에서 그 묶음의 기본 우선순위 상한: { maxConnections, maxPendingRequests, maxRequests, maxRetries }.
 * 줄 꼴 `<묶음>::default_priority::max_connections::<수>`. 이름이 정확히 같은 묶음만 읽는다(`<묶음>::`로 시작).
 * 그 묶음의 상한 줄이 하나도 없거나 넷 가운데 빠진 것이 있으면 Error(0으로 세지 않는다)
 * @param {string} text @param {string} cluster
 */
export function parseClusterLimits(text, cluster) {
  const want = { max_connections: 'maxConnections', max_pending_requests: 'maxPendingRequests', max_requests: 'maxRequests', max_retries: 'maxRetries' };
  const out = {};
  const head = `${cluster}::default_priority::`;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith(head)) continue;
    const [k, v] = line.slice(head.length).split('::');
    if (Object.hasOwn(want, k) && /^\d+$/.test(v ?? '')) out[want[k]] = Number(v);
  }
  const missing = Object.values(want).filter((k) => out[k] === undefined);
  if (missing.length === 4) throw new Error(`관리 포트 /clusters에 묶음 ${cluster}의 상한이 없다`);
  if (missing.length) throw new Error(`관리 포트 /clusters에 묶음 ${cluster}의 ${missing.join('·')}가 없다`);
  return out;
}

/** /clusters의 상한이 그 단계 값과 같은가(연결·동시·보류 셋) */
export const limitsLoaded = (limits, step) =>
  limits?.maxConnections === step.maxConnections && limits?.maxRequests === step.maxParallelRequests && limits?.maxPendingRequests === step.maxPendingRequests;

/**
 * Prometheus 꼴 통계 글에서 그 묶음(envoy_cluster_name이 정확히 같은 줄)의 값:
 * { overflow: { <이름>: 수 }(이름이 _overflow로 끝나는 카운터 전부), rqActive, rqPendingActive, rqTotal }.
 * 그 묶음 줄이 없거나 upstream_rq_active·upstream_rq_pending_active·upstream_rq_pending_overflow·upstream_cx_overflow 가운데 빠진 것이 있으면 Error
 * @param {string} text @param {string} cluster
 */
export function parseClusterStats(text, cluster) {
  const overflow = {};
  const vals = {};
  let seen = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('envoy_cluster_')) continue;
    const m = /^envoy_cluster_([a-z0-9_]+)\{([^}]*)\}\s+(\S+)$/.exec(line);
    if (!m) continue;
    const name = /(?:^|,)envoy_cluster_name="([^"]*)"/.exec(m[2])?.[1];
    if (name !== cluster) continue;
    seen = true;
    const v = Number(m[3]);
    if (!Number.isFinite(v)) continue;
    const stat = m[1].replace(/_total$/, '');
    if (stat.endsWith('_overflow')) overflow[stat] = (overflow[stat] ?? 0) + v;
    if (stat === 'upstream_rq_active' || stat === 'upstream_rq_pending_active' || stat === 'upstream_rq') vals[stat] = (vals[stat] ?? 0) + v;
  }
  if (!seen) throw new Error(`통계에 묶음 ${cluster}가 없다`);
  const need = ['upstream_rq_active', 'upstream_rq_pending_active'];
  for (const k of need) if (vals[k] === undefined) throw new Error(`통계에 묶음 ${cluster}의 ${k}가 없다`);
  for (const k of ['upstream_rq_pending_overflow', 'upstream_cx_overflow']) if (overflow[k] === undefined) throw new Error(`통계에 묶음 ${cluster}의 ${k}가 없다`);
  return { overflow, rqActive: vals.upstream_rq_active, rqPendingActive: vals.upstream_rq_pending_active, rqTotal: vals.upstream_rq ?? null };
}

// ---- 실제 일꾼 수 확인(ADR-0287 결정 10, docs/infra.md §4.1 '측정(V-T43)' 끝 ①, 묶음 BAT-058) ----

/**
 * 관리 포트 통계 글(Prometheus 꼴, 통계 포트 STATS_PORT의 STATS_PATH)에서 실제 일꾼 수: Envoy 통계 server.concurrency(지표 이름 envoy_server_concurrency).
 * 받는 줄 꼴은 `envoy_server_concurrency <값>`과 `envoy_server_concurrency{} <값>` 둘뿐이다(이름이 앞부분만 같은 다른 지표, 꼬리표가 붙은 줄은 읽지 않는다).
 * 값은 0 이상 10진수 정수다. 그 줄이 없거나, 값이 정수가 아니거나(5.5, -1), 서로 다른 값으로 두 번 이상 있으면 Error(0이나 null로 넘기지 않는다)
 * @param {string} text @returns {number}
 */
export function parseServerConcurrency(text) {
  const vals = [];
  for (const raw of String(text ?? '').split('\n')) {
    const m = /^envoy_server_concurrency(?:\{\})?[ \t]+(\S+)[ \t]*$/.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    if (!/^\d+$/.test(m[1])) throw new Error(`통계의 envoy_server_concurrency 값이 0 이상 정수가 아니다: ${m[1]}`);
    vals.push(Number(m[1]));
  }
  if (!vals.length) throw new Error('통계에 envoy_server_concurrency(server.concurrency) 줄이 없다');
  if (new Set(vals).size > 1) throw new Error(`통계에 envoy_server_concurrency가 서로 다른 값으로 여러 번 있다: ${vals.join(', ')}`);
  return vals[0];
}

/**
 * 단계의 기대 일꾼 수와 출처: --workers가 있으면 그 값('flag'), 없으면 그 게이트웨이 EnvoyProxy의 spec.concurrency('envoyproxy'),
 * 둘 다 없으면 { expected: null, source: null }(읽은 값을 적기만 하고 무효로 하지 않는다). gw capacity는 이 함수 대신 자기가 묶은 값(source 'capacity')을 쓴다.
 * EnvoyProxy 값이 있는데 0 이상 정수가 아니면 Error
 * @param {{ flag?: number|null, concurrency?: unknown }} o
 * @returns {{ expected: number|null, source: 'flag'|'envoyproxy'|null }}
 */
export function expectedWorkers(o) {
  if (o?.flag !== undefined && o.flag !== null) return { expected: o.flag, source: 'flag' };
  const c = o?.concurrency;
  if (c === undefined || c === null) return { expected: null, source: null };
  if (!Number.isSafeInteger(c) || c < 0) throw new Error(`EnvoyProxy spec.concurrency가 0 이상 정수가 아니다: ${JSON.stringify(c)}`);
  return { expected: c, source: 'envoyproxy' };
}

/**
 * 단계의 일꾼 수 문제(없으면 null, 있으면 무효 까닭 글):
 * - 한 파드라도 못 읽음(errors) 또는 파드가 없음: `일꾼 수를 못 읽음: <파드>: <까닭>[; <파드>: <까닭>…]`
 * - 기대 값이 있고 한 파드라도 다름: `일꾼 수가 <기대>가 아님(<파드> <값>[, <파드> <값>…])`(다른 파드만, 이름 차례)
 * 기대 값이 null이면 모두 읽힌 것만 본다
 * @param {{ expected: number|null, pods: Record<string, number|null>, errors?: Record<string, string> }} w
 * @returns {string|null}
 */
export function workersProblem(w) {
  const errs = Object.entries(w?.errors ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (errs.length) return `일꾼 수를 못 읽음: ${errs.map(([p, m]) => `${p}: ${m}`).join('; ')}`;
  const names = Object.keys(w?.pods ?? {}).sort();
  if (!names.length) return '일꾼 수를 못 읽음: 프록시 파드가 없다';
  const unread = names.filter((p) => !Number.isSafeInteger(w.pods[p]));
  if (unread.length) return `일꾼 수를 못 읽음: ${unread.map((p) => `${p}: 값 없음`).join('; ')}`;
  if (w.expected === null || w.expected === undefined) return null;
  const bad = names.filter((p) => w.pods[p] !== w.expected);
  return bad.length ? `일꾼 수가 ${w.expected}가 아님(${bad.map((p) => `${p} ${w.pods[p]}`).join(', ')})` : null;
}

/** 장부 notes의 일꾼 수 글: `일꾼 수(관리 포트) <파드> <값>[, …], 기대 <n>(<출처>)`. 기대 값이 없으면 `기대 없음`, 못 읽은 파드의 값은 `못 읽음` */
export function workersText(w) {
  const pods = Object.keys(w?.pods ?? {})
    .sort()
    .map((p) => `${p} ${Number.isSafeInteger(w.pods[p]) ? w.pods[p] : '못 읽음'}`);
  const exp = w?.expected === null || w?.expected === undefined ? '기대 없음' : `기대 ${w.expected}(${w.source})`;
  return `일꾼 수(관리 포트) ${pods.join(', ') || '(파드 없음)'}, ${exp}`;
}

/**
 * 통계 표본(시각 오름차순 { atMs, pods: { <파드>: parseClusterStats 결과 } })에서 본구간 [fromMs, toMs]의 값:
 * 넘침은 '본구간 시작 전 마지막 표본'과 '끝난 뒤 첫 표본'의 차이(파드마다 빼서 더함, 이름마다), 처리 중·보류 최대는 그 사이 표본(양 끝 포함)의 파드별 최댓값.
 * 시작 전·끝난 뒤 표본이 없거나 파드가 다르면 Error(통계를 못 읽음 = 무효)
 */
export function statsWindow(samples, fromMs, toMs) {
  const list = (samples ?? []).filter((s) => s && Number.isFinite(s.atMs)).sort((x, y) => x.atMs - y.atMs);
  const before = list.filter((s) => s.atMs <= fromMs).pop();
  const after = list.find((s) => s.atMs >= toMs);
  if (!before) throw new Error('본구간 시작 전 통계 표본이 없다');
  if (!after) throw new Error('본구간이 끝난 뒤 통계 표본이 없다');
  const pods = Object.keys(before.pods).sort();
  if (pods.join(',') !== Object.keys(after.pods).sort().join(',')) throw new Error('본구간 앞뒤의 프록시 파드가 다르다(다시 시작)');
  const overflow = {};
  for (const p of pods)
    for (const [k, v] of Object.entries(after.pods[p].overflow)) {
      const d = v - (before.pods[p].overflow[k] ?? 0);
      if (d < 0) throw new Error(`넘침 카운터 ${k}가 줄었다(프록시 다시 시작)`);
      overflow[k] = (overflow[k] ?? 0) + d;
    }
  let rqActiveMax = 0;
  let rqPendingActiveMax = 0;
  for (const s of list.filter((x) => x.atMs >= before.atMs && x.atMs <= after.atMs))
    for (const v of Object.values(s.pods)) {
      rqActiveMax = Math.max(rqActiveMax, v.rqActive);
      rqPendingActiveMax = Math.max(rqPendingActiveMax, v.rqPendingActive);
    }
  return { overflow, overflowTotal: Object.values(overflow).reduce((a, b) => a + b, 0), rqActiveMax, rqPendingActiveMax, samples: list.length };
}

/**
 * 접근 로그 줄(JSON 객체)에서 본구간 [fromMs, toMs]의 그 상태 줄(경로가 pathRe에 맞는 것)의 durationMs: { lines, le(≤ FAST_FAIL_MS 수), ratio, p99 }.
 * 줄이 없으면 lines 0·ratio null·p99 null
 * @param {Array<Record<string, any>>} lines @param {{ fromMs: number, toMs: number, status: string, pathRe: RegExp }} o
 */
export function accessLogDurations(lines, o) {
  const d = [];
  for (const l of lines ?? []) {
    if (String(l?.status) !== o.status) continue;
    const t = Date.parse(l.time);
    if (!(t >= o.fromMs && t <= o.toMs)) continue;
    if (!o.pathRe.test(String(l.path ?? ''))) continue;
    const ms = Number(l.durationMs);
    if (Number.isFinite(ms)) d.push(ms);
  }
  d.sort((a, b) => a - b);
  const le = d.filter((x) => x <= FAST_FAIL_MS).length;
  return { lines: d.length, le, ratio: d.length ? le / d.length : null, p99: d.length ? d[Math.min(d.length - 1, Math.ceil(d.length * 0.99) - 1)] : null };
}

const count = (m) => (m && m.values && Number.isFinite(m.values.count) ? m.values.count : 0);
const trend = (m) => (m && m.values ? { p50: m.values.med ?? null, p99: m.values['p(99)'] ?? null, max: m.values.max ?? null } : { p50: null, p99: null, max: null });

/**
 * k6 요약(합친 것)에서 흐름 하나의 본구간 값. 요약에 그 흐름의 gw_reqs 지표가 하나도 없으면 Error(시나리오가 그 흐름을 보내지 않았다)
 * 돌려주는 꼴: { sent, status: { '2xx', '503', '429', other }, latency: { '2xx', '503', '429' }(각 { p50, p99, max }), overFast(503 가운데 FAST_FAIL_MS 넘은 수),
 *   retryAfter: { '503': { num, missing, nonnum }, '429': {…} }, problem: { '503': { ok, bad }, '429': {…} } }
 * @param {{ metrics: Record<string, any> }} summary @param {string} stream
 */
export function streamMetrics(summary, stream) {
  const m = summary?.metrics ?? {};
  const sel = (name, extra = '') => m[`${name}{phase:main,stream:${stream}${extra}}`];
  const classes = ['2xx', '503', '429', 'other'];
  if (!classes.some((c) => sel('gw_reqs', `,cls:${c}`) !== undefined)) throw new Error(`요약에 흐름 ${stream}의 gw_reqs 지표가 없다`);
  const status = Object.fromEntries(classes.map((c) => [c, count(sel('gw_reqs', `,cls:${c}`))]));
  const sent = classes.reduce((s, c) => s + status[c], 0);
  const ra = (cls) => Object.fromEntries(['num', 'missing', 'nonnum'].map((k) => [k, count(sel('gw_ra', `,cls:${cls},ra:${k}`))]));
  const pr = (cls) => ({ ok: count(sel('gw_problem', `,cls:${cls},ok:yes`)), bad: count(sel('gw_problem', `,cls:${cls},ok:no`)) });
  return {
    sent,
    status,
    latency: { '2xx': trend(sel('gw_dur_2xx')), 503: trend(sel('gw_dur_503')), 429: trend(sel('gw_dur_429')) },
    overFast: count(sel('gw_over_fast')),
    retryAfter: { 503: ra('503'), 429: ra('429') },
    problem: { 503: pr('503'), 429: pr('429') },
  };
}

/**
 * 흐름 하나의 본구간 2xx 평균 응답 시간(ms, ADR-0287 결정 6, docs/infra.md §4.1 '측정(V-T43)' 끝 ⑤): 발생기마다의 k6 요약(합치기 전)에서
 * gw_dur_2xx{phase:main,stream:<흐름>}의 avg를 그 발생기의 gw_reqs{phase:main,stream:<흐름>,cls:2xx} count로 가중한 평균. 소수 넷째 자리로 반올림한다.
 * 합친 요약(mergeSummaries)의 avg는 발생기 가운데 큰 값이라 쓰지 않는다(merge.mjs 머리 주석).
 * 요약 목록이 없거나 비었음, 어느 요약에 그 흐름의 2xx 수 지표가 없음, 2xx가 1건 이상인 요약에 avg가 없음, 2xx 합이 0이면 null(값을 지어내지 않는다)
 * @param {Array<{ metrics: Record<string, any> }>|undefined|null} summaries @param {string} stream @returns {number|null}
 */
export function weightedMean2xx(summaries, stream) {
  if (!Array.isArray(summaries) || summaries.length === 0) return null;
  let n = 0;
  let sum = 0;
  for (const s of summaries) {
    const m = s?.metrics;
    if (!m || typeof m !== 'object') return null;
    const c = m[`gw_reqs{phase:main,stream:${stream},cls:2xx}`]?.values?.count;
    if (!Number.isFinite(c) || c < 0) return null;
    if (c === 0) continue;
    const avg = m[`gw_dur_2xx{phase:main,stream:${stream}}`]?.values?.avg;
    if (!Number.isFinite(avg)) return null;
    n += c;
    sum += avg * c;
  }
  return n > 0 ? Math.round((sum / n) * 1e4) / 1e4 : null;
}

/**
 * 과부하 단계인가: 계산으로 가르지 않고 부하 꼴로 정한다(docs/infra.md §4.1 '측정(V-T43)', 추천 적용 2026-11-18, BAT-056 R8).
 * 지연이 정본 분포(normal)면 정상 부하(①), 재는 흐름의 지연을 고정 값(fixed:<ms>)으로 바꾼 단계면 과부하(②)다
 */
export function isOverload(step) {
  return step?.delay?.kind === 'fixed';
}

/**
 * 여러 흐름의 streamMetrics 결과를 합친 하나(상태별 수·Retry-After·Problem·overFast는 더한다. 응답 시간은 합칠 수 없어 흐름이 하나일 때만 그대로다)
 * @param {Array<ReturnType<typeof streamMetrics>>} list
 */
export function combineMetrics(list) {
  const ms = (list ?? []).filter(Boolean);
  if (ms.length === 1) return ms[0];
  const add = (get) => ms.reduce((s, m) => s + (get(m) ?? 0), 0);
  const nullTrend = { p50: null, p99: null, max: null };
  return {
    sent: add((m) => m.sent),
    status: Object.fromEntries(['2xx', '503', '429', 'other'].map((c) => [c, add((m) => m.status[c])])),
    latency: { '2xx': nullTrend, 503: nullTrend, 429: nullTrend },
    overFast: add((m) => m.overFast),
    retryAfter: Object.fromEntries(['503', '429'].map((c) => [c, Object.fromEntries(['num', 'missing', 'nonnum'].map((k) => [k, add((m) => m.retryAfter[c][k])]))])),
    problem: Object.fromEntries(['503', '429'].map((c) => [c, { ok: add((m) => m.problem[c].ok), bad: add((m) => m.problem[c].bad) }])),
  };
}

/**
 * 2xx와 그 상태(503 또는 429) 밖의 응답이 있으면 그 글, 없으면 null(docs/infra.md §4.1 '측정(V-T43)' R2, docs/features/search.md SR-T13 ②).
 * 밖의 응답이 없다는 것은 그 밖(other)이 0이고 2xx + 그 상태 = 보낸 수라는 뜻이다
 */
export function outsideResponses(m, expected) {
  const n = m.sent - m.status['2xx'] - m.status[expected];
  if (n === 0 && m.status.other === 0) return null;
  const parts = ['503', '429'].filter((c) => c !== expected && m.status[c] > 0).map((c) => `${c} ${m.status[c]}`);
  if (m.status.other > 0) parts.push(`그 밖(401·403·404·연결 실패·시간 넘김 등) ${m.status.other}`);
  return `2xx·${expected} 밖의 응답 ${Math.max(n, m.status.other)}건(${parts.join(', ') || '보낸 수와 상태별 수가 맞지 않음'})`;
}

/**
 * 스윕 단계 하나의 판정(정본 docs/infra.md §4.1 '측정(V-T43)'). 입력:
 *   { step, overload, limitsLoaded, workersError?(workersProblem의 까닭: 일꾼 수가 기대와 다르거나 못 읽음), statsError?(통계를 못 읽은 까닭), stats?(statsWindow 결과),
 *     m?(streamMetrics 결과), mAll?(보낸 흐름 모두를 합친 것, 그 밖 응답(R2)을 m과 함께 본다), generator: { valid, reasons, dropped }, accessLog?(accessLogDurations 결과 또는 null) }
 * 돌려주는 꼴: { item: 'V-T43 ①'|'V-T43 ②', verdict: 'pass'|'fail'|'invalid', valid, invalid_reason, reasons: string[] }
 * - 무효(통과로 세지 않음): 상한이 실리지 않음, 일꾼 수가 기대와 다르거나 못 읽음(ADR-0287 결정 10), 통계를 못 읽음, 보낸 수 0, dropped_iterations ≥ 1, 발생기 판정 무효,
 *   2xx·503 밖의 응답이 한 건이라도 있음(R2: 상한에 닿기 전에 다른 까닭으로 막힘), 과부하인데 503 0건,
 *   발생기 503 p99만 FAST_FAIL_MS를 넘고 접근 로그 p99는 안 넘음('측정 지점 의심')
 * - 실패: (공통) 503 하나라도 Retry-After가 없거나 숫자가 아님, 503 Problem 본문이 틀림, 처리 중 최대 > 동시 상한.
 *   (정상 부하 ①) 발생기 503이 1건 이상이거나 Envoy 넘침이 1 이상. (과부하 ②) 503 p99 > FAST_FAIL_MS
 */
export function judgeSweepStep(o) {
  const item = o.overload ? 'V-T43 ②' : 'V-T43 ①';
  const invalid = (why) => ({ item, verdict: 'invalid', valid: false, invalid_reason: why, reasons: [why] });
  if (!o.limitsLoaded) return invalid('상한이 실리지 않음');
  if (o.workersError) return invalid(o.workersError);
  if (o.statsError || !o.stats) return invalid(`통계를 못 읽음: ${o.statsError ?? '표본 없음'}`);
  const m = o.m;
  if (!m || !(m.sent > 0)) return invalid('보낸 요청 0건');
  const dropped = o.generator?.dropped;
  if (!Number.isSafeInteger(dropped)) return invalid('발생기 dropped_iterations를 모름');
  if (dropped >= 1) return invalid(`발생기가 반복을 시작하지 못함(dropped_iterations ${dropped})`);
  if (!o.generator?.valid) return invalid(`발생기 무효: ${(o.generator?.reasons ?? []).join('; ') || '까닭 모름'}`);
  for (const x of o.mAll && o.mAll !== m ? [m, o.mAll] : [m]) {
    const out = outsideResponses(x, '503');
    if (out) return invalid(out);
  }
  const n503 = m.status['503'];
  if (o.overload && n503 === 0) return invalid('과부하인데 503 0건');
  const p99 = m.latency['503'].p99;
  if (o.overload && n503 > 0 && typeof p99 === 'number' && p99 > FAST_FAIL_MS && o.accessLog?.lines > 0 && o.accessLog.p99 !== null && o.accessLog.p99 <= FAST_FAIL_MS)
    return invalid(`측정 지점 의심(발생기 503 p99 ${p99}ms, 접근 로그 p99 ${o.accessLog.p99}ms)`);
  const reasons = [];
  const ra = m.retryAfter['503'];
  if (ra.missing > 0) reasons.push(`Retry-After 없는 503 ${ra.missing}건`);
  if (ra.nonnum > 0) reasons.push(`Retry-After가 숫자가 아닌 503 ${ra.nonnum}건`);
  if (n503 > 0 && ra.num + ra.missing + ra.nonnum !== n503) reasons.push(`Retry-After를 본 503 수(${ra.num + ra.missing + ra.nonnum})가 503 수(${n503})와 다르다`);
  const pr = m.problem['503'];
  if (pr.bad > 0) reasons.push(`Problem 본문이 틀린 503 ${pr.bad}건`);
  if (n503 > 0 && pr.ok + pr.bad !== n503) reasons.push(`본문을 본 503 수(${pr.ok + pr.bad})가 503 수(${n503})와 다르다`);
  if (o.stats.rqActiveMax > o.step.maxParallelRequests) reasons.push(`처리 중 최대 ${o.stats.rqActiveMax}가 동시 상한 ${o.step.maxParallelRequests}를 넘음`);
  if (!o.overload) {
    if (n503 > 0) reasons.push(`정상 부하에서 503 ${n503}건`);
    if (o.stats.overflowTotal > 0) reasons.push(`Envoy 넘침 ${o.stats.overflowTotal}(${Object.entries(o.stats.overflow).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  } else {
    if (typeof p99 !== 'number') reasons.push('503 p99 없음');
    else if (p99 > FAST_FAIL_MS) reasons.push(`503 p99 ${p99}ms(${FAST_FAIL_MS}ms 초과)`);
  }
  return { item, verdict: reasons.length ? 'fail' : 'pass', valid: true, invalid_reason: null, reasons };
}

/**
 * 흐름 여럿을 보낸 단계의 판정(docs/infra.md §4.1 '측정(V-T43)', 추천 적용 2026-11-18, BAT-056 R7·R2).
 * - 정상 부하(①): 보낸 흐름 모두를 합쳐 판정한다(503 0건은 세 흐름 합). 재는 흐름 가운데 보낸 수 0인 것이 있으면 무효
 * - 과부하(②): 재는 흐름(targets)마다 판정해 하나라도 무효면 그 무효, 아니면 하나라도 실패면 실패(흐름이 둘 이상이면 까닭 앞에 흐름 이름)
 * - 2xx·503 밖의 응답은 보낸 흐름 모두에서 본다(R2)
 * 입력: { step, overload, limitsLoaded, workersError?, statsError?, stats?, streams: { <흐름>: streamMetrics 결과 }, targets: string[], generator, accessLogs?: { <흐름>: accessLogDurations 결과 } }
 */
export function judgeSweepStreams(o) {
  const names = Object.keys(o.streams ?? {});
  const all = names.length ? combineMetrics(names.map((n) => o.streams[n])) : null;
  const base = { step: o.step, overload: o.overload, limitsLoaded: o.limitsLoaded, workersError: o.workersError, statsError: o.statsError, stats: o.stats, generator: o.generator };
  const targets = o.targets ?? [];
  const missing = targets.filter((n) => !o.streams?.[n]);
  if (missing.length || !all) return judgeSweepStep({ ...base, m: null });
  const zero = targets.find((n) => !(o.streams[n].sent > 0));
  if (zero) return judgeSweepStep({ ...base, m: o.streams[zero] });
  if (!o.overload) return judgeSweepStep({ ...base, m: all, mAll: all, accessLog: null });
  const js = targets.map((n) => [n, judgeSweepStep({ ...base, m: o.streams[n], mAll: all, accessLog: o.accessLogs?.[n] ?? null })]);
  const bad = js.find(([, j]) => !j.valid);
  if (bad) return bad[1];
  const many = js.length > 1;
  const reasons = [...new Set(js.flatMap(([n, j]) => j.reasons.map((r) => (many && !r.startsWith('처리 중 최대') ? `${n}: ${r}` : r))))];
  return { item: 'V-T43 ②', verdict: reasons.length ? 'fail' : 'pass', valid: true, invalid_reason: null, reasons };
}

/**
 * 성능 장부 점검(collect.py --checks, docs/perf-ledger.md §2.2 checks, 추천 적용 2026-11-18, BAT-056 R1).
 * '0건' 목표(정상 부하 503, 503의 Retry-After·Problem 빠짐)는 장부 도구가 받는 꼴(0 < allowed < 1, 시행 수 ≥ 1)이 아니라 점검으로 넣지 않고
 * 판정(--verdict)과 notes로 넘긴다. 점검은 과부하의 '503 응답 시간 p99 ≤ 3ms' 하나(<흐름>_503_p99_3ms, allowed 0.01, 시행 수 503 수,
 * 어김 FAST_FAIL_MS 넘은 503 수)이고 503이 0건이면 만들지 않는다
 * @returns {{ checks: Array<{ name: string, allowed: number, trials: number, violations: number, target: string }> }}
 */
export function sweepChecks(stream, overload, m) {
  const n503 = m?.status?.['503'] ?? 0;
  if (!overload || !(n503 >= 1)) return { checks: [] };
  return { checks: [{ name: `${stream}_503_p99_${FAST_FAIL_MS}ms`, allowed: 0.01, trials: n503, violations: Math.min(n503, m.overFast), target: `${stream} 게이트웨이 503 p99 ≤ ${FAST_FAIL_MS}ms(V-T43 ②)` }] };
}

/**
 * SR-T13 ② 판정(docs/features/search.md §12 '측정 판정'). 입력: { case, mainS, replicas(프록시 복제 수), streams: { <흐름>: streamMetrics 결과 }, generator }
 * - single·mixed의 한 IP 흐름 'one': 통과(2xx) ≤ 50 × (mainS + 1) × replicas, 넘은 요청(429) 모두 Retry-After(숫자)
 * - many: 429 0건(그 밖은 'one'이 없다). mixed의 'pool'은 관찰만(판정에 넣지 않는다)
 * - v6-64: 판정하지 않는다(관찰, verdict 'observe')
 * 무효: 보낸 수 0, 발생기 무효·dropped ≥ 1, 어느 흐름이든 2xx·429 밖의 응답이 한 건이라도 있음(R2), 'one'이 한도를 넘겨 보냈는데 429 0건
 * @returns {{ verdict: 'pass'|'fail'|'invalid'|'observe', valid, invalid_reason, reasons, cap?: number }}
 */
export function judgeIpLimit(o) {
  const invalid = (why) => ({ verdict: 'invalid', valid: false, invalid_reason: why, reasons: [why] });
  if (!Number.isSafeInteger(o.replicas) || o.replicas < 1) return invalid('프록시 복제 수를 모름');
  const names = Object.keys(o.streams ?? {});
  if (!names.length || names.some((n) => !(o.streams[n].sent > 0))) return invalid('보낸 요청 0건');
  const dropped = o.generator?.dropped;
  if (!Number.isSafeInteger(dropped)) return invalid('발생기 dropped_iterations를 모름');
  if (dropped >= 1) return invalid(`발생기가 반복을 시작하지 못함(dropped_iterations ${dropped})`);
  if (!o.generator?.valid) return invalid(`발생기 무효: ${(o.generator?.reasons ?? []).join('; ') || '까닭 모름'}`);
  // 2xx·429 밖의 응답(403·404·503·연결 실패 등)은 한도에 닿기 전에 막힌 것이라 무대의 잘못으로 보고 다시 잰다(R2, docs/features/search.md SR-T13 ② '측정 판정')
  for (const n of names) {
    const out = outsideResponses(o.streams[n], '429');
    if (out) return invalid(`${n}: ${out}`);
  }
  if (o.case === 'v6-64') return { verdict: 'observe', valid: true, invalid_reason: null, reasons: [] };
  const reasons = [];
  const cap = SEARCH_PER_IP_PER_S * (o.mainS + 1) * o.replicas;
  if (o.case === 'many') {
    const s = o.streams.many;
    if (s.status['429'] > 0) reasons.push(`서로 다른 IP가 한도 아래로 보냈는데 429 ${s.status['429']}건`);
  } else {
    const s = o.streams.one;
    if (!s) return invalid('한 IP 흐름이 없다');
    if (s.status['429'] === 0) return invalid('한 IP가 한도를 넘겨 보냈는데 429 0건');
    if (s.status['2xx'] > cap) reasons.push(`한 IP의 통과 ${s.status['2xx']}건이 상한 ${cap}(50 × (${o.mainS} + 1) × ${o.replicas})을 넘음`);
    const ra = s.retryAfter['429'];
    if (ra.missing > 0) reasons.push(`Retry-After 없는 429 ${ra.missing}건`);
    if (ra.nonnum > 0) reasons.push(`Retry-After가 숫자가 아닌 429 ${ra.nonnum}건`);
    if (ra.num + ra.missing + ra.nonnum !== s.status['429']) reasons.push(`Retry-After를 본 429 수(${ra.num + ra.missing + ra.nonnum})가 429 수(${s.status['429']})와 다르다`);
  }
  return { verdict: reasons.length ? 'fail' : 'pass', valid: true, invalid_reason: null, reasons, cap };
}

/**
 * 포화 처리량(계획 §5 M1): 단계(도착률 오름차순)마다 { rate, valid, proxyCpuPct, p99Ms }. 처음 포화한 단계(프록시 CPU ≥ 90% 또는 p99 − 고정 지연 > 3ms)의
 * 바로 앞 단계 도착률 ÷ 프록시 CPU를 'vCPU 하나의 포화 처리량'으로 둔다(선형 [추정]). 무효 단계를 만나면 거기서 멈춘다(그 위는 모름).
 * 결과: { perVcpu: number|null, saturatedAt: number|null, topReached: boolean, stoppedAt?: number(무효 단계) }
 */
export function saturation(steps, proxyCpusValue, fixedDelayMs) {
  let last = null;
  for (const s of steps) {
    if (!s.valid) return { perVcpu: last === null ? null : last / proxyCpusValue, saturatedAt: null, topReached: false, stoppedAt: s.rate };
    const sat = s.proxyCpuPct >= SATURATION_CPU_PCT || !(typeof s.p99Ms === 'number') || s.p99Ms - fixedDelayMs > SATURATION_EXTRA_MS;
    if (sat) return { perVcpu: last === null ? null : last / proxyCpusValue, saturatedAt: s.rate, topReached: false };
    last = s.rate;
  }
  return { perVcpu: last === null ? null : last / proxyCpusValue, saturatedAt: null, topReached: last !== null };
}

/**
 * 성능 장부 실행 ID: <접두>-<명령>-<단계 번호 두 자리>(sweep은 -p<동시>-q<보류>-r<되풀이>, capacity는 -r<도착률>, ip-limit은 -<경우>).
 * 결과가 RUN_ID 꼴(^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,80}$)을 넘으면 Error
 */
export function runIdOf(prefix, sub, part) {
  const id = `${prefix}-${sub === 'ip-limit' ? 'ip' : sub}-${part}`;
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,80}$/.test(id)) throw new Error(`실행 ID 꼴이 틀렸다: ${id}`);
  return id;
}

/**
 * k6 콘솔(발생기 하나의 console.ndjson)에서 구간 표시와 Retry-After 값 기록: { marks: { main_start?, main_end? }, retryAfterValues: { '<cls>': Set<string> } }.
 * 줄 꼴: { kind: 'mark', name, at_ms }, { kind: 'gw_ra', cls, value }. JSON이 아닌 줄·모르는 종류는 Error
 */
export function gwConsole(text) {
  const marks = {};
  const values = {};
  String(text ?? '')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) return;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        throw new Error(`발생기 콘솔 ${i + 1}번째 줄이 JSON이 아니다`);
      }
      if (o?.kind === 'mark' && (o.name === 'main_start' || o.name === 'main_end') && Number.isSafeInteger(o.at_ms)) marks[o.name] = o.at_ms;
      else if (o?.kind === 'gw_ra' && typeof o.cls === 'string' && typeof o.value === 'string') (values[o.cls] ??= new Set()).add(o.value);
      else throw new Error(`발생기 콘솔 ${i + 1}번째 줄: 모르는 종류`);
    });
  return { marks, retryAfterValues: values };
}

/**
 * 시나리오 입력(gw.json, 파드의 /work/gw.json): { origin, originVerify, hosts: { <호스트 이름>: <프록시 Service 주소> }, fastFailMs, eventId, streams: [...] }.
 * 흐름 = { name, host(호스트 이름), method, path({id}를 eventId로 바꾼 것), token, rate, delay, ip, preVUs, maxVUs, expect: { status(게이트웨이가 낼 상태), title } }
 * @param {{ streams: object[], rate: number, delay: object, origin: string, originVerify: string, hostNames: Record<string, string>, serviceIps: Record<string, string>, eventId: string, memoryMi: number, generators: number }} o
 */
export function scenarioInput(o) {
  const streams = [];
  const hosts = {};
  for (const s of o.streams) {
    const rate = rateOf(s, o.rate);
    if (rate < 1) continue;
    const host = o.hostNames[s.host];
    if (!host) throw new Error(`접속 정보 hosts에 ${s.host}가 없다`);
    const ip = o.serviceIps[s.gateway];
    if (!ip) throw new Error(`${s.gateway} 프록시 Service 주소가 없다`);
    hosts[host] = ip;
    // 지연이 긴 단계는 한 번에 쥐는 가상 사용자가 많다: 도착률 × (최대 지연 + 50ms) × 1.5, 하한 20. 메모리 몫(가상 사용자 하나 2Mi [가정])으로 자른다
    const d = s.target ? o.delay : { kind: 'normal' };
    const maxDelay = d.kind === 'fixed' ? d.ms : Math.max(...NORMAL_DELAY.map((x) => x.ms));
    const memCap = Math.max(50, Math.floor(((o.memoryMi * 0.6) / 2) * o.generators));
    const preVUs = Math.min(memCap, Math.max(20, Math.ceil(rate * ((maxDelay + 50) / 1000) * 1.5)));
    streams.push({
      name: s.name,
      host,
      method: s.method,
      path: s.path.replaceAll('{id}', o.eventId),
      token: s.token,
      rate,
      // 지연은 재는 흐름(target)에만 준 꼴을 쓰고, 정상 부하의 다른 흐름은 정본 분포 그대로다(계획 §5 M-C: 진입의 지연만 바꾼다)
      delay: s.target ? o.delay : { kind: 'normal' },
      ip: s.ip,
      preVUs,
      maxVUs: Math.min(memCap, Math.max(preVUs * 4, 200)),
      expect: s.name === 'search' || s.route === 'gw-fan-search' ? { status: 429, title: 'Too Many Requests' } : { status: 503, title: 'Service Unavailable' },
    });
  }
  if (!streams.length) throw new Error('보낼 흐름이 없다(도착률 0)');
  return { origin: o.origin, originVerify: o.originVerify, hosts, fastFailMs: FAST_FAIL_MS, normalDelay: NORMAL_DELAY, streams };
}

// ---- gw limits: 여유 배수 k와 운영 차단 상한(ADR-0287 결정 6·7, docs/infra.md §4.1 '값의 식'·'측정(V-T43)' 끝 ④⑤, 묶음 BAT-058) ----
// 정본 값이라 도구 상수로 둔다(시험은 가져오지 않는다): R_pod = 0.6 × 포화 처리량 × 파드 CPU, L_gw는 gw-queue 200ms(NFR-001 p99)·나머지 넷 500ms(NFR-011 p95),
// 보류 = ⌈동시 ÷ 8⌉(q = 1/8), k는 0.1 단위 올림·하한 2, r_min은 3회 모두 통과(docs/infra.md §4.1 '값의 식'·'측정(V-T43)' ④).
// 셈은 정수로 하고 마지막에 한 번만 올린다(k는 0.1 단위 정수 k10, 지연은 마이크로초 정수, L_gw는 밀리초. 소수 곱셈의 끝자리 오차로 하나 커지지 않게).
const R_POD_NUM = 6;
const R_POD_DEN = 10;
const L_GW_MS = Object.freeze({ 'gw-queue': 200, others: 500 });
const PENDING_DIV = 8;
const K10_MIN = 20;
const RMIN_RUNS = 3;
const LIMITS_GATEWAY = 'gw-queue';
const LIMITS_ROUTE = 'gw-queue-buy';
/**
 * 되돌릴 조건(ADR-0287 '되돌릴 조건'·결정 7 끝, docs/infra.md §4.1 '측정(V-T43)' ⑤, BAT-058 리뷰 반영 RV-03): 올리기 전 k가 이 값 이상이면
 * (정수로 견줌: r_min × 1,000,000 ≥ K_ROLLBACK × 도착률 × L̄µs, 경계는 넘은 쪽) 상한을 내지 않고 끝 코드 1
 */
const K_ROLLBACK = 5;

/** 양의 정수 나눗셈의 올림(BigInt로 정확히) */
const ceilDiv = (a, b) => {
  const A = BigInt(a);
  const B = BigInt(b);
  return Number((A + B - 1n) / B);
};
const verdictOf = (s) => (s?.valid === true && (s.verdict === 'pass' || s.verdict === 'fail') ? s.verdict : 'invalid');

/**
 * gw limits의 입력(sweep.json 여럿)을 단계 목록으로 풀고 섞인 입력을 가른다. files = [{ path, data(sweep.json 객체) }].
 * 하나라도 어기면 reasons에 까닭을 한 줄씩(조용히 버리지 않는다): gw sweep 결과가 아님, 게이트웨이·라우트가 gw-queue gw-queue-buy가 아님,
 * 정상 부하(mix normal·delay normal)가 아닌 파일·단계(과부하 단계 포함), 단계가 없음, 연결 ≠ 동시, 보류 ≠ ⌈동시 ÷ 8⌉, 도착률이 없거나 단계끼리 다름,
 * 판정이 pass·fail·invalid가 아님. 무효 단계(valid가 true가 아니거나 verdict invalid)도 설정은 같은 규칙으로 본다.
 * o.podCpus가 있으면 유효 단계(통과·실패)마다 결과 줄 workers.pods의 값이 하나 이상 있고 모두 o.podCpus와 같아야 한다(일꾼 수 = 파드 CPU, ADR-0287 결정 2·6).
 * 다르거나, workers 칸이 없거나(옛 결과 파일), pods가 비었으면 섞인 입력이다(BAT-058 리뷰 반영 RV-04). 무효 단계는 보지 않는다(부하를 넣지 않았다).
 * 단계의 진입 2xx 평균은 단계 줄의 streams.entry.latency2xx.avg다
 * @param {Array<{ path: string, data: any }>} files @param {{ podCpus?: number }} [o]
 * @returns {{ steps: Array<{ file: string, index: number, parallel: number, verdict: 'pass'|'fail'|'invalid', avg: number|null }>, rate: number|null, reasons: string[] }}
 */
export function limitsSteps(files, o = {}) {
  const reasons = [];
  const steps = [];
  const rates = new Set();
  for (const f of files ?? []) {
    const at = f?.path ?? '(이름 없는 파일)';
    const d = f?.data;
    if (d?.command !== 'gw sweep') {
      reasons.push(`${at}: gw sweep 결과가 아니다(command ${JSON.stringify(d?.command)})`);
      continue;
    }
    if (d.gateway !== LIMITS_GATEWAY || d.route !== LIMITS_ROUTE) reasons.push(`${at}: 게이트웨이·라우트가 ${d.gateway} ${d.route}다(${LIMITS_GATEWAY} ${LIMITS_ROUTE}이어야 한다)`);
    if (d.mix !== 'normal' || d.delay !== 'normal') reasons.push(`${at}: 정상 부하가 아니다(mix ${d.mix}, delay ${d.delay})`);
    if (!Array.isArray(d.steps) || d.steps.length === 0) {
      reasons.push(`${at}: 단계가 없다`);
      continue;
    }
    for (const [i, s] of d.steps.entries()) {
      const w = `${at} 단계 ${i + 1}`;
      if (s?.delay !== 'normal' || s?.mix !== 'normal' || s?.overload === true) reasons.push(`${w}: 정상 부하가 아니다(delay ${s?.delay}, mix ${s?.mix}${s?.overload === true ? ', 과부하' : ''})`);
      const p = s?.maxParallelRequests;
      if (!Number.isSafeInteger(p) || p < 1) {
        reasons.push(`${w}: 동시 상한이 1 이상 정수가 아니다(${JSON.stringify(p)})`);
        continue;
      }
      if (s.maxConnections !== p) reasons.push(`${w}: 연결 상한 ${s.maxConnections}이 동시 상한 ${p}와 다르다`);
      const q = ceilDiv(p, PENDING_DIV);
      if (s.maxPendingRequests !== q) reasons.push(`${w}: 보류 상한 ${s.maxPendingRequests}이 ⌈${p} ÷ ${PENDING_DIV}⌉ = ${q}가 아니다`);
      if (!Number.isSafeInteger(s.rate) || s.rate < 1) reasons.push(`${w}: 도착률이 1 이상 정수가 아니다(${JSON.stringify(s.rate)})`);
      else rates.add(s.rate);
      if (!['pass', 'fail', 'invalid'].includes(s.verdict)) reasons.push(`${w}: 판정이 pass·fail·invalid가 아니다(${JSON.stringify(s.verdict)})`);
      const verdict = verdictOf(s);
      if (o.podCpus !== undefined && verdict !== 'invalid') {
        const pods = s.workers?.pods;
        const names = pods && typeof pods === 'object' ? Object.keys(pods).sort() : [];
        if (!names.length) reasons.push(`${w}: 결과 줄에 읽은 일꾼 수(workers.pods)가 없다(일꾼 수를 보기 전의 결과 파일이거나 못 읽음)`);
        else {
          const bad = names.filter((n) => pods[n] !== o.podCpus);
          if (bad.length) reasons.push(`${w}: 읽은 일꾼 수가 --pod-cpus ${o.podCpus}와 다르다(${bad.map((n) => `${n} ${JSON.stringify(pods[n])}`).join(', ')})`);
        }
      }
      const avg = s.streams?.entry?.latency2xx?.avg;
      steps.push({ file: at, index: i, parallel: p, verdict, avg: Number.isFinite(avg) ? avg : null });
    }
  }
  if (rates.size > 1) reasons.push(`단계의 도착률이 서로 다르다(${[...rates].sort((a, b) => a - b).join(', ')}/s)`);
  return { steps, rate: rates.size === 1 ? [...rates][0] : null, reasons };
}

/**
 * r_min(정상 부하 503 0건이 되는 가장 작은 동시 상한, ADR-0287 결정 6): 후보(동시 상한)마다 유효 단계의 통과·실패와 무효 수를 센다(무효는 통과로도 실패로도 세지 않는다).
 * '한 번이라도 실패한 가장 큰 후보'의 바로 위 후보(잰 후보 가운데)가 c이고, c의 유효 단계가 3개 이상이고 모두 통과면 r_min = c다.
 * 정하지 못하는 경우(rMin null, reasons·next에 까닭과 다음 할 일): 통과한 단계가 하나도 없음, 실패가 없음(가장 작은 후보부터 통과 → 더 작은 후보를 잰다),
 * 실패한 가장 큰 후보 위를 재지 않음, c의 유효 단계가 3개 미만(c에서 모자란 만큼 더 잰다)
 * @param {Array<{ parallel: number, verdict: 'pass'|'fail'|'invalid' }>} steps
 * @returns {{ runs: Record<string, { pass: number, fail: number, invalid: number }>, rMin: number|null, reasons: string[], next: string[] }}
 */
export function limitsRMin(steps) {
  const by = new Map();
  for (const s of steps ?? []) {
    const r = by.get(s.parallel) ?? { pass: 0, fail: 0, invalid: 0 };
    r[s.verdict === 'pass' || s.verdict === 'fail' ? s.verdict : 'invalid']++;
    by.set(s.parallel, r);
  }
  const cands = [...by.keys()].sort((a, b) => a - b);
  const runs = Object.fromEntries(cands.map((c) => [String(c), by.get(c)]));
  const no = (reason, next) => ({ runs, rMin: null, reasons: [reason], next: [next] });
  if (!cands.some((c) => by.get(c).pass > 0)) return no('통과한 단계가 하나도 없다', cands.length ? `동시 상한 ${cands.at(-1)}보다 큰 후보를 잰다` : '후보를 잰다');
  const failed = cands.filter((c) => by.get(c).fail > 0);
  if (!failed.length) return no(`실패한 후보가 없다(가장 작은 후보 ${cands[0]}부터 통과해 경계를 모른다)`, `동시 상한 ${cands[0]}보다 작은 후보를 잰다`);
  const top = failed.at(-1);
  const c = cands.find((x) => x > top);
  if (c === undefined) return no(`실패한 가장 큰 후보 ${top} 위의 후보를 재지 않았다`, `동시 상한 ${top}보다 큰 후보를 잰다`);
  const r = by.get(c);
  if (r.pass < RMIN_RUNS) return no(`경계 후보 ${c}(실패한 가장 큰 후보 ${top}의 바로 위)의 유효 단계가 ${r.pass}개다(${RMIN_RUNS}개 모두 통과해야 한다)`, `동시 상한 ${c}에서 ${RMIN_RUNS - r.pass}번 더 잰다`);
  return { runs, rMin: c, reasons: [], next: [] };
}

/**
 * k·r_pc·운영 상한(ADR-0287 결정 7, docs/infra.md §4.1 '값의 식'). 입력은 모두 1 이상 정수: rMin, meanLatencyUs(평균 지연 마이크로초), rate(진입 도착률 /s),
 * saturation(vCPU 하나의 포화 처리량 /s), podCpus(파드 CPU 코어). 아니면 RangeError.
 * k10 = max(20, ⌈10 × rMin × 1,000,000 ÷ (rate × meanLatencyUs)⌉), k = k10 ÷ 10,
 * 동시 = 연결 = ⌈k10 × 6 × saturation × podCpus × L_gw(ms) ÷ 100,000⌉, 보류 = ⌈동시 ÷ 8⌉, r_pc = ⌈k10 × rate × meanLatencyUs ÷ 10,000,000⌉.
 * kRaw는 올리기 전 k(소수 넷째 자리 반올림, 보이기용이고 되돌릴 조건은 gwLimits가 정수로 견준다), rPod는 0.6 × saturation × podCpus
 */
export function limitsValues(o) {
  for (const k of ['rMin', 'meanLatencyUs', 'rate', 'saturation', 'podCpus']) if (!Number.isSafeInteger(o?.[k]) || o[k] < 1) throw new RangeError(`${k}는 1 이상 정수다: ${o?.[k]}`);
  const den = o.rate * o.meanLatencyUs;
  const k10 = Math.max(K10_MIN, ceilDiv(10 * o.rMin * 1_000_000, den));
  const lim = (lgwMs) => {
    const p = ceilDiv(k10 * R_POD_NUM * o.saturation * o.podCpus * lgwMs, R_POD_DEN * 10 * 1000);
    return { maxConnections: p, maxParallelRequests: p, maxPendingRequests: ceilDiv(p, PENDING_DIV) };
  };
  return {
    kRaw: Math.round(((o.rMin * 1_000_000) / den) * 10000) / 10000,
    k10,
    k: k10 / 10,
    rPod: (R_POD_NUM * o.saturation * o.podCpus) / R_POD_DEN,
    rPc: ceilDiv(k10 * o.rate * o.meanLatencyUs, 10 * 1_000_000),
    limits: { 'gw-queue': lim(L_GW_MS['gw-queue']), others: lim(L_GW_MS.others) },
  };
}

/**
 * gw limits 전체(파일 읽기 밖의 모든 것): 입력 거르기(limitsSteps) → r_min(limitsRMin) → 평균 지연 L̄ → k와 운영 상한(limitsValues).
 * L̄은 r_min의 유효 단계(모두 통과) 진입 2xx avg의 평균을 마이크로초 정수로 반올림한 값이다(한 단계라도 avg가 null이면 정하지 못함).
 * o = { saturation, podCpus, paths?(입력 파일 이름, 없으면 files의 path), readErrors?(파일을 못 읽은 까닭들. 있으면 정하지 못함) }.
 * 결과(limits.json): { command: 'gw limits', determined, inputs: { files, saturation, podCpus, rate }, constants, runs, rMin, meanLatencyUs, meanLatencyMs,
 *   kRaw, k, rPod, rPc, limits: { 'gw-queue': { maxConnections, maxParallelRequests, maxPendingRequests }, others: {…} } | null, rollback, reasons, next, warnings }.
 * 정하지 못하면 determined false이고 정하지 못한 값 칸은 null, reasons에 까닭, next에 더 재야 할 것.
 * 유효 단계에서 읽은 일꾼 수가 o.podCpus와 다르면 정하지 못한다(limitsSteps, RV-04).
 * 되돌릴 조건(RV-03): 올리기 전 k가 5 이상이면(정수로 견줌: rMin × 1,000,000 ≥ 5 × 도착률 × L̄µs) determined false, rollback true, limits·k·rPc null이고
 * reasons에 '운영 값에 쓰지 않음'과 견준 두 정수를 남긴다(잰 rMin·L̄·kRaw는 남긴다). 그 밖에는 rollback false
 */
export function gwLimits(files, o) {
  const base = {
    command: 'gw limits',
    determined: false,
    inputs: { files: [...(o?.paths ?? (files ?? []).map((f) => f.path))], saturation: o?.saturation ?? null, podCpus: o?.podCpus ?? null, rate: null },
    constants: { rPodShare: R_POD_NUM / R_POD_DEN, lGwMs: { ...L_GW_MS }, pendingDivisor: PENDING_DIV, kMin: K10_MIN / 10, kStep: 0.1, rMinRuns: RMIN_RUNS },
    runs: {},
    rMin: null,
    meanLatencyUs: null,
    meanLatencyMs: null,
    kRaw: null,
    k: null,
    rPod: null,
    rPc: null,
    limits: null,
    rollback: false,
    reasons: [],
    next: [],
    warnings: [],
  };
  if (o?.readErrors?.length) return { ...base, reasons: [...o.readErrors], next: ['파일 경로를 고쳐 다시 돌린다'] };
  const input = limitsSteps(files, { podCpus: o?.podCpus });
  if (input.reasons.length)
    return { ...base, reasons: input.reasons, next: [`정상 부하 gw-queue gw-queue-buy, 같은 도착률, 연결 = 동시, 보류 = ⌈동시 ÷ 8⌉이고 유효 단계의 읽은 일꾼 수가 모두 --pod-cpus ${o?.podCpus}인 sweep.json만 준다`] };
  const r = limitsRMin(input.steps);
  const withRuns = { ...base, inputs: { ...base.inputs, rate: input.rate }, runs: r.runs };
  if (r.rMin === null) return { ...withRuns, reasons: r.reasons, next: r.next };
  const at = input.steps.filter((s) => s.parallel === r.rMin && s.verdict === 'pass');
  if (at.some((s) => s.avg === null))
    return { ...withRuns, rMin: r.rMin, reasons: [`r_min ${r.rMin}의 유효 단계에 진입 2xx 평균(streams.entry.latency2xx.avg)이 없는 것이 있다(발생기마다의 요약을 못 읽음)`], next: [`동시 상한 ${r.rMin}에서 다시 잰다`] };
  const meanLatencyUs = Math.round((at.reduce((s, x) => s + x.avg, 0) / at.length) * 1000);
  if (meanLatencyUs < 1) return { ...withRuns, rMin: r.rMin, reasons: [`r_min ${r.rMin}의 진입 2xx 평균이 1µs보다 작다(${meanLatencyUs}µs)`], next: [`동시 상한 ${r.rMin}에서 다시 잰다`] };
  const v = limitsValues({ rMin: r.rMin, meanLatencyUs, rate: input.rate, saturation: o.saturation, podCpus: o.podCpus });
  const measured = { rMin: r.rMin, meanLatencyUs, meanLatencyMs: meanLatencyUs / 1000, kRaw: v.kRaw, rPod: v.rPod };
  // 되돌릴 조건은 올리기 전 k를 정수로 견준다(반올림한 kRaw로 견주면 5.0002가 5로 보인다)
  const lhs = BigInt(r.rMin) * 1_000_000n;
  const rhs = BigInt(K_ROLLBACK) * BigInt(input.rate) * BigInt(meanLatencyUs);
  if (lhs >= rhs)
    return {
      ...withRuns,
      ...measured,
      rollback: true,
      reasons: [
        `올리기 전 k(${r.rMin} ÷ (${input.rate} × ${meanLatencyUs}µs) ≈ ${v.kRaw})가 ${K_ROLLBACK} 이상이다(정수로 견줌: ${lhs} ≥ ${rhs}). ADR-0287 '되돌릴 조건': 운영 값에 쓰지 않음, 상한을 내지 않는다`,
      ],
      next: ['운영 값을 고치지 않고 감독에게 알린다(ADR-0287 대안 4·5를 새 ADR로 다시 본다)'],
    };
  return { ...withRuns, ...measured, determined: true, k: v.k, rPc: v.rPc, limits: v.limits };
}

/** gw limits 결과의 콘솔 글(한국어 몇 줄) */
export function limitsLines(r) {
  const lines = [`입력 ${r.inputs.files.length}개, 포화 처리량 ${r.inputs.saturation}/s(vCPU 하나), 파드 CPU ${r.inputs.podCpus}, 진입 도착률 ${r.inputs.rate ?? '(모름)'}/s`];
  const runs = Object.entries(r.runs ?? {});
  if (runs.length) lines.push(`후보(동시 상한)마다 통과·실패·무효: ${runs.map(([c, x]) => `${c} ${x.pass}·${x.fail}·${x.invalid}`).join(', ')}`);
  if (!r.determined) {
    if (r.rMin !== null && r.meanLatencyMs !== null) lines.push(`r_min ${r.rMin}, 평균 지연 ${r.meanLatencyMs}ms, 올리기 전 k ${r.kRaw}`);
    lines.push(r.rollback ? '되돌릴 조건에 걸려 상한을 내지 않는다(운영 값에 쓰지 않음):' : '정하지 못했다:');
    for (const x of r.reasons) lines.push(`  까닭: ${x}`);
    for (const x of r.next) lines.push(`  다음: ${x}`);
    return lines;
  }
  const q = r.limits['gw-queue'];
  const o = r.limits.others;
  lines.push(`r_min ${r.rMin}, 평균 지연 ${r.meanLatencyMs}ms, k ${r.k}(올리기 전 ${r.kRaw}), R_pod ${r.rPod}/s, r_pc ${r.rPc}`);
  lines.push(`gw-queue 동시·연결 ${q.maxParallelRequests}·보류 ${q.maxPendingRequests}, 나머지 넷 동시·연결 ${o.maxParallelRequests}·보류 ${o.maxPendingRequests}`);
  for (const x of r.warnings) lines.push(`주의: ${x}`);
  return lines;
}
