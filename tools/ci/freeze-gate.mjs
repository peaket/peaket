#!/usr/bin/env node
// 변경 동결 승격 게이트(docs/devops.md §5.1·§5.3·§8.1·§8.2·§8.4, D-T2·D-T4·D-T5·D-T26, F-02-3 OPS-320).
// `gitops-check`와 gitops-check 워크플로가 부른다. 운영(prod) 승격 PR만 보고, 큰 창은 모든 운영 변경을,
// 작은 창은 핫패스 배포 단위만 막는다. 달력이 없거나 2시간 넘게 낡았으면 막고(fail-closed),
// 긴급 변경은 라벨·인시던트·허용 모양(되돌리기·플래그 끄기·오토스케일 정지)을 모두 갖출 때만 통과시킨다.
// 쓰는 법: node tools/ci/freeze-gate.mjs --check [--root <폴더>] [--env prod] [--now <ISO>] [--changed <파일,…>]
//          [--labels <라벨,…>] [--body <본문 파일>] [--body-text <본문>] [--base <git 기준>]
// 환경 변수: PEAKET_CHANGED_FILES(줄·쉼표), PEAKET_PR_LABELS(쉼표), PEAKET_PR_BODY, PEAKET_PR_BASE
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { runIfMain } from './entry.mjs';

export const FREEZE_CALENDAR_FILE = 'deploy/calendar/freeze.json';
export const STALE_WARN_MS = 30 * 60_000;
export const STALE_BLOCK_MS = 2 * 60 * 60_000;
export const EMERGENCY_LABEL = 'emergency-change';
export const INCIDENT = /INC-(\d+)/i;
const PROD = 'deploy/envs/prod/';
const GATEWAY = 'deploy/gateways/';
const INFRA = 'infra/';
const FLAGS = 'deploy/envs/prod/flags/';
const DIGEST = /^\s*digest:\s*["']?(sha256:[0-9a-f]{64})["']?\s*$/m;

/** 소형 창에서 막는 핫패스 배포 단위(docs/devops.md §8.1). 배포 단위 이름과 게이트웨이 경로를 쓴다 */
export const HOTPATH_WORKLOADS = new Set([
  'gw-queue',
  'gw-fan',
  'queue-svc',
  'admission-control',
  'admission-ctrl',
  'purchase-svc',
  'payment-svc',
  'realtime-gw',
  'identity-svc',
  'web',
  'queue-room',
]);

const toPosix = (p) => String(p).replaceAll('\\', '/');
const unique = (xs) => [...new Set(xs)];
const has = (file, root) => existsSync(join(root, file)) && statSync(join(root, file)).isFile();
const readText = (root, rel) => {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return undefined;
  }
};

/** 달력 파일을 읽는다. 없음·깨짐은 게이트가 막을 수 있게 오류로 돌려준다 */
export function readCalendar(root) {
  const file = join(root, FREEZE_CALENDAR_FILE);
  if (!existsSync(file)) return { error: 'calendar-missing' };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { error: 'calendar-unreadable', detail: 'JSON' };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'calendar-unreadable', detail: '객체 아님' };
  if (typeof doc.renderedAt !== 'string' || !Number.isFinite(Date.parse(doc.renderedAt))) {
    return { error: 'calendar-unreadable', detail: 'renderedAt' };
  }
  if (!Array.isArray(doc.windows)) return { error: 'calendar-unreadable', detail: 'windows' };
  for (const w of doc.windows) {
    if (w === null || typeof w !== 'object') return { error: 'calendar-unreadable', detail: 'window' };
    if (typeof w.eventId !== 'string' || !w.eventId) return { error: 'calendar-unreadable', detail: 'eventId' };
    if (w.scope !== 'all' && w.scope !== 'hotpath') return { error: 'calendar-unreadable', detail: 'scope' };
    for (const k of ['startsAt', 'endsAt']) {
      if (typeof w[k] !== 'string' || !Number.isFinite(Date.parse(w[k]))) return { error: 'calendar-unreadable', detail: k };
    }
    if (Date.parse(w.startsAt) >= Date.parse(w.endsAt)) return { error: 'calendar-unreadable', detail: 'startsAt>=endsAt' };
  }
  return { calendar: doc };
}

/** 창이 지금 유효한가(`startsAt ≤ now < endsAt`) */
export function activeWindowsAt(calendar, nowMs) {
  return calendar.windows.filter((w) => Date.parse(w.startsAt) <= nowMs && nowMs < Date.parse(w.endsAt));
}

/** 운영 승격 PR이 바꾸는 파일 가운데 게이트가 보는 것(운영 값·게이트웨이·인프라) */
export function relevantProdChanges(files) {
  return unique(files.map(toPosix).filter((p) => p.startsWith(PROD) || p.startsWith(GATEWAY) || p.startsWith(INFRA)));
}

