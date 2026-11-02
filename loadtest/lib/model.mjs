// 오픈 모델 구성과 대기자 조회 도착률(docs/verification.md §3.4·§3.5·§3.9). k6 시나리오와 Node 시험이 같은 파일을 읽는다.
// 시각은 모두 부르는 쪽이 넘긴다(시계 주입).

/**
 * 서버의 대기 상태 조회 간격 표(queue-admission §13 동작 2): 예상 대기(초) 60 이하 500ms, 300 이하 5,000ms, 그 밖 20,000ms
 */
export const POLL_TABLE = Object.freeze([
  Object.freeze({ maxEtaS: 60, intervalMs: 500 }),
  Object.freeze({ maxEtaS: 300, intervalMs: 5000 }),
  Object.freeze({ maxEtaS: Infinity, intervalMs: 20000 }),
]);
/** 차례가 온 사람을 0.5초 묶음에 넣는 창(초) [가정] */
export const CALLED_WINDOW_S = 5;
/** 조회 도착률을 다시 계산하는 칸(초) [가정] */
export const STEP_S = 10;
/** 경로 꼬리표 이름 규칙 */
export const ROUTE_PATTERN = /^[a-z][a-z_]{0,31}$/;

const posInt = (v, name) => {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name}는 1 이상 정수다: ${v}`);
  return v;
};

const nonNegInt = (v, name) => {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name}는 0 이상 정수다: ${v}`);
  return v;
};

const unit = (u, name) => {
  if (typeof u !== 'number' || !(u >= 0 && u < 1)) throw new RangeError(`${name}는 [0, 1) 난수다: ${u}`);
  return u;
};

const queueOpts = (o) => {
  posInt(o?.users, 'users');
  posInt(o?.entryRate, 'entryRate');
  posInt(o?.admitPerSecond, 'admitPerSecond');
  return o;
};

const finiteT = (tS) => {
  if (typeof tS !== 'number' || !Number.isFinite(tS)) throw new RangeError(`시각은 유한수다: ${tS}`);
  return tS;
};

const name = (v, what) => {
  if (typeof v !== 'string' || v.length === 0) throw new RangeError(`${what}는 비지 않은 이름이다`);
  return v;
};

const vus = (o) => {
  posInt(o.preVUs, 'preVUs');
  posInt(o.maxVUs, 'maxVUs');
  if (o.maxVUs < o.preVUs) throw new RangeError('maxVUs는 preVUs 이상이다');
};

function stagesSeconds(stages) {
  if (!Array.isArray(stages)) throw new RangeError('단계는 목록이다');
  let sum = 0;
  for (const s of stages) {
    const d = /^(\d+)s$/.exec(s?.duration ?? '');
    if (!d || !Number.isInteger(s.target) || s.target < 0) throw new RangeError('단계는 { target: 0 이상 정수, duration: "<초>s" }다');
    sum += Number(d[1]);
  }
  return sum;
}

/**
 * 서버와 같은 기본 조회 간격(ms). eta = ahead ÷ max(ratePerS, 0.001); eta ≤ 60 → 500, ≤ 300 → 5000, 그 밖 → 20000.
 * ahead는 0 이상 정수, ratePerS는 0 이상 유한수(아니면 RangeError)
 * @param {number} ahead
 * @param {number} ratePerS
 * @returns {number}
 */
export function pollAfterMs(ahead, ratePerS) {
  nonNegInt(ahead, 'ahead');
  if (typeof ratePerS !== 'number' || !Number.isFinite(ratePerS) || ratePerS < 0) throw new RangeError(`속도는 0 이상 유한수다: ${ratePerS}`);
  const eta = ahead / Math.max(ratePerS, 0.001);
  return POLL_TABLE.find((row) => eta <= row.maxEtaS).intervalMs;
}

/**
 * 진입 시작부터 tS초 뒤 진입한 사람 수 = min(users, floor(entryRate × tS)). tS < 0이면 0.
 * users·entryRate·admitPerSecond는 1 이상 정수, tS는 유한수(아니면 RangeError, 아래 함수들도 같다)
 * @param {number} tS
 * @param {{ users: number, entryRate: number, admitPerSecond: number }} o
 */
