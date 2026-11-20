// BAT-086 운영 판 호환 검사 시연(계획 §1 G5, D-T48 시연). 실제 저장소·원격·태그는 건드리지 않는다.
// - 임시 복제본(`git clone --shared`)에서 `develop`을 HEAD에 만들고 contract-breaking을 한 번 돌린다(같은 커밋 → 통과).
// - 기준 커밋에 `v0.0.0` 태그를 붙이고, 응답 스키마(Problem)의 필드 하나를 지운 커밋을 만든다.
//   (출시 태그 규칙 tools/ci/release-tags.mjs가 vX.Y.Z만 받아 계획의 v0.0.0-demo 대신 v0.0.0을 쓴다)
//   마지막 출시 태그와 견주는 검사가 실패하고 지운 필드 이름(traceId)을 출력해야 한다.
// - 도구가 0이 아닌 코드로 끝나면 통과로 세지 않는다. Docker가 없으면 exit 2(오류)다.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_WORK = join(REPO, '.cache', 'peaket-tools', 'demo-compat');
// ?? ?? ??(tools/ci/release-tags.mjs)? vX.Y.Z? ???. ??? ?? ??? v0.0.0? ??(??? v0.0.0-demo? ?? ?)
export const DEMO_TAG = 'v0.0.0';
const MAX_BUFFER = 32 * 1024 * 1024;
const tail = (s, n = 4000) => (String(s ?? '').length > n ? `…${String(s ?? '').slice(-n)}` : String(s ?? ''));

/** compat 인자: --work <폴더>, --json */
export function compatPlan(argv = []) {
  let work = DEFAULT_WORK;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--work') {
      const v = argv[++i];
      if (!v) throw new Error('--work에는 폴더를 준다');
      work = resolve(v);
    } else throw new Error(`compat의 모르는 인자: ${a}(쓰는 법: compat [--work <폴더>] [--json])`);
  }
  return { work, json };
}

function git(cwd, args, o = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: o.timeout ?? 120_000, maxBuffer: MAX_BUFFER });
  if (r.error) throw new Error(`git을 부르지 못했다: ${r.error.message}`);
  if (r.status !== 0 && !o.allowFail) throw new Error(`git ${args.join(' ')} → ${r.status}\n${tail(`${r.stdout ?? ''}${r.stderr ?? ''}`)}`);
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 임시 복제본 폴더만 지운다(다른 폴더를 실수로 지우지 않게 이름·자리를 본다) */
export function resetWorkDir(work, repo = REPO) {
  const cached = resolve(repo, '.cache', 'peaket-tools');
  const allowed = resolve(work) === resolve(cached, 'demo-compat') || resolve(work).startsWith(`${cached}${process.platform === 'win32' ? '\\' : '/'}`) || basename(work).includes('demo-compat');
  if (!allowed) throw new Error(`compat은 자기 임시 폴더만 지운다: ${work}(이름에 demo-compat이 있거나 .cache/peaket-tools 안이어야 한다)`);
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}

/**
 * 계약을 깨는 변경 하나: components.schemas.Problem.properties의 필드 하나를 지운다.
 * oasdiff가 응답 스키마 속성 삭제(response-property-removed)로 읽고 필드 이름을 출력한다.
 * @param {string} text openapi.yaml
 * @returns {{ text: string, field: string }}
 */
export function breakOpenApi(text) {
  const lines = String(text).split('\n');
  const schema = lines.findIndex((l) => /^    Problem:\s*$/.test(l));
  if (schema < 0) throw new Error('openapi.yaml에서 components.schemas.Problem을 찾지 못했다');
  let props = -1;
  for (let i = schema + 1; i < Math.min(schema + 12, lines.length); i += 1) {
    if (/^      properties:\s*$/.test(lines[i])) {
      props = i;
      break;
    }
    if (/^    [A-Za-z]/.test(lines[i])) break;
  }
  if (props < 0) throw new Error('Problem 스키마의 properties를 찾지 못했다');
  for (let i = props + 1; i < lines.length; i += 1) {
    if (!/^        /.test(lines[i])) break;
    const m = /^        ([A-Za-z0-9_]+):/.exec(lines[i]);
    if (!m) continue;
    const out = [...lines.slice(0, i), ...lines.slice(i + 1)];
    return { text: out.join('\n'), field: m[1] };
  }
  throw new Error('Problem 스키마에서 지울 속성 줄을 찾지 못했다');
}

function dockerReady() {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 60_000 });
  return r.status === 0;
}

