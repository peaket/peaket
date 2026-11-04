// S-T27 정식 측정 계획(loadtest/poc/st27-plan.json)을 읽고, 측정 차례를 상태 파일로 이어 돌게 하는 순수 도움 함수(BUILD_ORDER PRF-135).
// 실행은 run.mjs의 st27 묶음이 한다. 여기는 파일 읽기·쓰기 말고는 Docker·Redis를 건드리지 않는다(시험: loadtest/test/poc-seat.test.mjs).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLAN_PATH = join(ROOT, 'loadtest', 'poc', 'st27-plan.json');

/** 계획 파일을 읽고 모양을 확인한다. 틀리면 Error */
export function loadPlan(path = PLAN_PATH) {
  const p = JSON.parse(readFileSync(path, 'utf8'));
  validatePlan(p);
  return p;
}

/** 계획의 모양: 번 n은 1부터 차례, key는 겹치지 않는 [a-z0-9-], mode one|five, layout same|spread, tls 참·거짓, pair는 다른 번의 key */
export function validatePlan(p) {
  if (!p || typeof p.plan !== 'string' || !Array.isArray(p.runs) || p.runs.length === 0) throw new Error('계획에 plan 이름과 runs가 없다');
  const c = p.common ?? {};
  for (const k of ['warmup_s', 'duration_s', 'expire_batch', 'replay_ratio', 'relay_trim_ms']) {
    if (typeof c[k] !== 'number' || !(c[k] >= 0)) throw new Error(`common.${k}가 0 이상의 수가 아니다`);
  }
  if (c.expire !== 'on' && c.expire !== 'off') throw new Error('common.expire는 on 또는 off다');
  if (c.expire_call !== 'evalsha' && c.expire_call !== 'eval') throw new Error('common.expire_call은 evalsha 또는 eval이다');
  const keys = new Set();
  p.runs.forEach((r, i) => {
    if (r.n !== i + 1) throw new Error(`runs[${i}].n이 ${i + 1}이 아니다`);
    if (typeof r.key !== 'string' || !/^[a-z0-9-]+$/.test(r.key) || keys.has(r.key)) throw new Error(`runs[${i}].key가 틀렸거나 겹친다: ${r.key}`);
    keys.add(r.key);
    if (r.mode !== 'one' && r.mode !== 'five') throw new Error(`runs[${i}].mode가 틀렸다: ${r.mode}`);
    if (r.layout !== 'same' && r.layout !== 'spread') throw new Error(`runs[${i}].layout이 틀렸다: ${r.layout}`);
    if (typeof r.tls !== 'boolean') throw new Error(`runs[${i}].tls가 참·거짓이 아니다`);
    if (!Number.isInteger(r.rps) || r.rps <= 0) throw new Error(`runs[${i}].rps가 양의 정수가 아니다`);
  });
  for (const r of p.runs) if (r.pair !== undefined && !keys.has(r.pair)) throw new Error(`${r.key}의 짝 ${r.pair}가 계획에 없다`);
}

/**
 * 측정 ID(장부 이름): {시작한 날}-st27-prod[-{묶음}]-{key}. record.mjs가 -st27-로 오버셀 불변식을 본다.
 * 묶음(series)은 같은 날 처음부터 다시 돌 때 앞 묶음의 결과·장부 줄을 덮지 않게 붙이는 글자다(''·'b'·'c'…, V-T41의 -b-·-c-와 같은 방식)
 */
export const runIdOf = (day, key, series = '') => `${day}-st27-prod${series ? `-${series}` : ''}-${key}`;

/**
 * 새 상태의 묶음 글자: 이 계획의 측정 ID가 이미 쓰인 것(결과 파일·plan.jsonl의 ID)과 하나도 겹치지 않는 첫 글자('' → 'b' → 'c' …)
 * @param {Iterable<string>} taken 이미 쓰인 측정 ID들
 */
export function pickSeries(plan, day, taken) {
  const used = new Set(taken);
  for (const series of ['', ...'bcdefghijklmnopqrstuvwxyz']) {
    if (plan.runs.every((r) => !used.has(runIdOf(day, r.key, series)))) return series;
  }
  throw new Error(`${day}에 쓸 수 있는 묶음 글자가 없다`);
}

/** 측정 컨테이너에 넘길 인자(stack.mjs bench가 뒤에 --out을 붙인다) */
export function benchArgs(plan, run, nodes) {
  return ['src/seat-shard.mjs', '--nodes', nodes, '--tls', String(run.tls), ...scenarioArgList(plan, run)];
}

function scenarioArgList(plan, run) {
  const c = plan.common;
  return ['--mode', run.mode, '--layout', run.layout, '--duration', String(c.duration_s), '--warmup', String(c.warmup_s), '--expire', c.expire,
    '--expire-batch', String(c.expire_batch), '--expire-call', c.expire_call, '--replay-ratio', String(c.replay_ratio), '--relay-trim-ms', String(c.relay_trim_ms)];
}

/** plan.jsonl 한 줄의 장부 칸(run.mjs runBench의 ledger, record.mjs가 collect.py로 옮긴다). 짝 ID는 같은 날·같은 묶음이다 */
export function ledgerOf(plan, run, day, series = '') {
  const c = plan.common;
  return {
    kpi: 'NFR-003',
    rps: run.rps,
    duration: c.duration_s,
    warmup: c.warmup_s,
    scenario: c.scenario,
    scenarioArgs: scenarioArgList(plan, run).join(' '),
    redisTls: run.tls,
    ...(run.pair ? { pairOf: runIdOf(day, run.pair, series) } : {}),
    notes: `S-T27 다시 재기(운영 홀드·만료 Lua, ${plan.plan} ${run.n}/${plan.runs.length}) ${run.case}, 만료 두 단계 ${c.expire_batch}석·1초, 릴레이 흉내 XTRIM MINID ${c.relay_trim_ms}ms, 틀린 좌석 재생 읽기 홀드의 ${Math.round(c.replay_ratio * 100)}%, 스냅샷 함께, p99는 클라이언트가 잰 홀드 Lua 왕복`,
  };
}

/** 새 상태: 시작한 날·묶음 글자(pickSeries)·Lua 원문 sha1을 적는다 */
export const newState = (plan, day, lua, series = '') => ({ plan: plan.plan, day, series, lua, runs: {} });

/** 이어 돌 수 있는지 본다: 계획 이름과 Lua 원문(sha1)이 시작 때와 같아야 한다. 다르면 Error(상태 파일을 지우고 처음부터) */
export function checkState(state, plan, lua) {
  if (state.plan !== plan.plan) throw new Error(`상태 파일의 계획(${state.plan})이 ${plan.plan}이 아니다`);
  const diff = Object.keys({ ...state.lua, ...lua }).filter((k) => state.lua?.[k] !== lua[k]);
  if (diff.length) throw new Error(`Lua 원문이 시작 때와 다르다(${diff.join(', ')}). 섞인 판으로 잴 수 없으니 상태 파일을 지우고 처음부터 돈다`);
}

/** 아직 끝나지 않은 번(끝남 = status 'done'). 실패한 번도 다시 돈다 */
export const pendingRuns = (plan, state) => plan.runs.filter((r) => state.runs[r.key]?.status !== 'done');

export function readState(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** 상태 파일을 통째로 바꿔 쓴다(임시 파일 → 이름 바꾸기. 도중에 멈춰도 반쪽 파일이 남지 않는다) */
export function writeState(path, state) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, path);
}