export function enteredAt(tS, o) {
  queueOpts(o);
  finiteT(tS);
  if (tS < 0) return 0;
  return Math.min(o.users, Math.floor(o.entryRate * tS));
}

/**
 * tS초 뒤 serving 추정 = min(enteredAt(tS), floor(admitPerSecond × tS)). tS < 0이면 0
 * @param {number} tS
 * @param {{ users: number, entryRate: number, admitPerSecond: number }} o
 */
export function servingAt(tS, o) {
  const e = enteredAt(tS, o);
  if (tS < 0) return 0;
  return Math.min(e, Math.floor(o.admitPerSecond * tS));
}

/**
 * tS초 뒤 조회하는 사람 묶음. 사용자 i(0부터)의 순번은 i+1로 본다(진입 순서). e = enteredAt(tS), s = servingAt(tS), a = admitPerSecond.
 * - 500ms 묶음: [servingAt(tS − CALLED_WINDOW_S), min(e, s + floor(60 × a) + 1))  (차례가 온 지 5초 안 + 예상 대기 60초 이하. 차례가 온 시각으로 센다:
 *   모두 불린 뒤 5초가 지나면 이 묶음의 앞쪽은 빈다)
 * - 5,000ms 묶음: [s + floor(60 × a) + 1, min(e, s + floor(300 × a) + 1))
 * - 20,000ms 묶음: [s + floor(300 × a) + 1, e)
 * 빈 묶음(from ≥ to)은 빼고 { from, to, intervalMs }를 간격이 짧은 것부터 돌려준다
 * @param {number} tS
 * @param {{ users: number, entryRate: number, admitPerSecond: number }} o
 * @returns {Array<{ from: number, to: number, intervalMs: number }>}
 */
export function pollGroups(tS, o) {
  const e = enteredAt(tS, o);
  const s = servingAt(tS, o);
  const a = o.admitPerSecond;
  const nearEnd = s + Math.floor(60 * a) + 1;
  const midEnd = s + Math.floor(300 * a) + 1;
  const groups = [
    // 차례가 온 지 5초 안인 사람(차례가 온 시각으로 센다): 5초 전의 serving부터
    { from: servingAt(tS - CALLED_WINDOW_S, o), to: Math.min(e, nearEnd), intervalMs: 500 },
    { from: nearEnd, to: Math.min(e, midEnd), intervalMs: 5000 },
    { from: midEnd, to: e, intervalMs: 20000 },
  ];
  return groups.filter((g) => g.from < g.to);
}

/**
 * 묶음들이 내는 초당 조회 수 = Σ (to − from) × 1000 ÷ intervalMs
 * @param {Array<{ from: number, to: number, intervalMs: number }>} groups
 * @returns {number}
 */
export function pollRate(groups) {
  return groups.reduce((sum, g) => sum + ((g.to - g.from) * 1000) / g.intervalMs, 0);
}

/**
 * 묶음의 조회 도착률에 비례한 확률로 묶음을 고르고(u1), 그 안에서 고르게 한 사람을 고른다(u2): from + floor(u2 × (to − from)).
 * 묶음은 주어진 차례대로 [0, 1)에 이어 붙인다. u1·u2가 [0, 1)의 수가 아니면 묶음이 없어도 RangeError, 묶음이 없으면 −1
 * @param {Array<{ from: number, to: number, intervalMs: number }>} groups
 * @param {number} u1
 * @param {number} u2
 * @returns {number}
 */
export function pickPollUser(groups, u1, u2) {
  unit(u1, 'u1');
  unit(u2, 'u2');
  if (groups.length === 0) return -1;
  const total = pollRate(groups);
  let acc = 0;
  let chosen = groups[groups.length - 1];
  for (const g of groups) {
    acc += ((g.to - g.from) * 1000) / g.intervalMs;
    if (u1 * total < acc) {
      chosen = g;
      break;
    }
  }
  return chosen.from + Math.floor(u2 * (chosen.to - chosen.from));
}