/**
 * 계약 검사 한 번. 주입한 `run`은 (cwd, args) → { status, out }를 돌려준다(시험이 가짜 도구로 바꾼다).
 * 기본은 저장소의 tools/ci/contract-breaking.mjs를 그 복제본에서 부른다.
 */
export function defaultRun(cwd) {
  const r = spawnSync(process.execPath, [join(cwd, 'tools', 'ci', 'contract-breaking.mjs'), '--target', 'develop'], { cwd, encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: MAX_BUFFER });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 호환 검사 시연. 복제본 밖은 건드리지 않는다.
 * @param {{ repo?: string, work?: string, run?: (cwd: string) => { status: number, out: string }, docker?: () => boolean }} [o]
 * @returns {{ ok: boolean, code: number, steps: Array<{ name: string, exit: number, pass: boolean, note?: string }>, work: string, tag: string, field?: string, reason?: string }}
 */
export async function runCompat(o = {}) {
  const repo = resolve(o.repo ?? REPO);
  const work = resolve(o.work ?? DEFAULT_WORK);
  const run = o.run ?? defaultRun;
  const docker = o.docker ?? dockerReady;
  const steps = [];
  const result = (ok, code, reason) => ({ ok, code, steps, work, tag: DEMO_TAG, reason });
  if (!docker()) return result(false, 2, 'Docker가 없다. contract-breaking은 고정 이미지(oasdiff·AsyncAPI CLI)를 돌린다');

  try {
    resetWorkDir(work, repo);
    git(repo, ['clone', '--shared', repo, work], { timeout: 10 * 60_000 });
    git(work, ['checkout', '-B', 'develop']);
    git(work, ['config', 'user.email', 'demo@peaket.test']);
    git(work, ['config', 'user.name', 'BAT-086 compat']);
    // 이 복제본에서만 출시 태그를 지운다. ①의 뜻은 '출시 태그가 없는 같은 커밋'이다(실제 저장소 태그는 그대로)
    const tags = git(work, ['tag', '--list', 'v*']).out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const t of tags) git(work, ['tag', '-d', t]);
    const base = git(work, ['rev-parse', 'HEAD']).out.trim();

    // ① 같은 커밋끼리(출시 태그 없음)는 통과해야 한다
    const first = run(work);
    steps.push({ name: 'same-commit', exit: first.status, pass: first.status === 0, note: first.status === 0 ? undefined : tail(first.out, 1500) });
    if (first.status !== 0) return result(false, 1, '같은 커밋끼리의 검사가 통과하지 못했다(도구 오류도 통과로 세지 않는다)');

    // ② 마지막 출시 태그를 기준 커밋에 붙이고, 응답 필드 하나를 지운 커밋을 만든다
    git(work, ['tag', DEMO_TAG, base]);
    const file = join(work, 'docs', 'api', 'openapi.yaml');
    const broken = breakOpenApi(readFileSync(file, 'utf8'));
    writeFileSync(file, broken.text);
    git(work, ['add', 'docs/api/openapi.yaml']);
    git(work, ['commit', '-m', `test: 계약 깨짐 시연(${broken.field} 삭제)`, '--no-verify']);
    const second = run(work);
    const namesField = second.status !== 0 && String(second.out).includes(broken.field);
    steps.push({ name: 'release-tag-diff', exit: second.status, pass: namesField, note: namesField ? undefined : tail(second.out, 1500) });
    if (second.status === 0) return result(false, 1, `마지막 출시 태그(${DEMO_TAG})와 견줬는데 검사가 통과했다(깨짐을 못 봤다)`);
    if (!namesField) return result(false, 1, `검사가 실패했지만 지운 필드(${broken.field})를 출력하지 않았다`);
    return { ...result(true, 0), field: broken.field };
  } catch (e) {
    return result(false, 1, e instanceof Error ? e.message : String(e));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let plan;
  try {
    plan = compatPlan(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const r = await runCompat(plan);
  if (plan.json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const s of r.steps) console.log(`${s.pass ? '통과' : '실패'} ${s.name}(exit ${s.exit})${s.note ? `\n${s.note}` : ''}`);
    if (r.ok) console.log(`운영 판 호환 검사 시연 통과: 같은 커밋은 통과, ${DEMO_TAG} 태그와 견주면 ${r.field ?? '계약'} 삭제를 잡았다`);
    else console.error(`운영 판 호환 검사 시연 실패(exit ${r.code}): ${r.reason ?? '까닭 없음'}`);
  }
  process.exit(r.code);
}
