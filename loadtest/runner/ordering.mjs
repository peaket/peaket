// F-08-4(MSR-040) 정렬 설정 켬·끔 비교의 판정·보고서 도구(순수 함수).
//
// 정본: docs/features/queue-admission.md Q-T1(653행)·Q-T23(675행), ADR-0011·0012·0118,
//       docs/verification.md §3.5(측정 정직성). 계획: docs/review/plans/F-08-4.md §6·§7·§9.
// 이 파일은 Docker·k6·클러스터를 모른다. 실행기는 loadtest/run.mjs와 시나리오가 맡고,
// 여기서는 인자·셀·판정·보고서 표시만 다룬다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UsageError } from './args.mjs';

/** 운영 셋과 시험 기준선 하나. `none`(둘 다 끔)은 운영 구성이 아니다(ADR-0118 결정 2). */
export const ORDERING_CELLS = Object.freeze([
  Object.freeze({ id: 'hybrid', label: '하이브리드', lobbyShuffle: true, openBatch: true, operating: true }),
  Object.freeze({ id: 'fifo', label: '선착순', lobbyShuffle: false, openBatch: true, operating: true }),
  Object.freeze({ id: 'prequeue', label: '사전 셔플', lobbyShuffle: true, openBatch: false, operating: true }),
  Object.freeze({ id: 'none', label: '기준선(운영 아님)', lobbyShuffle: false, openBatch: false, operating: false }),
]);

const CELL_BY_ID = new Map(ORDERING_CELLS.map((c) => [c.id, c]));
const OPERATING_IDS = ORDERING_CELLS.filter((c) => c.operating).map((c) => c.id);

/** 10만 상태와 보고서 표시에 쓰는 값. 이 밖의 값은 통과로 읽지 않는다. */
export const MEASURE_STATUSES = Object.freeze([
  '실측(PC)',
  '계산',
  '[추정]',
  '문서 인용',
  '설계 목표',
  '미측정',
  '무효',
  '판정 못 함',
  '부분',
  '기준선(운영 아님)',
]);

const STATUS_SET = new Set(MEASURE_STATUSES);
const TENK_STATUSES = new Set(['실측(PC)', '무효', '미측정', '판정 못 함', '부분']);
const RUN_ID = /20\d{2}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*/g;

const VALUE_FLAGS = new Set([
  '--users',
  '--cells',
  '--out',
  '--bot-rate',
  '--batch-window-ms',
  '--warm',
  '--main',
  '--run-id-prefix',
]);

/**
 * `node loadtest/runner/ordering.mjs`의 인자를 읽는다.
 * 시험 계획 §9의 공개 인자: --users, --cells, --out, --baseline, --bot-rate,
 * --batch-window-ms, --warm, --main, --record, --run-id-prefix.
 */
export function parseOrderingArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const out = {
    users: null,
    cells: [...OPERATING_IDS],
    baseline: false,
    botRate: 0.05,
    batchWindowMs: 2000,
    warmS: 10,
    mainS: 30,
    out: null,
    record: false,
    runIdPrefix: null,
  };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--baseline') {
      out.baseline = true;
      continue;
    }
    if (flag === '--record') {
      out.record = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      if (flag.startsWith('--')) throw new UsageError(`모르는 인자다: ${flag}`);
      throw new UsageError(`값 없이 남은 인자다: ${flag}`);
    }
    const raw = args[++i];
    if (raw === undefined || raw.startsWith('--')) throw new UsageError(`${flag} 값이 없다`);
    if (flag === '--users') {
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`--users는 1 이상의 정수여야 한다: ${raw}`);
      out.users = n;
    } else if (flag === '--cells') {
      const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length === 0) throw new UsageError('--cells가 비었다');
      for (const id of list) {
        if (id === 'none') throw new UsageError('기준선(none)은 --cells에 넣지 않고 --baseline으로만 더한다');
        if (!CELL_BY_ID.has(id) || !CELL_BY_ID.get(id).operating) throw new UsageError(`모르는 셀이다: ${id}`);
      }
      out.cells = [...new Set(list)];
    } else if (flag === '--out') {
      out.out = raw;
    } else if (flag === '--bot-rate') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new UsageError(`--bot-rate는 0~1이어야 한다: ${raw}`);
      out.botRate = n;
    } else if (flag === '--batch-window-ms') {
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`--batch-window-ms는 1 이상의 정수여야 한다: ${raw}`);
      out.batchWindowMs = n;
    } else if (flag === '--warm') {
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 0) throw new UsageError(`--warm은 0 이상의 정수여야 한다: ${raw}`);
      out.warmS = n;
    } else if (flag === '--main') {
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`--main은 1 이상의 정수여야 한다: ${raw}`);
      out.mainS = n;
    } else if (flag === '--run-id-prefix') {
      out.runIdPrefix = raw;
    }
  }

  if (out.users === null) throw new UsageError('--users가 필요하다');
  if (!out.out) throw new UsageError('--out이 필요하다');
  return out;
}