/**
 * ramping-arrival-rate 단계. [startS, startS + durationS)를 stepS 칸으로 나누고(마지막 칸은 짧을 수 있다)
 * 칸마다 { target: 칸 끝 시각의 round(pollRate(pollGroups(t))), duration: '<칸 길이>s' }.
 * startRate = round(pollRate(pollGroups(startS))). startS ≥ 0, durationS ≥ 1, stepS ≥ 1 정수(stepS 기본 STEP_S, 아니면 RangeError)
 * @param {{ users: number, entryRate: number, admitPerSecond: number, startS: number, durationS: number, stepS?: number }} o
 * @returns {{ startRate: number, stages: Array<{ target: number, duration: string }> }}
 */
export function pollStages(o) {
  queueOpts(o);
  nonNegInt(o.startS, 'startS');
  posInt(o.durationS, 'durationS');
  const stepS = posInt(o.stepS ?? STEP_S, 'stepS');
  const rateAt = (t) => Math.round(pollRate(pollGroups(t, o)));
  const stages = [];
  for (let t = o.startS; t < o.startS + o.durationS; t += stepS) {
    const len = Math.min(stepS, o.startS + o.durationS - t);
    stages.push({ target: rateAt(t + len), duration: `${len}s` });
  }
  return { startRate: rateAt(o.startS), stages };
}

/**
 * 오픈 모델 두 구간(constant-arrival-rate): warm은 startS부터 warmS초, main은 그 뒤 mainS초.
 * 각 구간 = { executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: '<초>s', startTime: '<초>s',
 *   preAllocatedVUs: preVUs, maxVUs, exec, tags: { phase: 'warm'|'main' } }.
 * rate·warmS·mainS·preVUs·maxVUs는 1 이상 정수, maxVUs ≥ preVUs, startS는 0 이상 정수(기본 0), exec는 비지 않은 문자열(아니면 RangeError)
 * @returns {{ warm: object, main: object }}
 */
export function openPhases(o) {
  const exec = name(o.exec, 'exec');
  posInt(o.rate, 'rate');
  posInt(o.warmS, 'warmS');
  posInt(o.mainS, 'mainS');
  const startS = nonNegInt(o.startS ?? 0, 'startS');
  vus(o);
  const phase = (p, start, dur) => ({
    executor: 'constant-arrival-rate',
    rate: o.rate,
    timeUnit: '1s',
    duration: `${dur}s`,
    startTime: `${start}s`,
    preAllocatedVUs: o.preVUs,
    maxVUs: o.maxVUs,
    exec,
    tags: { phase: p },
  });
  return { warm: phase('warm', startS, o.warmS), main: phase('main', startS + o.warmS, o.mainS) };
}

/**
 * 단계가 바뀌는 도착률 두 구간(ramping-arrival-rate): warm은 startS부터 warmS초(stages 합), main은 그 뒤.
 * 각 구간 = { executor: 'ramping-arrival-rate', startRate, timeUnit: '1s', stages, startTime: '<초>s', preAllocatedVUs, maxVUs, exec, tags: { phase } }.
 * warm·main은 pollStages의 결과 꼴이다(duration은 '<정수>s'만, target·startRate는 0 이상 정수). 두 구간의 stages 길이 합이 warmS·mainS와 다르거나,
 * exec·startS·warmS·mainS·preVUs·maxVUs가 openPhases의 규칙에 맞지 않으면 RangeError
 * @param {{ exec: string, startS: number, warmS: number, mainS: number, warm: { startRate: number, stages: Array<{ target: number, duration: string }> }, main: { startRate: number, stages: Array<{ target: number, duration: string }> }, preVUs: number, maxVUs: number }} o
 * @returns {{ warm: object, main: object }}
 */
export function rampingPhases(o) {
  const exec = name(o.exec, 'exec');
  const startS = nonNegInt(o.startS ?? 0, 'startS');
  posInt(o.warmS, 'warmS');
  posInt(o.mainS, 'mainS');
  vus(o);
  for (const [k, plan] of [['warm', o.warm], ['main', o.main]]) {
    if (plan === null || typeof plan !== 'object') throw new RangeError(`${k}는 { startRate, stages } 꼴이다`);
    nonNegInt(plan.startRate, `${k}.startRate`);
  }
  if (stagesSeconds(o.warm.stages) !== o.warmS) throw new RangeError('예열 단계의 길이 합이 warmS와 다르다');
  if (stagesSeconds(o.main.stages) !== o.mainS) throw new RangeError('본구간 단계의 길이 합이 mainS와 다르다');
  const phase = (p, start, plan) => ({
    executor: 'ramping-arrival-rate',
    startRate: nonNegInt(plan.startRate, 'startRate'),
    timeUnit: '1s',
    stages: plan.stages.map((s) => ({ target: s.target, duration: s.duration })),
    startTime: `${start}s`,
    preAllocatedVUs: o.preVUs,
    maxVUs: o.maxVUs,
    exec,
    tags: { phase: p },
  });
  return { warm: phase('warm', startS, o.warm), main: phase('main', startS + o.warmS, o.main) };
}

