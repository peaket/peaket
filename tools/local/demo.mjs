#!/usr/bin/env node
// BAT-086 데모 재현 스크립트(docs/review/plans/BAT-086.md §1 G1·G7, 정본 docs/verification.md §7·V-T7).
// 한 명령 `node tools/local/demo.mjs all`이 무대(cluster.mjs demo) → 기본 시드 → S1~S9 재생 → 측정 → 정리까지 한다.
// - 선행이 없으면 닫힌 실패(exit 1)다. 경고만 하고 계속하지 않는다(계획 B4).
// - 모르는 시나리오·인자는 exit 2(설정 오류)다. '건너뜀'으로 세지 않는다(계획 B4·B15).
// - 비밀·토큰은 출력·측정에 싣지 않는다(V-T7 ⑥). demo-auth가 만든 값은 .cache에만 있다.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_IMAGES } from './demo-images.mjs';
import { DEMO_WORKLOADS } from './demo-objects.mjs';
import { DEFAULT_ROOT } from './tools.mjs';
import { SCENARIOS, SCENARIO_ORDER, validateScenarios, publicPlan } from './demo/scenarios.mjs';
import { measurementText, writeMeasurement } from './demo/measure.mjs';
import { loadAndCheck as loadCloudPlan } from './demo/cloud-plan.mjs';
import { compatPlan, runCompat } from './demo/compat.mjs';
import { DEMO_CONSENT_VERSION, runScenarios, stageProblems } from './demo/runner.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEMO_CLUSTER = 'lane4-demo';
/** 데모 오버레이가 있어야 하는 워크로드(demo-status의 기대와 같다) */
const OVERLAY_WORKLOADS = [...new Set(DEMO_WORKLOADS.map((w) => w.name))];
const USAGE = `쓰는 법: node tools/local/demo.mjs <명령> [옵션]
  doctor  [--root <저장소>] [--json]                 선행(시드·오버레이·Playwright·Docker/kind/kubectl/helm) 점검
  plan    [--check] [--json]                          S1~S9 정의를 정본 d5 §10.6과 대조
  up      [--skip-build] [--cluster <이름>]           데모 무대 올리기(cluster.mjs demo)
  seed    [--reset] [--json]                          기본 합성 시드 적용(cluster.mjs demo-seed --apply)
  play    [--scenarios S1,S2|all] [--headed] [--video] [--json]   S1~S9 재생
  status  [--json]                                    데모 워크로드 준비 상태
  compat  [--work <폴더>] [--json]                    운영 판 호환 검사 시연(D-T48)
  cloud-plan [--check] [--json]                       임시 클라우드 데모 값 검사(실행 없음)
  down    [--cluster <이름>] [--keep-cluster]         데모 네임스페이스와 kind 클러스터 정리
  all     [--scenarios all] [--skip-build] [--seed-only] [--skip-play] [--keep] [--headed] [--video] [--json]
                                                      한 명령: 무대 → 시드 → S1~S9 → 측정 → 정리
  --measure <파일>                                    측정 파일(기본 docs/review/measurements/BAT-086-demo.md)
끝 코드: 0 통과, 1 실패·선행 없음, 2 인자·설정 오류`;

/** 인자를 명령별로 읽는다. 모르는 인자는 던진다(호출한 쪽이 exit 2로 바꾼다) */
export function parseArgs(argv) {
  const cmd = argv[0];
  const o = { cmd, root: REPO, scenarios: ['all'], json: false, check: false, headed: false, video: false, keep: false, skipBuild: false, seedOnly: false, skipPlay: false, reset: false, keepCluster: false, cluster: process.env.PEAKET_DEMO_CLUSTER || DEMO_CLUSTER, work: undefined, measure: join(REPO, 'docs', 'review', 'measurements', 'BAT-086-demo.md') };
  const take = (i) => {
    const v = argv[i + 1];
    if (!v) throw new Error(`${argv[i]}에는 값이 필요하다`);
    return v;
  };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--check') o.check = true;
    else if (a === '--headed') o.headed = true;
    else if (a === '--video') o.video = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--skip-build') o.skipBuild = true;
    else if (a === '--seed-only') o.seedOnly = true;
    else if (a === '--skip-play') o.skipPlay = true;
    else if (a === '--reset') o.reset = true;
    else if (a === '--keep-cluster') o.keepCluster = true;
    else if (a === '--root') o.root = resolve(take(i++));
    else if (a === '--scenarios') {
      const v = take(i++);
      if (v === 'all') o.scenarios = ['all'];
      else {
        const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
        const bad = ids.filter((id) => !SCENARIO_ORDER.includes(id));
        if (bad.length) throw new Error(`모르는 시나리오: ${bad.join(', ')}(쓸 수 있는 것: ${SCENARIO_ORDER.join(', ')})`);
        o.scenarios = ids;
      }
    } else if (a === '--cluster') o.cluster = take(i++);
    else if (a === '--work') o.work = resolve(take(i++));
    else if (a === '--measure') o.measure = resolve(take(i++));
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`모르는 인자: ${a}`);
  }
  const known = ['doctor', 'plan', 'up', 'seed', 'play', 'status', 'compat', 'cloud-plan', 'down', 'all', 'help'];
  if (!known.includes(cmd)) throw new Error(`모르는 명령: ${cmd ?? '(없음)'}`);
  return o;
}