/** 소형 창에서 막는 핫패스 변경인가 */
export function isHotpathChange(file) {
  const p = toPosix(file);
  if (p.startsWith(GATEWAY)) return true;
  const m = /^deploy\/envs\/prod\/([^/]+)\.ya?ml$/.exec(p);
  return m ? HOTPATH_WORKLOADS.has(m[1]) : false;
}

function flagOff(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch {
    return false;
  }
  if (doc === false) return true;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return false;
  return doc.enabled === false || doc.value === false || doc.enabled === 'off' || doc.defaultVariant === 'off';
}

function digestOf(text) {
  return DIGEST.exec(text)?.[1];
}

/** 대상 가지(baseRef)의 조상 이력에 그 다이제스트가 있었는가. 조회 실패는 거부(보수적) */
function digestInHistory(root, rel, digest, baseRef) {
  try {
    const out = execFileSync('git', ['log', baseRef, '--format=%H', '--', rel], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const sha of out.split(/\r?\n/).filter(Boolean)) {
      try {
        const text = execFileSync('git', ['show', `${sha}:${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (digestOf(text) === digest) return true;
      } catch {
        // 그 판에 파일이 없으면 건너뛴다
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * 긴급 변경 모양. 라벨·인시던트가 없거나 모양이 허용 밖이면 거부한다.
 * @returns {{ok:true, shape:'rollback'|'flag-off'|'autoscale-pause', incident:string} | {ok:false, reason:string}}
 */
function emergencyOf(root, relevant, labels, body, baseRef) {
  if (!labels.includes(EMERGENCY_LABEL)) return { ok: false, reason: 'emergency-label-missing' };
  const m = INCIDENT.exec(body ?? '');
  if (!m) return { ok: false, reason: 'emergency-incident-missing' };
  const incident = `INC-${m[1]}`;

  // ① 이전에 쓰던 이미지 다이제스트로 되돌리기(대상 가지 조상 이력만)
  if (relevant.every((p) => p.startsWith(PROD))) {
    let rollback = true;
    for (const p of relevant) {
      const text = readText(root, p);
      const digest = text === undefined ? undefined : digestOf(text);
      if (!digest || !digestInHistory(root, p, digest, baseRef)) {
        rollback = false;
        break;
      }
    }
    if (rollback && relevant.length > 0) return { ok: true, shape: 'rollback', incident };
  }

  // ② 릴리스 플래그 끄기
  if (relevant.length > 0 && relevant.every((p) => p.startsWith(FLAGS))) {
    if (relevant.every((p) => {
      const text = readText(root, p);
      return text !== undefined && flagOff(text);
    })) return { ok: true, shape: 'flag-off', incident };
  }

  // ③ KEDA 오토스케일 정지 주석
  if (relevant.length > 0 && relevant.every((p) => readText(root, p)?.includes('autoscaling.keda.sh/paused-replicas'))) {
    return { ok: true, shape: 'autoscale-pause', incident };
  }

  return { ok: false, reason: 'emergency-shape-not-allowed' };
}

/**
 * 승격 게이트 판정. `decision: skip`은 게이트 대상 아님, `allow`는 통과, `block`은 거부.
 * @param {{
 *   root?: string, nowMs?: number, env?: string, changedFiles?: string[], labels?: string[],
 *   body?: string, baseRef?: string
 * }} o
 */
export function gatePromotion(o = {}) {
  const root = resolve(o.root ?? process.cwd());
  const nowMs = o.nowMs ?? Date.now();
  const env = o.env ?? 'prod';
  const warnings = [];
  const result = (decision, reasons, extra = {}) => ({ decision, reasons, warnings, ...extra });

  if (!Number.isFinite(nowMs)) return result('block', ['now-invalid']);
  if (env !== 'prod') return result('skip', [`env-${env}-not-prod`]);
  const relevant = relevantProdChanges(o.changedFiles ?? []);
  if (relevant.length === 0) return result('skip', ['no-prod-change']);

  const read = readCalendar(root);
  if (read.error) return result('block', [read.error]);
  const calendar = read.calendar;
  const age = nowMs - Date.parse(calendar.renderedAt);
  if (age > STALE_WARN_MS) warnings.push(`calendar-stale-warning:${Math.round(age / 60_000)}m`);
  if (age > STALE_BLOCK_MS) return result('block', ['calendar-stale']);

  const active = activeWindowsAt(calendar, nowMs);
  const blocked = active.filter(
    (w) => w.scope === 'all' || (w.scope === 'hotpath' && relevant.some((p) => isHotpathChange(p))),
  );
  if (blocked.length === 0) {
    return result('allow', age > STALE_WARN_MS ? ['no-active-freeze-window-with-stale-calendar'] : ['no-active-freeze-window']);
  }

  const reasons = blocked.map((w) => `freeze-window-active:${w.eventId}:${w.scope}`);
  const emergencyAttempt = (o.labels ?? []).includes(EMERGENCY_LABEL) || INCIDENT.test(o.body ?? '');
  if (!emergencyAttempt) return result('block', reasons);
  const emergency = emergencyOf(root, relevant, o.labels ?? [], o.body ?? '', o.baseRef ?? 'HEAD');
  if (emergency.ok) {
    return result('allow', [`emergency-change:${emergency.shape}`], {
      override: { label: EMERGENCY_LABEL, incident: emergency.incident, shape: emergency.shape },
      audit: { kind: 'security', event: 'freeze_override', label: EMERGENCY_LABEL, incident: emergency.incident, shape: emergency.shape },
    });
  }
  return result('block', [...reasons, emergency.reason]);
}

const USAGE =
  '쓰는 법: node tools/ci/freeze-gate.mjs --check [--root <폴더>] [--env prod] [--now <ISO>] [--changed <파일,…>] [--labels <라벨,…>] [--body <본문 파일>] [--body-text <본문>] [--base <git 기준>]';

/** @param {string[]} argv */
export function main(argv) {
  let check = false;
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let env = 'prod';
  let nowMs = Date.now();
  let changed = [];
  let labels = [];
  let body = '';
  let baseRef = 'HEAD';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--root') {
      if (!argv[i + 1]) return usage('--root 뒤에 폴더가 없다');
      root = resolve(argv[++i]);
    } else if (a === '--env') {
      if (!argv[i + 1]) return usage('--env 뒤에 값이 없다');
      env = argv[++i];
    } else if (a === '--now') {
      const text = argv[++i];
      const ms = text ? Date.parse(text) : NaN;
      if (!text || !Number.isFinite(ms)) return usage('--now는 ISO 시각이어야 한다');
      nowMs = ms;
    } else if (a === '--changed') {
      if (!argv[i + 1]) return usage('--changed 뒤에 파일이 없다');
      changed = changed.concat(argv[++i].split(',').map((x) => x.trim()).filter(Boolean));
    } else if (a === '--labels') {
      if (!argv[i + 1]) return usage('--labels 뒤에 라벨이 없다');
      labels = labels.concat(argv[++i].split(',').map((x) => x.trim()).filter(Boolean));
    } else if (a === '--body') {
      if (!argv[i + 1]) return usage('--body 뒤에 파일이 없다');
      try {
        body = readFileSync(resolve(argv[++i]), 'utf8');
      } catch {
        return usage('--body 파일을 읽지 못했다');
      }
    } else if (a === '--body-text') {
      if (argv[i + 1] === undefined) return usage('--body-text 뒤에 본문이 없다');
      body = argv[++i];
    } else if (a === '--base') {
      if (!argv[i + 1]) return usage('--base 뒤에 git 기준이 없다');
      baseRef = argv[++i];
    } else return usage(`모르는 인자 ${a}`);
  }
  if (!check) return usage('--check가 필요하다');

  if (process.env.PEAKET_CHANGED_FILES) changed = changed.concat(process.env.PEAKET_CHANGED_FILES.split(/[\r\n,]+/).map((x) => x.trim()).filter(Boolean));
  if (process.env.PEAKET_PR_LABELS) labels = labels.concat(process.env.PEAKET_PR_LABELS.split(',').map((x) => x.trim()).filter(Boolean));
  if (process.env.PEAKET_PR_BODY) body = body || process.env.PEAKET_PR_BODY;
  if (process.env.PEAKET_PR_BASE) baseRef = baseRef === 'HEAD' ? process.env.PEAKET_PR_BASE : baseRef;

  const g = gatePromotion({ root, env, nowMs, changedFiles: changed, labels, body, baseRef });
  if (g.decision === 'block') {
    console.log(`fail freeze-gate: ${g.reasons.join(' / ')}`);
    return 1;
  }
  if (g.decision === 'skip') {
    console.log(`skip freeze-gate: ${g.reasons.join(' / ')}`);
    return 0;
  }
  console.log(`ok freeze-gate: ${g.reasons.join(' / ')}`);
  if (g.audit) console.log(`audit ${JSON.stringify(g.audit)}`);
  for (const w of g.warnings) console.log(`warn freeze-gate: ${w}`);
  return 0;
}

function usage(message) {
  console.error(`freeze-gate: ${message}\n${USAGE}`);
  return 2;
}

await runIfMain(import.meta.url, () => main(process.argv.slice(2)));
