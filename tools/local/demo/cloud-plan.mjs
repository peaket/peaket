// BAT-086 임시 클라우드 데모 값 검사(docs/review/plans/BAT-086.md §1 G6, §5).
// - TTL ≤ 6시간 [가정], 시간당 추정 합 × TTL × 환율 ≤ 예산, 정리 차례에 여섯 항목, 서명 GHCR·실행 없음.
// - 실제 클라우드 자원을 만들지 않는다. 값의 산술과 필수 항목만 본다(계획 B13).
// - 경계: 예산과 딱 같으면 통과(≤). 1원이라도 넘으면 exit 1.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CLOUD_PLAN_FILE = join(REPO, 'deploy', 'demo', 'cloud-plan.yaml');
/** TTL 상한(시간). 계획 §12 [가정] */
export const MAX_TTL_HOURS = 6;
/** 정리 차례에 반드시 있어야 하는 항목 */
export const REQUIRED_CLEANUP = ['cluster', 'load-balancer', 'dns', 'secrets', 'volumes', 'logs'];

/** 시간당 달러 합계 */
export function hourlyUsdOf(plan) {
  return (plan.components ?? []).reduce((n, c) => n + Number(c.hourlyUsd ?? 0), 0);
}

/**
 * 값 검사. 문제 목록을 돌려준다(빈 배열이면 통과).
 * @param {any} plan
 * @returns {{ ok: boolean, problems: string[], hourlyUsd: number, hourlyKrw: number, estimatedKrw: number, ttlHours: number, budgetKrw: number }}
 */
export function checkCloudPlan(plan) {
  const problems = [];
  const ttlHours = Number(plan?.ttlHours);
  const budgetKrw = Number(plan?.budgetKrw);
  const fx = Number(plan?.fxKrwPerUsd);
  if (plan?.version !== 1) problems.push('version은 1이다');
  if (!(Number.isFinite(ttlHours) && ttlHours > 0)) problems.push(`ttlHours가 양수가 아니다: ${JSON.stringify(plan?.ttlHours)}`);
  if (ttlHours > MAX_TTL_HOURS) problems.push(`ttlHours(${ttlHours})가 상한 ${MAX_TTL_HOURS}시간을 넘었다`);
  if (!(Number.isFinite(budgetKrw) && budgetKrw > 0)) problems.push(`budgetKrw가 양수가 아니다: ${JSON.stringify(plan?.budgetKrw)}`);
  if (!(Number.isFinite(fx) && fx > 0)) problems.push(`fxKrwPerUsd가 양수가 아니다: ${JSON.stringify(plan?.fxKrwPerUsd)}`);
  const components = Array.isArray(plan?.components) ? plan.components : [];
  if (components.length === 0) problems.push('components가 비었다');
  for (const c of components) {
    if (!c?.key || !(Number.isFinite(Number(c.hourlyUsd)) && Number(c.hourlyUsd) >= 0)) problems.push(`구성 ${c?.key ?? '?'}의 hourlyUsd가 0 이상의 수가 아니다`);
  }
  const hourlyUsd = hourlyUsdOf(plan);
  const hourlyKrw = hourlyUsd * fx;
  const estimatedKrw = Number.isFinite(hourlyKrw * ttlHours) ? Math.ceil(hourlyKrw * ttlHours) : Number.POSITIVE_INFINITY;
  if (Number.isFinite(budgetKrw) && estimatedKrw > budgetKrw) problems.push(`시간당 추정 ${hourlyUsd.toFixed(4)}달러 × ${ttlHours}시간 × ${fx}원 = ${estimatedKrw}원이 예산 ${budgetKrw}원을 넘었다`);
  const cleanup = (Array.isArray(plan?.cleanup) ? plan.cleanup : []).map((x) => (typeof x === 'string' ? x : x?.key)).filter(Boolean);
  for (const key of REQUIRED_CLEANUP) if (!cleanup.includes(key)) problems.push(`정리 차례에 ${key}가 없다`);
  if (plan?.image?.source !== 'ghcr-signed') problems.push(`image.source가 ghcr-signed가 아니다: ${JSON.stringify(plan?.image?.source)}`);
  if (plan?.image?.pullSecrets !== false) problems.push('공개 GHCR 패키지는 끌어오기 비밀이 없어야 한다(image.pullSecrets: false)');
  if (plan?.image?.tagPolicy !== 'digest-only') problems.push('이미지는 다이제스트만 쓴다(image.tagPolicy: digest-only)');
  if (plan?.execution !== 'not-run') problems.push(`이 묶음은 실행하지 않는다(execution: not-run): ${JSON.stringify(plan?.execution)}`);
  return { ok: problems.length === 0, problems, hourlyUsd, hourlyKrw, estimatedKrw, ttlHours, budgetKrw };
}

/** 파일을 읽어 검사한다 */
export function loadAndCheck(file = CLOUD_PLAN_FILE) {
  const plan = parseYaml(readFileSync(file, 'utf8'));
  return { plan, ...checkCloudPlan(plan) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const check = argv.includes('--check') || argv.length === 0;
  const unknown = argv.filter((a) => !['--check', '--json'].includes(a));
  if (unknown.length) {
    console.error(`cloud-plan의 모르는 인자: ${unknown.join(', ')}(쓰는 법: --check [--json])`);
    process.exit(2);
  }
  if (!check) process.exit(0);
  let r;
  try {
    r = loadAndCheck();
  } catch (e) {
    console.error(`클라우드 계획을 읽지 못했다: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (json) console.log(JSON.stringify({ ok: r.ok, problems: r.problems, hourlyUsd: r.hourlyUsd, hourlyKrw: r.hourlyKrw, estimatedKrw: r.estimatedKrw, ttlHours: r.ttlHours, budgetKrw: r.budgetKrw }, null, 2));
  else if (r.ok) console.log(`클라우드 계획이 맞다: 시간당 ${r.hourlyUsd.toFixed(4)}달러 × ${r.ttlHours}시간 = ${r.estimatedKrw}원(예산 ${r.budgetKrw}원)`);
  else console.error(r.problems.join('\n'));
  process.exit(r.ok ? 0 : 1);
}