/** PATH와 PATHEXT에서 실행 파일을 찾는다(도구가 없으면 undefined). 명령을 실행하지는 않는다 */
export function findOnPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? ['', ...String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  for (const dir of String(env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, `${name}${ext}`);
      try {
        if (statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return undefined;
}

/** `.cache/peaket-tools`의 내려받은 도구(도구 이름-판 폴더)를 찾는다. 명령을 실행하지 않는다 */
export function findCachedTool(root, name, env = process.env) {
  const base = env.PEAKET_TOOLS_DIR || join(root, '.cache', 'peaket-tools');
  if (!existsSync(base)) return undefined;
  const exts = process.platform === 'win32' ? ['', '.exe', '.EXE'] : [''];
  let entries = [];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    for (const ext of exts) {
      const p = join(base, e.name, `${name}${ext}`);
      try {
        if (statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return undefined;
}

/**
 * 선행 점검. 파일·도구를 모두 보고, 빠진 것을 전부 모아 돌려준다(계획 B4).
 * 클러스터 명령은 부르지 않는다(V-T7 ②: 가짜 kubectl 기록 0).
 * @param {string} root 저장소 뿌리(가짜 뿌리 시험용)
 */
export function doctorChecks(root = REPO, env = process.env) {
  const problems = [];
  const tools = {};
  const file = (what, p) => {
    if (!existsSync(p)) problems.push({ what, path: p });
  };
  file('데모 시드', join(root, 'deploy', 'envs', 'demo', 'seed', 'base.yaml'));
  const overlay = join(root, 'deploy', 'envs', 'local', 'demo');
  if (!existsSync(overlay)) problems.push({ what: '로컬 데모 오버레이', path: overlay });
  else for (const w of OVERLAY_WORKLOADS) file(`데모 오버레이의 ${w}`, join(overlay, `${w}.yaml`));
  file('데모 이미지 목록', join(root, 'tools', 'local', 'demo-images.mjs'));
  file('데모 무대 스크립트', join(root, 'tools', 'local', 'cluster.mjs'));
  file('기본 시드 적용기', join(root, 'tools', 'local', 'demo-seed.mjs'));
  file('Playwright', join(root, 'tools', 'web-checks', 'node_modules', '@playwright', 'test', 'package.json'));
  for (const t of ['docker', 'kind', 'kubectl', 'helm']) {
    const p = findOnPath(t, env) ?? findCachedTool(root, t, env);
    tools[t] = p ?? null;
    if (!p) problems.push({ what: `도구 ${t}`, path: `PATH 또는 .cache/peaket-tools의 ${t}` });
  }
  return { ok: problems.length === 0, problems, tools, root };
}

function toolVersion(name, args = ['--version']) {
  try {
    const r = spawnSync(name, args, { encoding: 'utf8', timeout: 20_000 });
    if (r.status !== 0) return '없음';
    return String(r.stdout ?? r.stderr ?? '').trim().split('\n')[0].slice(0, 120) || '있음';
  } catch {
    return '없음';
  }
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return '알 수 없음';
  }
}

function jsonOut(o, value) {
  if (o.json) console.log(JSON.stringify(value, null, 2));
}

function runNode(script, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'local', script), ...args], {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    timeout: 4 * 60 * 60_000,
  });
  return r.status ?? 1;
}

/** 표준 출력을 모아 두는 실행(정리처럼 '이미 없음'을 성공으로 읽어야 하는 곳) */
function runNodeSoft(script, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'local', script), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  return { status: r.status ?? 1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 서브프로세스의 표준 출력을 읽어 JSON으로(도구 출력에 앞줄이 섞여도 마지막 JSON을 찾는다) */
function runNodeJson(script, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'local', script), ...args], { cwd: REPO, encoding: 'utf8', timeout: 4 * 60 * 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...extraEnv } });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  let json;
  for (let i = text.indexOf('{'); i >= 0 && json === undefined; i = text.indexOf('{', i + 1)) {
    try {
      json = JSON.parse(text.slice(i));
    } catch {}
  }
  return { status: r.status ?? 1, json, text };
}