/** 평균 순위(동점은 같은 순위의 평균). 값이 작을수록 작은 순위(1부터)다. */
function averageRanks(values) {
  const sorted = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ranks = new Array(values.length);
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && sorted[j][0] === sorted[i][0]) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) ranks[sorted[k][1]] = rank;
    i = j;
  }
  return ranks;
}

/**
 * 표준 스피어만(동점은 평균 순위로 바꾼 뒤 순위 피어슨).
 * 길이가 다르거나 n<3이면 null. 한쪽 분산이 0이면 속도 차이가 없다는 뜻으로 0.
 */
export function spearman(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 3) return null;
  if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const n = rx.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx;
    const dy = ry[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  const rho = cov / Math.sqrt(vx * vy);
  return Math.max(-1, Math.min(1, rho));
}

const medianOf = (values) => {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const m = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[m] : (nums[m - 1] + nums[m]) / 2;
};

/** 같은 셀의 회차들을 중앙값으로 줄인다. 빈 회차는 null이고 0으로 바꾸지 않는다. */
export function summarizeCell(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const valid = list.filter((r) => r && r.valid === true);
  return {
    valid: valid.length > 0,
    runs: valid.length,
    t0PeakRps: medianOf(valid.map((r) => r.t0PeakRps)),
    entryP99Ms: medianOf(valid.map((r) => r.entryP99Ms)),
    errorRate: medianOf(valid.map((r) => r.errorRate)),
    dropped: valid.reduce((a, r) => a + (Number.isFinite(r.dropped) ? r.dropped : 0), 0),
  };
}

const result = (verdict, reasons, extra = {}) => ({ verdict, reasons, ...extra });

/**
 * Q-T1 여섯 조건. 통과는 여섯이 모두 측정되고 기준을 지킬 때만이다.
 * 하나라도 없으면 미측정, 어기면 미달, 회차·발생기 무효는 판정 못 함.
 */
export function judgeQT1({ on, off } = {}) {
  const reasons = [];
  if (!on || !off) return result('판정 못 함', ['두 칸(켬·끔)이 모두 있어야 한다']);
  for (const [name, cell] of [['켬', on], ['끔', off]]) {
    if (cell.valid !== true) return result('판정 못 함', [`${name} 칸 회차가 유효하지 않다`]);
    if (!(Number.isFinite(cell.runs) && cell.runs >= 3)) return result('판정 못 함', [`${name} 칸 회차가 3회 미만이다`]);
    if (Number.isFinite(cell.dropped) && cell.dropped > 0) return result('판정 못 함', [`${name} 칸 발생기 놓침이 ${cell.dropped}건이다`]);
    if (!Number.isFinite(cell.entryP99Ms) || !Number.isFinite(cell.errorRate) || !Number.isFinite(cell.t0PeakRps)) {
      return result('판정 못 함', [`${name} 칸 성능 값이 없다`]);
    }
  }
  if (!(off.t0PeakRps > 0)) return result('판정 못 함', ['끔 칸 T=0 최고 RPS가 0이다']);
  const peakRatio = on.t0PeakRps / off.t0PeakRps;
  if (peakRatio > 0.5) reasons.push(`T=0 최고 RPS 비율 ${peakRatio.toFixed(3)} > 0.5`);
  if (on.entryP99Ms > 200) reasons.push(`켬 칸 진입 p99 ${on.entryP99Ms}ms > 200ms`);
  if (off.entryP99Ms > 200) reasons.push(`끔 칸 진입 p99 ${off.entryP99Ms}ms > 200ms`);
  if (on.errorRate >= 0.001) reasons.push(`켬 칸 오류율 ${on.errorRate} ≥ 0.1%`);
  if (off.errorRate >= 0.001) reasons.push(`끔 칸 오류율 ${off.errorRate} ≥ 0.1%`);
  if (reasons.length) return result('미달', reasons, { peakRatio });

  const missing = [];
  if (!Number.isFinite(on.waitRho)) missing.push('대기 시간 분산(스피어만)');
  if (!Number.isFinite(on.falsePositiveRate)) missing.push('일반 사용자 오탐률');
  if (!Number.isFinite(on.originalSeqGuarantee)) missing.push('추가 검증 통과자 원래 순번 보장률');
  if (on.botPenetration === null || on.botPenetration === undefined) missing.push('봇 유형별 침투 성공률');
  if (missing.length) return result('미측정', missing.map((m) => `${m}이 없다`), { peakRatio });

  if (Math.abs(on.waitRho) > 0.05) reasons.push(`대기 시간-도착 시각 스피어만 ${on.waitRho} > 0.05`);
  if (on.falsePositiveRate > 0.005) reasons.push(`오탐률 ${on.falsePositiveRate} > 0.5%`);
  if (on.originalSeqGuarantee < 1) reasons.push(`원래 순번 보장률 ${on.originalSeqGuarantee} < 100%`);
  if (reasons.length) return result('미달', reasons, { peakRatio });
  return result('통과', ['Q-T1 여섯 조건을 지켰다'], { peakRatio });
}

