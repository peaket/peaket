// 실행 결과 계산(docs/verification.md §3.9 '발생기 지표와 무효 판정'·'발생기 보정'·'기록과 산출물').
// 판정 기준은 docs/verification.md §3.5 2·3번이다.
import { queueServingRecord } from '../lib/records.mjs';

/** 발생기 CPU 평균 상한(%)과 메모리 최대 상한(%)(§3.5 3번), 보정의 k6 p99 상한(ms) [가정] */
export const GENERATOR_CPU_MAX_PCT = 80;
export const GENERATOR_MEM_MAX_PCT = 90;
export const CALIBRATION_P99_MAX_MS = 5;
/** 발생기 콘솔 줄 가운데 시험 기록으로 옮기는 종류 */
export const RECORD_KINDS = Object.freeze(['queue_entry', 'queue_admit']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const round1 = (x) => Math.round(x * 10) / 10;

const NUM = /^\d+(\.\d+)?$/;

/**
 * cgroup 표본 글(한 줄 `<유닉스 초> <커널 가동 초> <CPU 사용 µs> <메모리 바이트>`) → [{ wallS, upS, usageUsec, memBytes }].
 * 빈 줄은 건너뛴다. 줄바꿈으로 끝나지 않은 마지막 줄(쓰는 중에 읽음)은 버린다. 그 밖에 꼴이 틀린 줄(칸이 넷이 아님, 숫자가 아님,
 * 가동 초·사용 시간이 앞 줄보다 줄어듦)이 있으면 Error(줄 번호와 함께)
 * @param {string} text
 */
export function parseCgroupLog(text) {
  const lines = text.split('\n');
  // 줄바꿈으로 끝나지 않은 마지막 줄은 쓰는 중이라 버린다(끝이 줄바꿈이면 마지막 원소는 빈 글)
  lines.pop();
  const out = [];
  lines.forEach((raw, idx) => {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    if (parts.length !== 4 || !parts.every((p) => NUM.test(p))) throw new Error(`cgroup 표본 ${idx + 1}번째 줄 꼴이 틀렸다`);
    const [wallS, upS, usageUsec, memBytes] = parts.map(Number);
    const prev = out[out.length - 1];
    if (prev && (upS < prev.upS || usageUsec < prev.usageUsec)) throw new Error(`cgroup 표본 ${idx + 1}번째 줄의 가동 시간이나 사용 시간이 줄었다`);
    out.push({ wallS, upS, usageUsec, memBytes });
  });
  return out;
}

/**
 * 본구간 발생기 지표. 쓰는 표본은 wallS × 1000이 [fromMs + 1000, toMs − 1000] 안인 것(양 끝 1초씩 뺌)이고 둘 이상이어야 한다(아니면 Error).
 * - cpuMeanPct = (마지막 usageUsec − 처음 usageUsec) ÷ ((마지막 upS − 처음 upS) × 1e6 × cpus) × 100
 * - cpuMaxPct = 붙은 표본 쌍마다 같은 식으로 낸 값의 최댓값
 * - memMaxBytes = 쓴 표본의 memBytes 최댓값, memMaxPct = memMaxBytes ÷ memLimitBytes × 100
 * 백분율은 소수 첫째 자리로 반올림한다. 가동 초가 같은 쌍은 건너뛰고, 처음과 마지막 표본의 가동 초가 같으면 Error
 * @param {Array<{ wallS: number, upS: number, usageUsec: number, memBytes: number }>} samples
 * @param {{ fromMs: number, toMs: number, cpus: number, memLimitBytes: number }} o
 * @returns {{ cpuMeanPct: number, cpuMaxPct: number, memMaxPct: number, memMaxBytes: number, samples: number }}
 */
export function generatorStats(samples, o) {
  const used = samples.filter((s) => s.wallS * 1000 >= o.fromMs + 1000 && s.wallS * 1000 <= o.toMs - 1000);
  if (used.length < 2) throw new Error(`본구간 cgroup 표본이 둘보다 적다(${used.length}개)`);
  const pct = (a, b) => ((b.usageUsec - a.usageUsec) / ((b.upS - a.upS) * 1e6 * o.cpus)) * 100;
  const first = used[0];
  const last = used[used.length - 1];
  if (last.upS === first.upS) throw new Error('본구간 cgroup 표본의 가동 시간이 같다');
  let max = 0;
  for (let i = 1; i < used.length; i++) if (used[i].upS > used[i - 1].upS) max = Math.max(max, pct(used[i - 1], used[i]));
  const memMaxBytes = Math.max(...used.map((s) => s.memBytes));
  return { cpuMeanPct: round1(pct(first, last)), cpuMaxPct: round1(max), memMaxPct: round1((memMaxBytes / o.memLimitBytes) * 100), memMaxBytes, samples: used.length };
}

/**
 * 발생기 쪽 무효 판정. 사유(한국어, 이 순서): dropped > 0 → `발생기가 반복을 시작하지 못함(dropped_iterations <n>)`,
 * cpuMeanPct > 80 → `발생기 CPU 평균 <x>%(80% 초과)`, memMaxPct > 90 → `발생기 메모리 최대 <y>%(90% 초과)`.
 * 같으면(80.0, 90.0) 통과다. dropped가 0 이상 정수가 아니거나 cpuMeanPct·memMaxPct가 유한수가 아니면 사유 `발생기 지표 없음` 하나만 낸다.
 * 수는 String()으로 쓴다. 사유가 없으면 valid true
 * @param {{ dropped: number, cpuMeanPct: number, memMaxPct: number }} o
 * @returns {{ valid: boolean, reasons: string[] }}
 */
export function judgeGenerator(o) {
  if (!Number.isSafeInteger(o?.dropped) || o.dropped < 0 || !Number.isFinite(o.cpuMeanPct) || !Number.isFinite(o.memMaxPct)) return { valid: false, reasons: ['발생기 지표 없음'] };
  const reasons = [];
  if (o.dropped > 0) reasons.push(`발생기가 반복을 시작하지 못함(dropped_iterations ${o.dropped})`);
  if (o.cpuMeanPct > GENERATOR_CPU_MAX_PCT) reasons.push(`발생기 CPU 평균 ${o.cpuMeanPct}%(${GENERATOR_CPU_MAX_PCT}% 초과)`);
  if (o.memMaxPct > GENERATOR_MEM_MAX_PCT) reasons.push(`발생기 메모리 최대 ${o.memMaxPct}%(${GENERATOR_MEM_MAX_PCT}% 초과)`);
  return { valid: reasons.length === 0, reasons };
}

/**
 * 보정 단계 하나의 판정: judgeGenerator 사유에 더해 failedRate > 0 → `실패한 요청 <비율(0~1 값을 String())>`, p99Ms > 5 → `k6 p99 <p>ms(5ms 초과)`,
 * p99Ms가 수가 아니면 `k6 p99 없음`. 사유가 없으면 passed true
 * @param {{ rate: number, dropped: number, cpuMeanPct: number, memMaxPct: number, failedRate: number, p99Ms: number }} o
 * @returns {{ rate: number, passed: boolean, reasons: string[] }}
 */
export function judgeCalibrationStep(o) {
  const { reasons } = judgeGenerator(o);
  if (o.failedRate > 0) reasons.push(`실패한 요청 ${o.failedRate}`);
  if (typeof o.p99Ms !== 'number' || Number.isNaN(o.p99Ms)) reasons.push('k6 p99 없음');
  else if (o.p99Ms > CALIBRATION_P99_MAX_MS) reasons.push(`k6 p99 ${o.p99Ms}ms(${CALIBRATION_P99_MAX_MS}ms 초과)`);
  return { rate: o.rate, passed: reasons.length === 0, reasons };
}

/**
 * 보정 용량: 단계(rate 오름차순, 겹침 없음. 아니면 Error)를 낮은 것부터 보며, 처음 통과하지 못한 단계 바로 아래 단계의 rate.
 * 첫 단계부터 통과하지 못하면 capacityRps null. 모두 통과하면 마지막 단계 rate이고 topReached true(더 높은 단계를 재야 한다). 빈 목록은 { null, false, null }.
 * limitedBy는 처음 통과하지 못한 단계의 { rate, reasons }이고 없으면 null
 * @param {Array<{ rate: number, passed: boolean, reasons: string[] }>} steps
 * @returns {{ capacityRps: number | null, topReached: boolean, limitedBy: { rate: number, reasons: string[] } | null }}
 */
export function calibrationCapacity(steps) {
  for (let i = 1; i < steps.length; i++) if (!(steps[i].rate > steps[i - 1].rate)) throw new Error('보정 단계는 도착률 오름차순이고 겹치지 않아야 한다');
  let capacityRps = null;
  for (const s of steps) {
    if (!s.passed) return { capacityRps, topReached: false, limitedBy: { rate: s.rate, reasons: [...s.reasons] } };
    capacityRps = s.rate;
  }
  return { capacityRps, topReached: steps.length > 0, limitedBy: null };
}

/**
 * 가상 사용자 하나가 쓰는 메모리(바이트, 정수로 올림) = memMaxBytes ÷ vusMax. vusMax가 1 이상 정수가 아니면 RangeError
 * @param {{ memMaxBytes: number, vusMax: number }} o
 */
export function perVuBytes(o) {
  if (!Number.isInteger(o.vusMax) || o.vusMax < 1) throw new RangeError(`가상 사용자 수는 1 이상 정수다: ${o.vusMax}`);
  return Math.ceil(o.memMaxBytes / o.vusMax);
}

/**
 * 발생기 콘솔 출력(한 줄에 JSON 하나) → { records: 시험 기록 줄 글 목록(입력 순서, 종류는 RECORD_KINDS), marks: { main_start?, main_end? }(ms) }.
 * 빈 줄은 건너뛰고 줄바꿈 없는 마지막 줄도 읽는다. 표시는 하나만 있어도 된다. 줄 번호는 빈 줄을 포함한 1부터다.
 * JSON 객체가 아닌 줄, 모르는 kind, 모르는 표시 이름, at_ms가 0 이상 안전한 정수가 아님, 같은 표시 두 번, main_end의 at_ms가 main_start보다 작으면
 * Error(줄 번호와 함께, 줄 내용은 싣지 않는다)
 * @param {string} text
 * @returns {{ records: string[], marks: { main_start?: number, main_end?: number } }}
 */
export function splitConsole(text) {
  const records = [];
  const marks = {};
  text.split('\n').forEach((raw, idx) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      throw new Error(`발생기 콘솔 ${idx + 1}번째 줄이 JSON이 아니다`);
    }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error(`발생기 콘솔 ${idx + 1}번째 줄이 JSON 객체가 아니다`);
    if (o.kind === 'mark') {
      if (o.name !== 'main_start' && o.name !== 'main_end') throw new Error(`발생기 콘솔 ${idx + 1}번째 줄: 모르는 구간 표시`);
      if (Object.hasOwn(marks, o.name)) throw new Error(`발생기 콘솔 ${idx + 1}번째 줄: 구간 표시가 두 번 나왔다`);
      if (!Number.isSafeInteger(o.at_ms) || o.at_ms < 0) throw new Error(`발생기 콘솔 ${idx + 1}번째 줄: 구간 표시 시각이 틀렸다`);
      marks[o.name] = o.at_ms;
      if (marks.main_start !== undefined && marks.main_end !== undefined && marks.main_end < marks.main_start) throw new Error(`발생기 콘솔 ${idx + 1}번째 줄: 구간 표시 main_end가 main_start보다 앞이다`);
    } else if (RECORD_KINDS.includes(o.kind)) records.push(line);
    else throw new Error(`발생기 콘솔 ${idx + 1}번째 줄: 모르는 종류`);
  });
  return { records, marks };
}

