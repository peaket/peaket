// v1 경로 실행 도구의 계산(docs/verification.md §3.9 'v1 경로'·§3.10 'v1 합본 측정 규칙', BUILD_ORDER PRF-215, 코드 리뷰 반영). Node만 읽는다.
import { ERROR_TARGETS } from '../lib/targets.mjs';
import { assertRunTag } from '../lib/users.mjs';

/**
 * v1 합본 실행에서 SKIPPED여야 하는 불변식(docs/verification.md §3.10 'v1 합본 측정 규칙'): 티켓 원본이 없어 S3·P5, 정산 표가 아직 없어 M1~M5.
 * 이 목록과 다르면(더 SKIPPED거나 덜 SKIPPED) 실행 도구가 실패로 끝낸다(조용히 검사를 잃지 않게, 코드 리뷰 H2)
 */
export const V1_EXPECTED_SKIPPED = Object.freeze(['M1', 'M2', 'M3', 'M4', 'M5', 'P5', 'S3']);

/**
 * invariants.csv(id,name,sources,violations,unknown,result,as_of)에서 SKIPPED 목록과, 기대 목록과 다르면 그 문제 글
 * @param {string} csv
 * @returns {{ skipped: string[], problem: string | null }}
 */
export function skippedProblem(csv) {
  const rows = csv.trim().split('\n').slice(1).filter(Boolean).map((l) => l.split(','));
  const skipped = rows.filter((c) => c[c.length - 2] === 'SKIPPED').map((c) => c[0]).sort();
  const more = skipped.filter((id) => !V1_EXPECTED_SKIPPED.includes(id));
  const less = V1_EXPECTED_SKIPPED.filter((id) => !skipped.includes(id));
  if (!more.length && !less.length) return { skipped, problem: null };
  return { skipped, problem: `기대와 다른 SKIPPED: ${[more.length ? `더 ${more.join('·')}` : '', less.length ? `덜 ${less.join('·')}` : ''].filter(Boolean).join(', ')}(기대 ${V1_EXPECTED_SKIPPED.join('·')}, docs/verification.md §3.10 'v1 합본 측정 규칙')` };
}

/**
 * K1 진입 시행: 시험 기록 queue_entry를 사람(account_ref)마다 한 번으로 센다(사전 검증 실패도 실패한 진입으로 기록한다, 코드 리뷰 H3).
 * 시행이 사용자 수보다 적으면 무효 사유다(남은 사람만으로 진입 점검이 통과하지 않게)
 * @param {string[]} lines 시험 기록 줄(JSON)
 * @param {number} users
 * @returns {{ trials: number, failed: number, reasons: string[] }}
 */
export function entryTrials(lines, users) {
  const byAccount = new Map();
  for (const l of lines) {
    const r = JSON.parse(l);
    if (r.kind !== 'queue_entry') continue;
    // 한 사람의 기록이 여럿이면 성공을 남긴다(사람마다 진입 한 번)
    if (!byAccount.has(r.account_ref) || r.result === 'ok') byAccount.set(r.account_ref, r.result);
  }
  const trials = byAccount.size;
  const failed = [...byAccount.values()].filter((x) => x !== 'ok').length;
  return { trials, failed, reasons: trials < users ? [`진입 시행 ${trials}/${users}건(사용자 수보다 적다)`] : [] };
}

/**
 * 진입 오류율 점검을 시험 기록의 시행·실패로 바꾼다(요청 지표는 사전 검증에서 멈춘 사람을 세지 않는다). 다른 점검은 그대로 둔다.
 * 사전 검증이 모두 실패해 진입 요청이 0건이면 요약에 진입 점검이 없으므로 기록으로 만든다(점검이 빠져 통과로 남지 않게, 재확인 리뷰 2)
 * @param {{ checks: Array<Record<string, unknown>> } | null} checks @param {{ trials: number, failed: number }} entry
 */
export function withEntryRecords(checks, entry) {
  const violations = Math.min(entry.trials, entry.failed);
  const has = checks?.checks.some((c) => c.name === 'entry_errors');
  if (has) return { ...checks, checks: checks.checks.map((c) => (c.name === 'entry_errors' ? { ...c, trials: entry.trials, violations } : c)) };
  if (!(entry.trials > 0)) return checks;
  const allowed = ERROR_TARGETS.entry;
  const made = { name: 'entry_errors', allowed, trials: entry.trials, violations, target: `entry 오류율 < ${+(allowed * 100).toFixed(6)}%` };
  return { ...(checks ?? {}), checks: [...(checks?.checks ?? []), made] };
}

/**
 * 장부에 남길 판정: 발생기 판정에 진입 시행·정지 기록·SKIPPED 목록의 무효 사유를 더한다. 실행 도구는 불변식 검사 뒤 이 판정으로 --invalid-reason을 낸다
 * (SKIPPED가 기대와 달라도 유효한 행으로 남지 않게, 재확인 리뷰 1)
 * @param {{ valid: boolean, reasons: string[] }} judge
 * @param {{ entry?: { reasons: string[] }, pause?: string[], skipped?: { problem: string | null } }} o
 */
export function v1LedgerJudge(judge, o) {
  const reasons = [...(o.entry?.reasons ?? []), ...(o.pause ?? []), ...(o.skipped?.problem ? [o.skipped.problem] : [])];
  return reasons.length ? { ...judge, valid: false, reasons: [...judge.reasons, ...reasons] } : judge;
}