/** 데모 클러스터 이름을 자식 프로세스와 같은 환경 값으로 맞춘다 */
function demoEnv(o) {
  return { ...process.env, PEAKET_CLUSTER: o.cluster, PEAKET_DEMO_CLUSTER: o.cluster };
}

function measurementOf(report, o, cleanup, outcome) {
  const found = doctorChecks(o.root).tools;
  return {
    commit: gitHead(),
    date: new Date().toISOString(),
    pc: `${process.platform} ${release()} · ${cpus()[0]?.model ?? 'CPU'} · Node ${process.version} · Playwright tools/web-checks 1.64.1`,
    tools: {
      node: process.version,
      docker: toolVersion(found.docker ?? 'docker', ['--version']),
      kind: toolVersion(found.kind ?? 'kind', ['version']),
      kubectl: toolVersion(found.kubectl ?? 'kubectl', ['version', '--client', '--output=json']),
      playwright: '1.64.1(tools/web-checks)',
    },
    coldStartSeconds: report?.coldStartSeconds,
    scenarios: (report?.scenarios ?? []).map((s) => ({ ...s })),
    cleanup,
    outcome,
    command: `node tools/local/demo.mjs ${o.cmd}${o.skipBuild ? ' --skip-build' : ''}${o.keep ? ' --keep' : ''}`,
    notes: [
      'S1·S3·S4·S6은 구매 세션 서명(ECDH+HKDF)으로 실제 API와 데모 PG 시뮬레이터를 끝까지 부른다.',
      'S2는 대기열 Redis notice를 데모 전용으로 매진으로 바꾸고(공개 API에 재고 0 쓰기가 없다) 매진 화면의 [취소표 알림 받기] 실패·[다시 시도] 문구를 재생한다. 취소표 알림 신청 API는 제품에 없다(404).',
      'S3는 실패·결과 불명 주문을 남기므로 S9가 취소하는 E-1 대신 E-4(팬미팅)에서 돌린다. S9의 일괄 환불을 미완료 주문이 막지 않게 하기 위한 시나리오 분리다.',
      'S5는 팬 재인증 토큰(identity gRPC IssueReauthToken, act FAN_SENSITIVE·op TICKET_CANCEL)을 발급해 취소 견적·취소 API를 끝까지 부른다. 양도 API는 제품에 없어 화면만 연다.',
      'S6의 판매 심사 제출 API는 제품에 없다(BAT-616 미병합, 404). 데모 전용 SQL로 sale_review만 SUBMITTED로 두고 판매 승인은 실제 ops API로 부른다.',
      'S7은 패스키 재인증(시드 개인키로 WebAuthn assertion) 뒤 요청자 자기 승인 403·두 번째 commander 승인·감사 기록을 본다. S9는 파트너 요청·commander 판정·두 번째 commander 확정·일괄 환불을 본다.',
      'S8은 보존한 DPoP 기기 키로 기기 등록·승인 로그인·스캔 업로드를 하고, 판정 넷(통과·거부·확인 필요·이상 표시)을 티켓 원장에서 확인한다. 시드 티켓에 게이트 구역이 비어 있어 데모 전용 SQL로 기기 배치 구역을 티켓에 적는다.',
      'S9의 회차 취소 환불 반복은 합본의 purchase-relay 자식이 돈다(운영은 별도 outbox-relay Deployment).',
      'S1 홈(/v1/home)은 제품에 없어 500이고, 화면 증거로만 연다(판정 checks에는 넣지 않는다).',
      `데모 동의 문안 판은 ${DEMO_CONSENT_VERSION}이다(서버 값과 다르면 422 consent-version-outdated).`,
    ],
  };
}