/**
 * 본구간 지표를 요약에 남기는 꼬리표 기준(판정 기준이 아니다):
 * 'http_req_duration{phase:main}': ['max>=0'], 'http_reqs{phase:main}': ['count>=0'], 'http_req_failed{phase:main}': ['rate>=0'],
 * 경로마다 같은 셋을 '{phase:main,route:<경로>}'로, 그리고 'dropped_iterations': ['count>=0'].
 * 경로 목록이 배열이 아니거나, 경로가 문자열이 아니거나 ROUTE_PATTERN에 맞지 않거나 겹치면 RangeError
 * @param {string[]} routes
 * @returns {Record<string, string[]>}
 */
export function phaseThresholds(routes) {
  if (!Array.isArray(routes) || !routes.every((r) => typeof r === 'string' && ROUTE_PATTERN.test(r)) || new Set(routes).size !== routes.length) {
    throw new RangeError('경로 이름은 겹치지 않는 영소문자·밑줄 이름이다');
  }
  const set = (sel) => ({ [`http_req_duration{${sel}}`]: ['max>=0'], [`http_reqs{${sel}}`]: ['count>=0'], [`http_req_failed{${sel}}`]: ['rate>=0'] });
  const out = { ...set('phase:main') };
  for (const r of routes) Object.assign(out, set(`phase:main,route:${r}`));
  out.dropped_iterations = ['count>=0'];
  return out;
}

/**
 * k6 요약 지표(data.metrics)를 장부 도구가 읽는 꼴로 바꾼 새 객체(입력은 바꾸지 않는다):
 * http_req_duration·http_reqs·http_req_failed는 원래 값을 '<이름>_all'로 옮기고 '<이름>{phase:main}' 값으로 바꾼다
 * (본구간 지표가 없으면 http_reqs는 { values: { count: 0, rate: 0 } }, 나머지 둘은 { values: {} }).
 * dropped_iterations는 모든 구간의 합 그대로이고, 없으면 { values: { count: 0, rate: 0 } }. 다른 키(꼬리표 지표 포함)는 그대로 둔다(얕은 복사).
 * 원래 지표가 없으면 '<이름>_all'을 만들지 않는다.
 * mainS(1 이상 정수)를 주면 본구간 http_reqs의 rate를 count ÷ mainS로 다시 쓴다(k6는 꼬리표 지표의 rate를 시험 전체 시간으로 나눈다.
 * 새 맥락 리뷰 2026-11-03). mainS가 1 이상 정수가 아니면 RangeError
 * @param {Record<string, { values: Record<string, number> }>} metrics
 * @param {number} [mainS]
 * @returns {Record<string, { values: Record<string, number> }>}
 */
export function mainPhaseSummary(metrics, mainS) {
  if (mainS !== undefined) posInt(mainS, 'mainS');
  const out = { ...metrics };
  for (const n of ['http_req_duration', 'http_reqs', 'http_req_failed']) {
    if (metrics[n] !== undefined) out[`${n}_all`] = metrics[n];
    const main = metrics[`${n}{phase:main}`];
    out[n] = main !== undefined ? main : n === 'http_reqs' ? { values: { count: 0, rate: 0 } } : { values: {} };
  }
  if (mainS !== undefined) out.http_reqs = { ...out.http_reqs, values: { ...out.http_reqs.values, rate: (out.http_reqs.values.count ?? 0) / mainS } };
  if (metrics.dropped_iterations === undefined) out.dropped_iterations = { values: { count: 0, rate: 0 } };
  return out;
}