/**
 * 서버 serving_log(오래된 것부터 [{ serving, called, atMs }]) → queue_serving 기록 줄 글 목록(loadtest/lib/records.mjs queueServingRecord).
 * eventId는 UUID여야 한다(대소문자 무관, 아니면 Error)
 * @param {string} eventId
 * @param {Array<{ serving: number, called: number, atMs: number }>} log
 * @returns {string[]}
 */
export function servingRecords(eventId, log) {
  if (typeof eventId !== 'string' || !UUID.test(eventId)) throw new Error('회차 ID가 UUID가 아니다');
  return log.map((e) => JSON.stringify(queueServingRecord({ eventId, serving: e.serving, atMs: e.atMs })));
}

/**
 * 시뮬레이터 원장(GET /sim/ledger, NDJSON) → 줄 글 목록. 줄마다 JSON 객체이고 kind가 'pg_charge'여야 한다(아니면 Error). 빈 줄은 건너뛴다
 * @param {string} text
 * @returns {string[]}
 */
export function pgChargeLines(text) {
  const out = [];
  text.split('\n').forEach((raw, idx) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      throw new Error(`시뮬레이터 원장 ${idx + 1}번째 줄이 JSON이 아니다`);
    }
    if (o === null || typeof o !== 'object' || Array.isArray(o) || o.kind !== 'pg_charge') throw new Error(`시뮬레이터 원장 ${idx + 1}번째 줄이 pg_charge가 아니다`);
    out.push(line);
  });
  return out;
}

