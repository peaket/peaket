#!/usr/bin/env node
// F-01-8 법정 접속기록의 5분 칸 대조·일 해시 앵커·Object Lock 머리 계산(순수 함수).
// 정본: docs/observability.md §7 '법정 사본은 잃지 않는 갈래' ④⑤, docs/infra.md §6 'ClickHouse 접속기록 DB',
// docs/verification.md V-T21~V-T23. 값(0.1%·5분·15분·3개월+7일)은 부르는 쪽이 정본에서 읽어 넘긴다.
// 이 파일은 네트워크·Docker를 쓰지 않는다. 실제 작업은 tools/local/access-log-jobs.mjs가 한다.

const MINUTE_MS = 60_000;

const isInt = (v) => Number.isInteger(v) && Number.isFinite(v);

function fail(message) {
  throw new Error(message);
}

/** 5분 경계로 내린 창. 기본은 15분 전의 5분 칸이다(§7 ④). */
export function windowOf(nowMs, o = {}) {
  const offsetMinutes = o.offsetMinutes ?? 15;
  const sizeMinutes = o.sizeMinutes ?? 5;
  if (!Number.isFinite(nowMs)) fail(`nowMs가 숫자가 아니다: ${nowMs}`);
  if (!Number.isInteger(sizeMinutes) || sizeMinutes <= 0) fail(`sizeMinutes는 1 이상의 정수다: ${sizeMinutes}`);
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < 0) fail(`offsetMinutes는 0 이상의 정수다: ${offsetMinutes}`);
  const size = sizeMinutes * MINUTE_MS;
  const startMs = Math.floor((nowMs - offsetMinutes * MINUTE_MS) / size) * size;
  return { startMs, endMs: startMs + size };
}

/** (원천 − 적재) ÷ 원천. 원천이 0이면 확인 불가(null)다. 적재가 더 많으면 0. */
export function shortfallRatio(ingress, rows) {
  if (!Number.isFinite(ingress) || ingress < 0) fail(`원천 수가 0 이상의 숫자가 아니다: ${ingress}`);
  if (!Number.isFinite(rows) || rows < 0) fail(`적재 수가 0 이상의 숫자가 아니다: ${rows}`);
  if (ingress === 0) return null;
  if (rows >= ingress) return 0;
  return (ingress - rows) / ingress;
}

/** 0.1% 같은 문턱을 **넘을 때만** 참이다(경계값은 참이 아니다). 확인 불가는 통과로 쓰지 않는다. */
export function shortfallAlarm(ratio, threshold) {
  if (ratio === null || ratio === undefined) fail('모자란 비율을 확인할 수 없으면 경보 여부를 정하지 않는다');
  if (!Number.isFinite(ratio) || ratio < 0) fail(`모자란 비율이 0 이상의 숫자가 아니다: ${ratio}`);
  if (!Number.isFinite(threshold) || threshold < 0) fail(`문턱이 0 이상의 숫자가 아니다: ${threshold}`);
  return ratio > threshold;
}

/** 일련번호 1~유효 최댓값 사이의 빠진 번호와 중복. 빈 값은 그 자리의 번호가 빠진 것으로 센다. */
export function seqGaps(seqs) {
  if (!Array.isArray(seqs)) fail('일련번호 목록이 배열이 아니다');
  const seen = new Map();
  let max = 0;
  for (const v of seqs) {
    if (v === null || v === undefined) continue;
    if (!isInt(v) || v <= 0) fail(`일련번호는 1 이상의 정수다: ${v}`);
    seen.set(v, (seen.get(v) ?? 0) + 1);
    if (v > max) max = v;
  }
  // 1~최댓값 사이의 빈 번호. 빈 값은 그 자리의 번호가 빠진 것으로 세되, 이미 빈 번호가 있으면 그 빈 번호를 채운 것으로 본다.
  const effectiveMax = Math.max(max, 0);
  const missing = [];
  for (let n = 1; n <= effectiveMax; n++) if (!seen.has(n)) missing.push(n);
  const blanks = seqs.filter((v) => v === null || v === undefined).length;
  for (let i = 0; i < blanks && missing.length === 0; i++) missing.push(effectiveMax + 1 + i);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n).sort((a, b) => a - b);
  return { missing, duplicates };
}

const SHA256 = /^[0-9a-f]{64}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayOf(iso, what) {
  const m = DAY.exec(iso);
  if (!m) fail(`${what}가 YYYY-MM-DD 꼴이 아니다: ${iso}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3]))
    fail(`${what}가 달력에 없는 날짜다: ${iso}`);
  return d;
}

/** 하루 대조 결과와 일 해시 앵커. 모두 맞을 때만 matches가 참이다. */
export function dayAnchor(input) {
  const { date, sourceTotal, ingestedTotal, seqs, fileSha256, fileRows } = input ?? {};
  dayOf(date, 'date');
  for (const [k, v] of [
    ['sourceTotal', sourceTotal],
    ['ingestedTotal', ingestedTotal],
    ['fileRows', fileRows],
  ])
    if (!isInt(v) || v < 0) fail(`${k}가 0 이상의 정수다: ${v}`);
  if (typeof fileSha256 !== 'string' || !SHA256.test(fileSha256)) fail(`fileSha256이 64자리 16진수가 아니다: ${fileSha256}`);
  const gaps = seqGaps(seqs ?? []);
  const shortfall = shortfallRatio(sourceTotal, ingestedTotal);
  const matches =
    sourceTotal > 0 &&
    ingestedTotal === sourceTotal &&
    fileRows === ingestedTotal &&
    gaps.missing.length === 0 &&
    gaps.duplicates.length === 0;
  return {
    date,
    sourceTotal,
    ingestedTotal,
    shortfall,
    seqMissing: gaps.missing,
    seqDuplicates: gaps.duplicates,
    fileSha256,
    fileRows,
    matches,
  };
}

/** 날짜의 보존 끝: 그 날짜 + 개월 + 일. UTC 자정 기준(예: 2026-01-31 + 1개월 = 2026-02-28). */
export function retentionUntil(dayIso, months, extraDays) {
  if (!Number.isInteger(months) || months <= 0) fail(`months는 1 이상의 정수다: ${months}`);
  if (!Number.isInteger(extraDays) || extraDays < 0) fail(`extraDays는 0 이상의 정수다: ${extraDays}`);
  const d = dayOf(dayIso, 'dayIso');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString();
}

/** S3 Object Lock 머리. 보존이 지난 시각과 모르는 모드는 거부한다. */
export function objectLockHeaders(o) {
  const mode = o?.mode;
  if (mode !== 'COMPLIANCE' && mode !== 'GOVERNANCE') fail(`Object Lock 모드는 COMPLIANCE 또는 GOVERNANCE다: ${mode}`);
  const until = o?.retainUntil;
  const t = typeof until === 'string' ? Date.parse(until) : Number.NaN;
  if (!Number.isFinite(t)) fail(`retainUntil이 시각이 아니다: ${until}`);
  if (t <= Date.now()) fail(`retainUntil이 이미 지났다: ${until}`);
  return {
    'x-amz-object-lock-mode': mode,
    'x-amz-object-lock-retain-until-date': new Date(t).toISOString(),
  };
}