/**
 * 새 결제 정지 503 수(누적 카운터): 끝의 값(구간 안 최대)에서 실행 시작 때 값을 시계열(꼬리표)마다 뺀 합. 시작 때 없던 시계열(새로 뜬 파드·처음 503)은 전부
 * 이 실행 몫이다. 같은 파드의 앞 실행 수가 들어가지 않게 한다(재확인 리뷰 4)
 * @param {Array<{ metric: Record<string, string>, value: [number, string] }>} baseline 시작 시각의 즉시 값
 * @param {Array<{ metric: Record<string, string>, value: [number, string] }>} end 구간 안 최대(max_over_time)
 */
export function pausedDelta(baseline, end) {
  const key = (m) => JSON.stringify(Object.entries(m).filter(([k]) => k !== '__name__').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const before = new Map(baseline.map((r) => [key(r.metric), Number(r.value[1])]));
  let sum = 0;
  for (const r of end) sum += Math.max(0, Number(r.value[1]) - (before.get(key(r.metric)) ?? 0));
  return Math.round(sum);
}

/**
 * 불변식 검사기의 결제 원본 주소: 검색 경로를 public 다음 v1_check로 둔다(빈 결제 취소 검사 뷰는 public에 그 표가 없을 때만 보인다, 재확인 리뷰 7)
 * @param {string} url
 */
export function v1PaymentDbUrl(url) {
  return `${url}?options=-c%20search_path%3Dpublic%2Cv1_check`;
}

/**
 * 리더 임대 보유자를 읽는다. 못 읽은 임대는 null이고 그 까닭을 errors에 남긴다(삼키지 않는다, 재확인 리뷰 8)
 * @param {string[]} names @param {(name: string) => Promise<string>} read
 */
export async function readLeaseHolders(names, read) {
  const holders = {};
  const errors = [];
  for (const name of names) {
    try {
      holders[name] = String(await read(name)).trim() || null;
    } catch (e) {
      holders[name] = null;
      errors.push(`${name}: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`);
    }
  }
  return { holders, errors };
}

/**
 * serving 전진 기록(q:{event:E}:serving_log, 멤버 = 칸의 시각(초), 점수 = 그 1초 칸의 마지막 serving, docs/data.md §3)을 시험 기록 꼴로.
 * atMs는 칸의 시작이다: 같은 칸 안에서 serving이 오르기 전에 들어온 입장은 Q1이 놓친다(너그러운 쪽, docs/verification.md §3.9 'v1 경로')
 * @param {unknown} raw ZRANGE … WITHSCORES 응답(RESP2 [멤버, 점수, …], RESP3 [[멤버, 점수], …], 또는 객체)
 * @returns {{ atMs: number, serving: number }[]}
 */
export function servingLogFromZset(raw) {
  const flat = (Array.isArray(raw) ? raw.flat() : raw && typeof raw === 'object' ? Object.entries(raw).flat() : []).map(String);
  if (flat.length % 2 !== 0) throw new RangeError('serving 기록의 멤버·점수 짝이 맞지 않는다');
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    if (!/^\d{1,13}$/.test(flat[i]) || !/^\d{1,16}$/.test(flat[i + 1])) throw new RangeError(`serving 기록의 칸이 정수가 아니다: ${flat[i]} ${flat[i + 1]}`);
    out.push({ atMs: Number(flat[i]) * 1000, serving: Number(flat[i + 1]) });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/**
 * 성능 장부 기록 규칙(docs/verification.md §3.10 'v1 합본 측정 규칙'): K1·K7 ②는 TLS 켬 하나로 잰다. TLS를 끈 무대에서 그 둘을 --record로 남기면 문제다
 * @param {{ scenario: string, record: boolean }} a @param {{ redisTls: boolean }} o
 */
export function v1RecordProblem(a, o) {
  if (!a.record || o.redisTls) return null;
  if (a.scenario === 'queue') return 'K1은 Redis TLS 켬 하나로 잰다(TLS 끈 무대의 실행은 장부에 남기지 않는다)';
  if (a.scenario === 'payment') return 'K7 ②는 Redis TLS 켬 하나로 잰다(TLS 끈 무대의 실행은 장부에 남기지 않는다)';
  return null;
}

/**
 * 정지 기록 판정(코드 리뷰 M1·M8): 모으지 못했으면 무효, 판정 입력(kube_pod_status_ready)이 없는 무대에서 새 결제 정지 503이 나면 무효다
 * (입력이 없으면 판정자가 자기 파드 서킷만으로 멈추고 자동으로 다시 열지 않는다, docs/verification.md §3.10)
 * @param {{ error: string | null, inputs: 'present' | 'absent' | 'unknown', newPaymentPaused503: number }} p
 */
export function pauseReasons(p) {
  if (p.error) return [`정지 기록을 모으지 못했다: ${p.error}`];
  if (p.inputs !== 'present' && p.newPaymentPaused503 > 0) return [`정지 판정 입력이 없는데 새 결제 정지 503이 ${p.newPaymentPaused503}건 났다(자기 파드 서킷만으로 멈춤, 측정 조건 밖)`];
  return [];
}

/** 실행의 결제사 묶음 이름(입장 제어는 같은 묶음 회차끼리 입장 속도를 나눈다, 코드 리뷰 H1) */
export function stagePgKey(runTag) {
  return `lt-${assertRunTag(runTag)}`;
}

/** 이 실행 밖의 진행 중 회차가 있으면 문제 글(같은 무대의 회차끼리 입장 제어를 나눠 쓰지 않게, 코드 리뷰 H1) */
export function activeEventsProblem(active, eventId) {
  const others = active.filter((e) => e !== eventId);
  if (!others.length) return null;
  return `진행 중인 다른 회차 ${others.length}개가 무대에 남아 있다(${others.slice(0, 3).join(', ')}). 먼저 node loadtest/run.mjs cleanup으로 끝낸다`;
}