/**
 * collect.py 인자 목록(셸 없이 부른다). 늘: --run-id --kpi --version --profile --duration --warmup --scenario --k6-summary --infra-file --notes --verdict baseline
 * 그리고 users가 있으면 --users, rps가 있으면 --rps, start·end가 있으면 --start·--end(ISO UTC), invalidReason이 있으면 --invalid-reason,
 * invariants가 있으면 --invariants, extra마다 --extra, generator가 있으면 --generator(발생기 대수·사양·k6 판, 이 순서). start·end는 둘 다 있을 때만 싣는다. 첫 원소는 'tools/perf-ledger/collect.py'이다.
 * 문자열 값이 비었거나 '-'로 시작하면(argparse가 인자로 읽는다) Error
 * @param {{ runId: string, kpi: string, version: string, profile: string, users?: number, rps?: number, durationS: number, warmupS: number, scenario: string, summaryFile: string, infraFile: string, notes: string, start?: string, end?: string, invalidReason?: string, invariants?: string, extra?: string[], generator?: string }} o
 * @returns {string[]}
 */
export function collectArgs(o) {
  const str = (name, v) => {
    if (typeof v !== 'string' || v.length === 0 || v.startsWith('-')) throw new Error(`collect.py 인자 ${name}가 비었거나 '-'로 시작한다`);
    return v;
  };
  for (const k of ['runId', 'kpi', 'version', 'profile', 'scenario', 'summaryFile', 'infraFile', 'notes']) str(k, o[k]);
  for (const k of ['start', 'end', 'invalidReason', 'invariants']) if (o[k] !== undefined) str(k, o[k]);
  for (const e of o.extra ?? []) str('extra', e);
  if (o.generator !== undefined) str('generator', o.generator);
  const a = ['tools/perf-ledger/collect.py', '--run-id', o.runId, '--kpi', o.kpi, '--version', o.version, '--profile', o.profile];
  a.push('--duration', String(o.durationS), '--warmup', String(o.warmupS), '--scenario', o.scenario, '--k6-summary', o.summaryFile, '--infra-file', o.infraFile, '--notes', o.notes, '--verdict', 'baseline');
  if (o.users !== undefined) a.push('--users', String(o.users));
  if (o.rps !== undefined) a.push('--rps', String(o.rps));
  if (o.start !== undefined && o.end !== undefined) a.push('--start', o.start, '--end', o.end);
  if (o.invalidReason !== undefined) a.push('--invalid-reason', o.invalidReason);
  if (o.invariants !== undefined) a.push('--invariants', o.invariants);
  for (const e of o.extra ?? []) a.push('--extra', e);
  if (o.generator !== undefined) a.push('--generator', o.generator);
  return a;
}

/**
 * 시나리오 오류(시나리오가 잘못 보낸 요청, 예: 서버가 invalid-seat로 거절한 좌석 ID, 준비 구간 입장 실패) 수를 발생기 판정에 더한다.
 * count가 0이면 judge를 그대로(새 객체로), 1 이상이면 valid false와 사유 `시나리오 오류 <n>건`을 끝에 더한 새 객체를 돌려준다(입력은 바꾸지 않는다).
 * count가 0 이상 안전한 정수가 아니면 RangeError
 * @param {{ valid: boolean, reasons: string[] }} judge
 * @param {number} count
 * @returns {{ valid: boolean, reasons: string[] }}
 */
export function withScenarioErrors(judge, count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`시나리오 오류 수는 0 이상 정수다: ${count}`);
  if (count === 0) return { valid: judge.valid, reasons: [...judge.reasons] };
  return { valid: false, reasons: [...judge.reasons, `시나리오 오류 ${count}건`] };
}
