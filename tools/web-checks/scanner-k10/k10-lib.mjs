// F-05-9 K10 측정 판정기(계획 docs/review/plans/F-05-9.md §5).
// 제품 코드가 아니다. 하네스가 모은 표본을 정본의 판정 기준(O-T40·O-T41)으로 가르는 순수 함수만 둔다.
// 정본: docs/features/offline-gate.md §11 O-T40·O-T41, docs/quality/quality-requirements.md QR-SA-1·QR-PE-4,
//       docs/verification.md §3.5(측정 정직성), docs/perf-ledger.md §7(표시 규칙).
// 표시: 결과는 '실측(PC)'에 무대 'Chromium 흉내(실제 관리형 기기 아님)'를 붙인다. 실제 기기 값이 아니다.

/** 정본의 [가정] 값과 이 계획이 정한 측정 상수. 값을 바꾸면 계획 §5도 함께 고친다. */
export const K10 = Object.freeze({
  /** O-T40: 정상 티켓 300건 [가정] */
  transitionScans: 300,
  /** O-T40: 150번째 무렵에 비행기 모드를 켠다 [가정] */
  transitionAt: 150,
  /** O-T40: 다시 켠 뒤 더 보는 30건(이 계획의 복구 확인) */
  recoveryScans: 30,
  /** O-T40: QR을 대는 간격 2초 [가정] */
  intervalMs: 2_000,
  /** O-T41: 사람 역할 20명 [가정] */
  lanePeople: 20,
  /** O-T41: 온라인·오프라인 10분씩 [가정] */
  laneWindowMs: 600_000,
  /** NFR-010·QR-PE-4: 판정 p95 150ms 이하 */
  passMs: 150,
  /** QR-SA-1: 오프라인 분당 통과 인원이 온라인의 90% [가정] 이상 */
  laneRatioPercent: 90,
  /** 이 계획: QR을 댄 뒤 3초가 지나도 판정이 없으면 '멈춘 시간'으로 센다 */
  stoppedAfterMs: 3_000,
  /** 하네스가 판정을 기다리는 상한. 넘으면 결과 없음으로 기록한다 */
  scanTimeoutMs: 10_000,
});