/**
 * Q-T23 두 쌍(hybrid/prequeue, fifo/none)을 판정한다. `none`은 기준선(운영 아님)이다.
 * `botDelta = off.botSuccess - on.botSuccess`이고, ADR-0118의 되돌릴 조건 판단에 쓴다.
 */
export function judgeQT23({ on, off } = {}) {
  const reasons = [];
  if (!on || !off) return result('판정 못 함', ['두 칸(켬·끔)이 모두 있어야 한다'], { baseline: false, botDelta: null });
  for (const [name, cell] of [['켬', on], ['끔', off]]) {
    if (cell.valid === false) return result('판정 못 함', [`${name} 칸 회차가 유효하지 않다`], { baseline: off.operating === false, botDelta: null });
    if (Number.isFinite(cell.runs) && cell.runs < 3) return result('판정 못 함', [`${name} 칸 회차가 3회 미만이다`], { baseline: off.operating === false, botDelta: null });
    if (Number.isFinite(cell.dropped) && cell.dropped > 0) return result('판정 못 함', [`${name} 칸 발생기 놓침이 ${cell.dropped}건이다`], { baseline: off.operating === false, botDelta: null });
  }
  const baseline = off.operating === false;
  const botDelta = Number.isFinite(on.botSuccess) && Number.isFinite(off.botSuccess) ? off.botSuccess - on.botSuccess : null;
  const missing = [];
  for (const [name, cell] of [['켬', on], ['끔', off]]) {
    if (!Number.isFinite(cell.rho)) missing.push(`${name} 칸 스피어만`);
    if (!Number.isFinite(cell.p90ArrivalMs)) missing.push(`${name} 칸 도착 p90`);
    if (!Number.isFinite(cell.publishMs)) missing.push(`${name} 칸 결과 파일 게시 시간`);
    if (cell.proofMatches === null || cell.proofMatches === undefined) missing.push(`${name} 칸 검증 재계산 일치`);
  }
  if (missing.length) return result('판정 못 함', missing.map((m) => `${m}이 없다`), { baseline, botDelta });

  if (Math.abs(on.rho) > 0.05) reasons.push(`켬 칸 스피어만 ${on.rho} > 0.05`);
  if (Math.abs(off.rho) > 0.05) reasons.push(`끔 칸 스피어만 ${off.rho} > 0.05`);
  if (on.p90ArrivalMs > 2000) reasons.push(`켬 칸 도착 p90 ${on.p90ArrivalMs}ms > 2,000ms`);
  if (off.p90ArrivalMs > 2000) reasons.push(`끔 칸 도착 p90 ${off.p90ArrivalMs}ms > 2,000ms`);
  if (on.publishMs > 5000) reasons.push(`켬 칸 게시 ${on.publishMs}ms > 5,000ms`);
  if (off.publishMs > 5000) reasons.push(`끔 칸 게시 ${off.publishMs}ms > 5,000ms`);
  if (on.proofMatches !== true) reasons.push('켬 칸 검증 재계산이 게시 결과와 다르다');
  if (off.proofMatches !== true) reasons.push('끔 칸 검증 재계산이 게시 결과와 다르다');
  if (reasons.length) return result('미달', reasons, { baseline, botDelta });
  return result('통과', [`${on.id} 대 ${off.id} Q-T23 조건을 지켰다`], { baseline, botDelta });
}