/** 데모 네임스페이스와 kind 클러스터를 지운다. 실패해도 계속하고 결과 문장을 돌려준다(두 번 불러도 안전) */
function cleanupStage(cluster) {
  const a = runNodeSoft('cluster.mjs', ['demo-down'], { PEAKET_CLUSTER: cluster, PEAKET_DEMO_CLUSTER: cluster });
  const gone = /NotFound|does not exist|connection refused|no such host|GetFileAttributesEx|unable to recognize|couldn't get current server/i.test(a.text);
  const b = runNodeSoft('cluster.mjs', ['down'], { PEAKET_CLUSTER: cluster, PEAKET_DEMO_CLUSTER: cluster });
  const ok = (a.status === 0 || gone) && b.status === 0;
  return ok ? '지움(데모 네임스페이스+kind 클러스터)' : `실패(demo-down ${a.status}${gone ? '(이미 없음)' : ''}, kind down ${b.status})`;
}

/** all: 무대 → 시드 → 재생 → 측정 → 정리 */
async function runAll(o, log) {
  const startedAt = Date.now();
  const issues = doctorChecks(o.root);
  let report;
  let cleanup = o.keep ? '남김(--keep)' : '아직';
  let outcome;
  if (!issues.ok) {
    log('선행이 모자란다. 고치기 전에는 무대를 올리지 않는다(닫힌 실패):');
    for (const p of issues.problems) log(`  - ${p.what}: ${p.path}`);
    outcome = '실패(선행 없음)';
    report = { coldStartSeconds: undefined, scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, result: '미실행', reason: '선행 없음' })) };
    writeMeasurement(o.measure, measurementOf(report, o, cleanup, outcome));
    return 1;
  }
  log('① 데모 무대');
  const upStatus = runNode('cluster.mjs', ['demo', ...(o.skipBuild ? ['--skip-build'] : [])], { PEAKET_CLUSTER: o.cluster, PEAKET_DEMO_CLUSTER: o.cluster });
  if (upStatus !== 0) {
    outcome = `실패(무대 exit ${upStatus})`;
    report = { coldStartSeconds: undefined, scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, result: '미실행', reason: `무대 exit ${upStatus}` })) };
    cleanup = o.keep ? '남김(--keep)' : cleanupStage(o.cluster);
    writeMeasurement(o.measure, measurementOf(report, o, cleanup, outcome));
    return 1;
  }
  log('② 기본 합성 시드');
  const seed = runNodeJson('cluster.mjs', ['demo-seed', '--apply', '--json'], { PEAKET_CLUSTER: o.cluster, PEAKET_DEMO_CLUSTER: o.cluster });
  if (seed.status !== 0) {
    outcome = `실패(시드 exit ${seed.status})`;
    report = { coldStartSeconds: undefined, scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, result: '미실행', reason: '시드 실패' })) };
    cleanup = o.keep ? '남김(--keep)' : cleanupStage(o.cluster);
    writeMeasurement(o.measure, measurementOf(report, o, cleanup, outcome));
    return 1;
  }
  if (o.seedOnly) {
    outcome = '통과(시드만)';
    writeMeasurement(o.measure, measurementOf({ scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, result: '미실행', reason: '--seed-only' })) }, o, o.keep ? '남김(--keep)' : '남김(--seed-only)', outcome));
    return 0;
  }
  log('③ S1~S9 재생');
  const stage = stageProblems({ env: demoEnv(o) });
  if (!stage.ok) {
    outcome = `실패(${stage.reason})`;
    report = { coldStartSeconds: undefined, scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, result: '미실행', reason: stage.reason })) };
    cleanup = o.keep ? '남김(--keep)' : '아직';
    if (!o.keep) {
      runNode('cluster.mjs', ['demo-down'], { PEAKET_CLUSTER: o.cluster, PEAKET_DEMO_CLUSTER: o.cluster });
      runNode('cluster.mjs', ['down'], { PEAKET_CLUSTER: o.cluster, PEAKET_DEMO_CLUSTER: o.cluster });
      cleanup = '지움(네임스페이스+클러스터)';
    }
    writeMeasurement(o.measure, measurementOf(report, o, cleanup, outcome));
    return 1;
  }
  report = o.skipPlay
    ? { coldStartSeconds: undefined, scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, result: '미실행', reason: '--skip-play' })), ok: true }
    : await play(o, log, true);
  outcome = report.ok ? '통과' : '실패';
  if (!o.keep) {
    log('④ 정리');
    cleanup = cleanupStage(o.cluster);
    if (!cleanup.startsWith('지움')) outcome = `${outcome}(정리 실패)`;
  } else cleanup = '남김(--keep)';
  const measured = measurementOf(report, o, cleanup, outcome);
  measured.coldStartSeconds = report.coldStartSeconds;
  writeMeasurement(o.measure, measured);
  log(`⑤ 측정: ${o.measure}`);
  return report.ok && cleanup.startsWith('지움') ? 0 : 1;
}