/** 숫자만 남긴다(정렬은 하지 않는다). */
function numbers(values) {
  return (Array.isArray(values) ? values : []).filter((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * 가까운 차례(nearest-rank) 백분위. p95는 '100건 가운데 95건'이므로
 * ceil(0.95 × n)번째로 작은 값을 고른다(보간하지 않는다).
 * @param {number[]} values
 * @param {number} p 0~1
 * @returns {number|undefined}
 */
export function percentile(values, p) {
  const sorted = numbers(values).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  if (!(p >= 0 && p <= 1)) throw new Error(`백분위 p는 0~1이어야 한다: ${p}`);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/** 중앙값. 짝수 개면 가운데 둘의 평균이다. */
export function median(values) {
  const sorted = numbers(values).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 분당 처리량. 창 길이가 0 이하이면 undefined. */
export function throughputPerMinute(count, windowMs) {
  if (!(windowMs > 0) || !(count >= 0)) return undefined;
  return (count * 60_000) / windowMs;
}

/** 비율(%). 표시용이다. 판정은 meetsRatio로 한다(부동소수 오차를 피한다). */
export function ratioPercent(part, whole) {
  if (!(whole > 0) || !(part >= 0)) return undefined;
  return (part / whole) * 100;
}

/**
 * `part ÷ whole ≥ thresholdPercent`를 정수 곱으로 센다.
 * 27/30 = 90.0%는 통과, 26.9/30 = 89.7%는 실패다.
 */
export function meetsRatio(part, whole, thresholdPercent) {
  if (!(whole > 0) || !(part >= 0)) return false;
  return part * 100 >= whole * thresholdPercent;
}

/**
 * O-T40의 전환 일정. 1~149는 온라인, 150~300은 오프라인, 301~330은 복구(온라인)다.
 * 150번째 QR을 넣기 전에 비행기 모드를 켠다.
 */
export function transitionPlan({ total = K10.transitionScans, switchAt = K10.transitionAt, recovery = K10.recoveryScans } = {}) {
  if (!Number.isInteger(total) || total <= 0) throw new Error(`total은 1 이상의 정수여야 한다: ${total}`);
  if (!Number.isInteger(switchAt) || switchAt < 1 || switchAt > total) throw new Error(`switchAt은 1~total이어야 한다: ${switchAt}`);
  if (!Number.isInteger(recovery) || recovery < 0) throw new Error(`recovery는 0 이상의 정수여야 한다: ${recovery}`);
  return [
    ...Array.from({ length: total }, (_, i) => ({ index: i + 1, phase: i + 1 < switchAt ? 'online' : 'offline' })),
    ...Array.from({ length: recovery }, (_, i) => ({ index: total + i + 1, phase: 'recovery' })),
  ];
}

/**
 * O-T40의 '전환 앞뒤 1분' 창을 2초 간격의 건 번호로 바꾼다.
 * 기본은 150번째 앞뒤 30건(120~180)과 복구 30건(301~330)이다.
 */
export function transitionWindowIndexes({ switchAt = K10.transitionAt, total = K10.transitionScans, recovery = K10.recoveryScans, windowScans = 30 } = {}) {
  const before = Math.max(1, switchAt - windowScans);
  const after = Math.min(total, switchAt + windowScans);
  const windows = [[before, after]];
  if (recovery > 0) windows.push([total + 1, total + recovery]);
  return windows;
}

/** O-T41의 사람 20명과 10분 창. */
export function lanePlan({ people = K10.lanePeople, windowMs = K10.laneWindowMs } = {}) {
  if (!Number.isInteger(people) || people <= 0) throw new Error(`people은 1 이상의 정수여야 한다: ${people}`);
  if (!(windowMs > 0)) throw new Error(`windowMs는 0보다 커야 한다: ${windowMs}`);
  return { people: Array.from({ length: people }, (_, i) => i), windowMs };
}

/**
 * '판정이 멈춘 시간'(ms). QR을 댄 뒤 3초를 넘긴 대기만 센다.
 * 결과가 없으면 하네스의 기다림 상한(scanTimeoutMs)을 대기로 본다.
 * @param {{presentedAtMs?: number, verdictAtMs?: number}[]} samples
 */
export function stoppedTimeMs(samples, { stoppedAfterMs = K10.stoppedAfterMs, scanTimeoutMs = K10.scanTimeoutMs } = {}) {
  let total = 0;
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!Number.isFinite(s?.presentedAtMs)) continue;
    const latency = hasVerdict(s) ? s.verdictAtMs - s.presentedAtMs : scanTimeoutMs;
    if (latency > stoppedAfterMs) total += latency - stoppedAfterMs;
  }
  return total;
}

/** 판정 화면이 실제로 뜬 표본인가. 하네스는 결과가 없으면 0을 적는다(0은 '없음'이다). */
function hasVerdict(s) {
  return Number.isFinite(s?.verdictAtMs) && s.verdictAtMs > 0;
}

function latencyOf(s) {
  return Number.isFinite(s?.presentedAtMs) && hasVerdict(s) ? s.verdictAtMs - s.presentedAtMs : undefined;
}

/**
 * O-T40 판정. `run.scans`는 `{index, phase, presentedAtMs, decodedAtMs, verdictAtMs, result, error?}`다.
 * 통과: 300+30건, 결과 없음 0, 정상 티켓이 모두 PASS, 평소 p95 ≤ 150ms, 전환 앞뒤 최대 ≤ 150ms,
 *       멈춘 시간 0ms, 큐 0, 올린 기록에 빠짐·중복 0.
 */
export function judgeTransition(run, opts = {}) {
  const passMs = opts.passMs ?? K10.passMs;
  const stoppedAfterMs = opts.stoppedAfterMs ?? K10.stoppedAfterMs;
  const scanTimeoutMs = opts.scanTimeoutMs ?? K10.scanTimeoutMs;
  const reasons = [];
  if (run?.valid === false) reasons.push(`무효 실행: ${(Array.isArray(run.invalidReasons) && run.invalidReasons.length ? run.invalidReasons.join(' / ') : '까닭 없음')}`);
  const scans = Array.isArray(run?.scans) ? run.scans : [];
  const expectedScans = run?.expectedScans ?? K10.transitionScans + K10.recoveryScans;
  if (scans.length !== expectedScans) reasons.push(`판정 ${scans.length}/${expectedScans}건: 빠지거나 더 있다`);

  const missing = scans.filter((s) => !hasVerdict(s));
  if (missing.length > 0) reasons.push(`결과 없음 ${missing.length}건`);
  const errors = scans.filter((s) => s?.error || s?.result !== 'PASS');
  if (errors.length > 0) reasons.push(`오류·비정상 판정 ${errors.length}건`);

  const windows = run?.transitionWindows ?? transitionWindowIndexes();
  const inTransition = (s) => windows.some(([a, b]) => s?.index >= a && s?.index <= b);
  const warmup = run?.warmup ?? 0;
  // 평소 p95는 전환 창 밖의 온라인 구간에서 낸다. 전환 창의 표본은 아래 최댓값으로 따로 본다.
  const normalLatencies = scans
    .filter((s) => s?.phase === 'online' && s?.index > warmup && !inTransition(s))
    .map(latencyOf)
    .filter((v) => v !== undefined);
  const normalP95 = percentile(normalLatencies, 0.95);
  if (!Number.isFinite(normalP95)) reasons.push('평소 p95를 낼 온라인 표본이 없다');
  else if (!(normalP95 <= passMs)) reasons.push(`평소 p95 ${normalP95.toFixed(1)}ms > ${passMs}ms`);

  const inWindows = scans.filter(inTransition);
  const transitionLatencies = inWindows.map(latencyOf).filter((v) => v !== undefined);
  const transitionMax = transitionLatencies.length > 0 ? Math.max(...transitionLatencies) : undefined;
  if (!Number.isFinite(transitionMax)) reasons.push('전환 앞뒤 표본이 없다');
  else if (!(transitionMax <= passMs)) reasons.push(`전환 앞뒤 최대 ${transitionMax.toFixed(1)}ms > ${passMs}ms`);

  const stopped = stoppedTimeMs(scans, { stoppedAfterMs, scanTimeoutMs });
  if (stopped > 0) reasons.push(`멈춘 시간 ${stopped.toFixed(0)}ms > 0`);

  if (run?.queueAfter !== 0) reasons.push(`스캔 큐 ${run?.queueAfter ?? '없음'}건이 남았다`);

  const uploaded = Array.isArray(run?.uploadedIds) ? run.uploadedIds : undefined;
  const expectedUploaded = Array.isArray(run?.expectedUploadedIds) ? run.expectedUploadedIds : undefined;
  if (uploaded && expectedUploaded) {
    const set = new Set(uploaded);
    const missingUploads = expectedUploaded.filter((id) => !set.has(id));
    if (missingUploads.length > 0) reasons.push(`올리지 못한 기록 ${missingUploads.length}건`);
    if (uploaded.length !== expectedUploaded.length) reasons.push(`올린 기록 ${uploaded.length}/${expectedUploaded.length}건`);
  }
  if (uploaded) {
    const set = new Set(uploaded);
    if (uploaded.length !== set.size) reasons.push(`같은 기록을 두 번 올렸다(${uploaded.length - set.size}건)`);
  }
  if (Number.isFinite(run?.expectedUploadCount) && run?.uploadedCount !== run.expectedUploadCount) {
    reasons.push(`올린 기록 ${run?.uploadedCount ?? 0}/${run.expectedUploadCount}건`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    metrics: {
      scans: scans.length,
      expectedScans,
      missingCount: missing.length,
      errorCount: errors.length,
      normalP95Ms: normalP95,
      transitionMaxMs: transitionMax,
      stoppedMs: stopped,
      queueAfter: run?.queueAfter,
    },
  };
}

/**
 * O-T41 한 실행의 유효성. 실행 길이·사람 수·결과·네트워크·새로고침·호스트 포화를 본다.
 * `run`은 `{windowMs, verdicts, nonPass, missing, tickets, network, expectedNetwork, pageReloaded, hostCpuPercent}`다.
 */
export function laneRunValidity(run, opts = {}) {
  const windowMs = opts.windowMs ?? K10.laneWindowMs;
  const people = opts.people ?? K10.lanePeople;
  const toleranceMs = opts.toleranceMs ?? 5_000;
  const reasons = [];
  if (!(Math.abs((run?.windowMs ?? 0) - windowMs) <= toleranceMs)) reasons.push(`창 ${run?.windowMs ?? 0}ms가 ${windowMs}ms ±${toleranceMs}ms 밖이다`);
  if (!(run?.verdicts > 0)) reasons.push('판정이 0건이다');
  if ((run?.nonPass ?? 0) > 0) reasons.push(`정상 티켓인데 PASS가 아닌 판정 ${run.nonPass}건`);
  if ((run?.missing ?? 0) > 0) reasons.push(`결과 없음 ${run.missing}건`);
  const seen = new Set(Array.isArray(run?.roles) ? run.roles : Array.isArray(run?.tickets) ? run.tickets : []);
  if (seen.size < people) reasons.push(`사람 ${seen.size}/${people}명만 나왔다`);
  if (run?.pageReloaded) reasons.push('측정 중 페이지를 새로고침했다');
  if (run?.network !== run?.expectedNetwork) reasons.push(`네트워크 ${run?.network ?? '없음'} ≠ 계획 ${run?.expectedNetwork ?? '없음'}`);
  if (Number.isFinite(run?.hostCpuPercent) && run.hostCpuPercent > 80) reasons.push(`호스트 CPU ${run.hostCpuPercent}% > 80%`);
  return { valid: reasons.length === 0, reasons };
}

/**
 * O-T41 판정. 유효한 온라인·오프라인 각 3회의 분당 통과 인원 중앙값을 견준다.
 * 통과: 오프라인 × 100 ≥ 온라인 × 90.
 */
export function judgeLane({ onlineRuns = [], offlineRuns = [] } = {}, opts = {}) {
  const thresholdPercent = opts.thresholdPercent ?? K10.laneRatioPercent;
  const need = opts.runs ?? 3;
  const reasons = [];
  const online = onlineRuns.filter((r) => r?.valid);
  const offline = offlineRuns.filter((r) => r?.valid);
  if (online.length < need) reasons.push(`유효한 온라인 실행 ${online.length}/${need}`);
  if (offline.length < need) reasons.push(`유효한 오프라인 실행 ${offline.length}/${need}`);

  const onlineMedian = median(online.map((r) => r.perMinute));
  const offlineMedian = median(offline.map((r) => r.perMinute));
  if (!Number.isFinite(onlineMedian) || !(onlineMedian > 0)) reasons.push('온라인 분당 통과 인원 중앙값이 없다');
  else if (!Number.isFinite(offlineMedian)) reasons.push('오프라인 분당 통과 인원 중앙값이 없다');
  else if (!meetsRatio(offlineMedian, onlineMedian, thresholdPercent)) {
    reasons.push(`오프라인 ${offlineMedian.toFixed(2)}/분 ÷ 온라인 ${onlineMedian.toFixed(2)}/분 = ${ratioPercent(offlineMedian, onlineMedian).toFixed(1)}% < ${thresholdPercent}%`);
  }

  for (const r of [...online, ...offline]) {
    if ((r?.nonPass ?? 0) > 0) reasons.push(`${r?.condition ?? '?'} r${r?.run ?? '?'}: PASS가 아닌 판정 ${r.nonPass}건`);
    if ((r?.missing ?? 0) > 0) reasons.push(`${r?.condition ?? '?'} r${r?.run ?? '?'}: 결과 없음 ${r.missing}건`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    metrics: {
      onlineRuns: online.length,
      offlineRuns: offline.length,
      onlineMedian,
      offlineMedian,
      ratioPercent: ratioPercent(offlineMedian, onlineMedian),
      thresholdPercent,
    },
  };
}