/** 봇 성공률: 최종 순번이 좌석 수(입장 가능 수) 이하인 봇의 비율. 표본이 없으면 null. */
export function botSuccess(participants, capacity) {
  if (capacity === null || capacity === undefined || !Number.isFinite(capacity)) return null;
  const groups = new Map();
  for (const p of Array.isArray(participants) ? participants : []) {
    const kind = p?.kind;
    if (!kind) continue;
    const g = groups.get(kind) ?? { hit: 0, total: 0 };
    g.total += 1;
    if (Number.isFinite(p.sequence) && p.sequence <= capacity) g.hit += 1;
    groups.set(kind, g);
  }
  const rate = (kind) => {
    const g = groups.get(kind);
    return g && g.total > 0 ? g.hit / g.total : null;
  };
  return { human: rate('human'), speed: rate('speed'), volume: rate('volume') };
}

/**
 * 10만 비교 상태. `실측(PC)`는 실행 ID·표본률 99% 이상·세 회차 같은 방향일 때만이다.
 * 그 밖의 상태는 그대로 돌려주고, 모르는 상태는 거부한다.
 */
export function tenKStatus({ status, runIds, sampleRate, runVerdicts } = {}) {
  if (!TENK_STATUSES.has(status)) throw new Error(`10만 상태는 ${[...TENK_STATUSES].join('·')}만 허용한다: ${status}`);
  if (status !== '실측(PC)') return status;
  if (!Array.isArray(runIds) || runIds.length === 0) throw new Error('실측(PC)에는 실행 ID가 필요하다');
  if (!Number.isFinite(sampleRate)) throw new Error('실측(PC)에는 표본률(sampleRate)이 필요하다');
  if (!Array.isArray(runVerdicts) || runVerdicts.length !== 3) throw new Error('실측(PC)에는 세 회차 방향(runVerdicts)이 필요하다');
  if (sampleRate < 0.99) return '부분';
  if (new Set(runVerdicts.map(String)).size !== 1) return '부분';
  return '실측(PC)';
}

const yesNo = (v) => (v ? '켬' : '끔');
const operatingText = (v) => (v ? '예' : '아니오');

/**
 * 측정 보고서 뼈대를 만든다. 셀 표, 운영 셀 요약, 측정 표, 10만 표, ADR 결론을 쓴다.
 * 숫자 줄에는 반드시 표시(미측정 등)를 둔다.
 */
export function renderReport({ title, cells = ORDERING_CELLS, rows = [], tenK = { status: '미측정' }, adr = { conclusion: '판단 보류' } } = {}) {
  const list = Array.isArray(cells) && cells.length > 0 ? cells : ORDERING_CELLS;
  const operating = list.filter((c) => c.operating === true).length;
  const baseline = list.filter((c) => c.operating === false).length;
  const cellRows = list.map((c) => {
    const status = c.status ?? (c.operating ? '미측정' : '기준선(운영 아님)');
    return `| ${c.id} | ${yesNo(c.lobbyShuffle)} | ${yesNo(c.openBatch)} | ${operatingText(c.operating)} | ${status} |`;
  });
  const rowLines = rows.map((r) => `| ${r.section} | ${r.item} | ${r.value} | ${r.status} | ${r.runId ?? '—'} |`);
  const tenKStatusText = tenK.status ?? '미측정';
  return [
    `# ${title ?? 'F-08-4 정렬 설정 비교 측정 보고서'}`,
    '',
    '| 셀 | 로비 셔플 | 오픈 직후 묶음 | 운영 | 상태 |',
    '| --- | --- | --- | --- | --- |',
    ...cellRows,
    '',
    `- 운영 셀: ${operating} · 기준선 셀: ${baseline}`,
    '',
    '| 절 | 항목 | 값 | 표시 | 실행 ID |',
    '| --- | --- | --- | --- | --- |',
    ...rowLines,
    '',
    '| 구분 | 값 | 표시 | 실행 ID |',
    '| --- | --- | --- | --- |',
    `| 10만 비교 | 10만 순번 표본·부하 지표 | ${tenKStatusText} | — |`,
    '',
    '## ADR 재검토',
    `- 결론: ${adr.conclusion ?? '판단 보류'}`,
    '',
  ].join('\n');
}