/** 재생 한 번(공개 함수: play 명령과 all이 함께 쓴다) */
async function play(o, log, fromAll = false) {
  const ids = o.scenarios.includes('all') ? SCENARIO_ORDER : o.scenarios;
  const chosen = SCENARIOS.filter((s) => ids.includes(s.id));
  const contractFile = process.env.PEAKET_DEMO_CONTRACT || join(DEFAULT_ROOT, 'demo-contract.json');
  if (!existsSync(contractFile)) {
    throw new Error(`데모 접속 정보가 없다: ${contractFile}. 먼저 \`node tools/local/demo.mjs up\`을 한다(닫힌 실패)`);
  }
  const contract = JSON.parse(readFileSync(contractFile, 'utf8'));
  log(`재생 ${chosen.map((s) => s.id).join('·')}(접속 정보 ${contractFile})`);
  const report = await runScenarios({
    repo: REPO,
    scenarios: chosen,
    contract,
    artifactsDir: join(DEFAULT_ROOT, 'demo-artifacts'),
    headed: o.headed,
    video: o.video,
    log,
  });
  const failed = report.scenarios.filter((s) => s.result !== '통과');
  log(`재생 결과: ${report.scenarios.length - failed.length}/${report.scenarios.length} 통과${failed.length ? `, 실패 ${failed.map((s) => s.id).join('·')}` : ''}`);
  if (!fromAll && o.measure) {
    const outcome = report.ok ? '통과' : '실패';
    writeMeasurement(o.measure, measurementOf(report, o, '—(play만 실행)', outcome));
  }
  return report;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) {
    console.log(USAGE);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error(USAGE);
    process.exit(2);
  }
  const log = (s) => console.log(s);
  try {
    if (o.help) {
      console.log(USAGE);
      return 0;
    }
    if (o.cmd === 'doctor') {
      const r = doctorChecks(o.root);
      jsonOut(o, r);
      if (!r.ok) {
        if (!o.json) {
          console.error(`선행이 모자란다(${r.problems.length}가지):`);
          for (const p of r.problems) console.error(`  - ${p.what}: ${p.path}`);
        }
        return 1;
      }
      if (!o.json) {
        console.log('선행이 모두 있다:');
        console.log(`  시드 ${join(o.root, 'deploy', 'envs', 'demo', 'seed', 'base.yaml')}`);
        console.log(`  오버레이 ${join(o.root, 'deploy', 'envs', 'local', 'demo')} (${OVERLAY_WORKLOADS.length}개 워크로드)`);
        console.log(`  Playwright tools/web-checks 1.64.1 · Docker ${r.tools.docker ? '있음' : '없음'} · kind·kubectl·helm 있음`);
        console.log(`  데모 이미지 ${DEMO_IMAGES.length}개 정의(tools/local/demo-images.mjs)`);
      }
      return 0;
    }
    if (o.cmd === 'plan') {
      const r = validateScenarios(SCENARIOS, { docPath: join(o.root, 'docs', 'design', 'd5-screen-blueprint.md') });
      jsonOut(o, o.check ? { ...r } : publicPlan());
      if (!r.ok) {
        if (!o.json) console.error(r.problems.join('\n'));
        return 1;
      }
      if (!o.json && o.check) console.log(`시나리오 ${r.scenarios.length}개가 정본 d5 §10.6과 같다`);
      return 0;
    }
    if (o.cmd === 'cloud-plan') {
      const r = loadCloudPlan(join(REPO, 'deploy', 'demo', 'cloud-plan.yaml'));
      jsonOut(o, { ok: r.ok, problems: r.problems, hourlyUsd: r.hourlyUsd, hourlyKrw: r.hourlyKrw, estimatedKrw: r.estimatedKrw, ttlHours: r.ttlHours, budgetKrw: r.budgetKrw });
      if (!r.ok) {
        if (!o.json) console.error(r.problems.join('\n'));
        return 1;
      }
      if (!o.json) console.log(`클라우드 계획이 맞다: 시간당 ${r.hourlyUsd.toFixed(4)}달러 × ${r.ttlHours}시간 = ${r.estimatedKrw}원(예산 ${r.budgetKrw}원)`);
      return 0;
    }
    if (o.cmd === 'compat') {
      const r = await runCompat({ ...compatPlan(['--work', o.work ?? join(DEFAULT_ROOT, 'demo-compat')]), repo: REPO, work: o.work ?? join(DEFAULT_ROOT, 'demo-compat') });
      jsonOut(o, r);
      if (!o.json) {
        for (const s of r.steps) console.log(`${s.pass ? '통과' : '실패'} ${s.name}(exit ${s.exit})${s.note ? `\n${s.note}` : ''}`);
        console.log(r.ok ? `운영 판 호환 검사 시연 통과: 같은 커밋 통과, ${r.tag} 태그와 견주면 ${r.field} 삭제를 잡았다` : `운영 판 호환 검사 시연 실패: ${r.reason ?? ''}`);
      }
      return r.code;
    }
    if (o.cmd === 'status') {
      const r = stageProblems({ env: demoEnv(o) });
      jsonOut(o, r);
      if (!r.ok) {
        if (!o.json) console.error(r.problems.join('\n'));
        return 1;
      }
      if (!o.json) console.log(`데모 워크로드가 준비됐다(${DEMO_WORKLOADS.length + 2}개)`);
      return 0;
    }
    if (o.cmd === 'down') {
      const a = runNodeSoft('cluster.mjs', ['demo-down'], { PEAKET_CLUSTER: o.cluster, PEAKET_DEMO_CLUSTER: o.cluster });
      const gone = /NotFound|does not exist|connection refused|no such host|GetFileAttributesEx|unable to recognize|couldn't get current server/i.test(a.text);
      if (a.status !== 0 && !gone) {
        if (!o.json) console.error(`데모 네임스페이스를 지우지 못했다(exit ${a.status}): ${a.text.slice(-800)}`);
        return 1;
      }
      if (o.keepCluster) {
        if (!o.json) console.log(`데모 네임스페이스만 지웠다(클러스터 ${o.cluster}는 남김${gone ? ', 이미 없었다' : ''})`);
        return 0;
      }
      const b = runNode('cluster.mjs', ['down'], { PEAKET_CLUSTER: o.cluster, PEAKET_DEMO_CLUSTER: o.cluster });
      if (b !== 0) return 1;
      if (!o.json) console.log(`데모 네임스페이스와 kind 클러스터 ${o.cluster}를 지웠다(두 번 불러도 안전)`);
      return 0;
    }
    if (o.cmd === 'up') {
      // 이미 준비됐으면 그대로 쓴다(중복 클러스터 없음, V-T7 ⑤)
      const ready = stageProblems({ env: demoEnv(o) });
      if (ready.ok) {
        if (!o.json) console.log(`무대가 이미 준비됐다(클러스터 ${o.cluster}). 다시 올리지 않는다`);
        jsonOut(o, { ok: true, reused: true, cluster: o.cluster });
        return 0;
      }
      const status = runNode('cluster.mjs', ['demo', ...(o.skipBuild ? ['--skip-build'] : [])], { PEAKET_CLUSTER: o.cluster, PEAKET_DEMO_CLUSTER: o.cluster });
      jsonOut(o, { ok: status === 0, reused: false, exit: status, cluster: o.cluster });
      return status === 0 ? 0 : 1;
    }
    if (o.cmd === 'seed') {
      const script = o.check ? ['demo-seed', '--check', '--json'] : ['demo-seed', '--apply', '--json'];
      const r = runNodeJson('cluster.mjs', script, { PEAKET_CLUSTER: o.cluster, PEAKET_DEMO_CLUSTER: o.cluster });
      jsonOut(o, r.json ?? { ok: false, exit: r.status });
      if (!o.json) console.log(r.status === 0 ? (o.check ? '시드가 맞다' : '시드를 적용했다') : '시드 검사·적용 실패');
      return r.status === 0 ? 0 : 1;
    }
    if (o.cmd === 'play') {
      const stage = stageProblems({ env: demoEnv(o) });
      if (!stage.ok) {
        jsonOut(o, { ok: false, reason: stage.reason, problems: stage.problems });
        if (!o.json) console.error(`${stage.reason}: ${stage.problems.join('; ')}`);
        return 1;
      }
      const report = await play(o, log, false);
      jsonOut(o, report);
      return report.ok ? 0 : 1;
    }
    if (o.cmd === 'all') return await runAll(o, log);
    return 2;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    jsonOut(o, { ok: false, error: msg });
    console.error(`demo.mjs 실패: ${msg}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