function forbiddenClaim(line) {
  const claim =
    /(?:30,?000|3만)\s*(?:건)?\s*\/\s*초/.test(line) ||
    /초당\s*(?:30,?000|3만)\s*건/.test(line) ||
    /(?:30,?000|3만)\s*RPS/.test(line) ||
    /100만[^\n]{0,60}(?:달성|가능|확인|통과|버틴|처리했)/.test(line) ||
    /K[127][^\n]{0,100}(?:통과|pass|달성)/i.test(line);
  if (!claim) return false;
  return !/주장하지 않|확인하지 않|확인 못|미확인|재지 않|판정 못 함|미달|무효|부분|1\/3|3회 중 1회|1회 통과|일부|불가|동결|미측정/.test(line);
}

/**
 * 보고서 검사. 셀 표의 운영 칸을 직접 세어 요약과 맞추고, 숫자 줄 표시·금지 주장·
 * 실행 ID를 본다. `runExists`를 주면 실행 ID가 장부에 있는지도 본다.
 * 반환: { operatingCells, baselineCells }.
 */
export function validateReport(markdown, { runExists } = {}) {
  if (typeof markdown !== 'string') throw new Error('보고서가 문자열이 아니다');
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  let operatingCells = 0;
  let baselineCells = 0;
  const cellIds = new Set();

  for (const raw of lines) {
    const line = raw.trim();
    const m = /^\| (hybrid|fifo|prequeue|none) \|/.exec(line);
    if (!m) continue;
    const cells = line.slice(1, -1).split('|').map((s) => s.trim());
    if (cells.length !== 5) throw new Error(`셀 표의 칸 수가 다르다: ${line}`);
    const [id, , , operating, status] = cells;
    cellIds.add(id);
    if (operating === '예') operatingCells += 1;
    else if (operating === '아니오') baselineCells += 1;
    else throw new Error(`셀 표의 운영 칸은 예/아니오여야 한다: ${line}`);
    if (status.includes('실측(PC)')) {
      const ids = [...line.matchAll(RUN_ID)].map((x) => x[0]);
      if (ids.length === 0) throw new Error(`실측(PC) 줄에 실행 ID가 없다: ${line}`);
      if (typeof runExists === 'function') {
        for (const rid of ids) if (!runExists(rid)) throw new Error(`실행 ID가 장부에 없다: ${rid}`);
      }
    }
    if (id === 'none' && (operating !== '아니오' || status !== '기준선(운영 아님)')) {
      throw new Error(`none은 기준선(운영 아님)·운영 아니오여야 한다: ${line}`);
    }
  }
  if (cellIds.size !== 4) throw new Error(`셀 표에 네 셀이 있어야 한다: ${[...cellIds].join(',') || '없음'}`);
  const summary = /^- 운영 셀: (\d+) · 기준선 셀: (\d+)$/m.exec(markdown);
  if (!summary) throw new Error('운영 셀 요약 줄이 없다');
  if (Number(summary[1]) !== operatingCells || Number(summary[2]) !== baselineCells) {
    throw new Error(`운영 셀 요약이 셀 표와 다르다: 운영 셀 ${operatingCells}`);
  }
  if (operatingCells !== 3 || baselineCells !== 1) {
    throw new Error(`운영 셀은 3, 기준선 셀은 1이어야 한다: 운영 셀 ${operatingCells}`);
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|') || /^\|\s*-/.test(line)) continue;
    if (/^\| (hybrid|fifo|prequeue|none) \|/.test(line)) continue;
    if (/^\| (셀|절|구분) \|/.test(line)) continue;
    const hasDigit = /\d/.test(line);
    const status = MEASURE_STATUSES.find((s) => line.includes(s));
    if (hasDigit && !status) throw new Error(`표시가 없는 숫자 줄: ${line}`);
    if (line.includes('실측(PC)')) {
      const ids = [...line.matchAll(RUN_ID)].map((m) => m[0]);
      if (ids.length === 0) throw new Error(`실측(PC) 줄에 실행 ID가 없다: ${line}`);
      if (typeof runExists === 'function') {
        for (const id of ids) if (!runExists(id)) throw new Error(`실행 ID가 장부에 없다: ${id}`);
      }
    }
    if (forbiddenClaim(line)) throw new Error(`금지된 수치 주장: ${line}`);
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.includes('10만')) continue;
    if (/10만[^\n]*실측\(PC\)/.test(line) && !/순번 표본/.test(line)) {
      throw new Error(`10만 실측(PC)는 순번 표본일 때만이다: ${line}`);
    }
    break;
  }
  return { operatingCells, baselineCells };
}

/**
 * ADR-0012·0118 재검토 초안. ADR 상태를 바꾸지 않고(adrChanges는 항상 빈 배열),
 * 측정 상태와 Q-T1·Q-T23 결과로 결론만 고른다.
 */
export function reviewAdrs({ q1, q23, tenK, partnerChoice } = {}) {
  const adrChanges = [];
  const hold = (reason) => ({ conclusion: '판단 보류', reasons: [reason, '측정 전이라 판단을 보류한다'], adrChanges, next: '측정 창 4에서 Q-T1·Q-T23을 잰 뒤 다시 본다.' });
  if (!tenK || !['실측(PC)', '부분'].includes(tenK.status)) return hold(`10만 비교가 ${tenK?.status ?? '미측정'}이다`);
  if (!q1 || q1.verdict === '판정 못 함' || !q23 || q23.verdict === '판정 못 함') return hold('Q-T1·Q-T23 판정이 아직 서지 않았다');
  const bs = q23.botSuccess;
  if (!bs || !Number.isFinite(bs.hybrid) || !Number.isFinite(bs.prequeue)) return hold('봇 성공률이 없어 ADR-0118 되돌릴 조건을 볼 수 없다');

  const delta = Math.round((bs.prequeue - bs.hybrid) * 10000) / 10000;
  if (delta >= 0.1) {
    return {
      conclusion: 'openBatch 고정 검토',
      reasons: [`prequeue 봇 성공률 - hybrid = ${delta} ≥ 0.1`],
      adrChanges,
      next: '새 ADR 초안과 소유자 결정이 필요하다.',
    };
  }
  if (Number.isFinite(q1.peakRatio) && q1.peakRatio > 0.5) {
    return {
      conclusion: '로비 셔플 재검토',
      reasons: [`T=0 최고 RPS 비율 ${q1.peakRatio} > 0.5`],
      adrChanges,
      next: '로비 셔플의 공정성·봇 저항 근거를 소유자·파트너와 다시 본다.',
    };
  }
  return {
    conclusion: '현행 유지',
    reasons: ['ADR-0118의 되돌릴 조건에 닿는 측정 차이가 없다', partnerChoice ? '파트너 선택 자료가 있다' : '파트너 선택 분포는 자료 없음'],
    adrChanges,
    next: '측정 결과를 보고서에 남기고 ADR은 그대로 둔다.',
  };
}

/** 셀 id로 정의를 찾는다(시나리오·계획 파일이 함께 쓴다). */
export const orderingCell = (id) => CELL_BY_ID.get(id) ?? null;

// ── 명령줄: 보고서 뼈대를 만들거나 검사한다(측정 담당이 쓴다) ──
function cliOptions(argv) {
  const out = { command: argv[0] ?? null, input: null, out: null };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' || arg === '--out') {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} 값이 없다`);
      out[arg.slice(2)] = value;
    } else if (arg === '--help' || arg === '-h') {
      out.command = 'help';
    } else {
      throw new UsageError(`모르는 인자다: ${arg}`);
    }
  }
  return out;
}

function cliRun(argv) {
  const o = cliOptions(argv);
  if (o.command === 'help' || o.command === null) {
    process.stdout.write('사용: node loadtest/runner/ordering.mjs report --input <json> --out <md>\n');
    process.stdout.write('      node loadtest/runner/ordering.mjs validate --input <md>\n');
    return;
  }
  if (!o.input) throw new UsageError('--input이 필요하다');
  if (o.command === 'report') {
    if (!o.out) throw new UsageError('report에는 --out이 필요하다');
    const data = JSON.parse(readFileSync(o.input, 'utf8'));
    const md = renderReport(data);
    validateReport(md);
    writeFileSync(o.out, md, 'utf8');
    process.stdout.write(`보고서 뼈대를 썼다: ${o.out}\n`);
    return;
  }
  if (o.command === 'validate') {
    const md = readFileSync(o.input, 'utf8');
    const res = validateReport(md, { runExists: (id) => existsSync(join(process.cwd(), 'docs', 'perf-ledger', 'runs', id)) });
    process.stdout.write(`보고서 검사 통과: 운영 셀 ${res.operatingCells} · 기준선 셀 ${res.baselineCells}\n`);
    return;
  }
  throw new UsageError(`모르는 명령이다: ${o.command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    cliRun(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e?.message ?? String(e)}\n`);
    process.exitCode = 2;
  }
}
