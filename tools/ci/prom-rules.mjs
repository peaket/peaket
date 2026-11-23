#!/usr/bin/env node
// Prometheus 규칙 검사·합성 시계열 시험 실행기(F-01-5, OPS-090, 시험 V-T51 ⑧·V-T9, 계획 docs/review/plans/F-01-5.md §5 '실행기').
// 정본: docs/verification.md §2.7(경보 규칙 시험: promtool check rules와 합성 시계열 시험), docs/observability.md §4 'SLO 기록 규칙과 원천'.
// - check: deploy/platform/observability/ 아래 규칙 파일(rules/·alerts/의 PrometheusRule CRD, mimir/rules/의 Prometheus 규칙 파일)마다
//   promtool check rules. CRD는 spec(규칙 묶음)을 꺼낸 임시 파일로 검사한다.
// - test: deploy/platform/observability/test/*.test.yaml마다 promtool test rules. 시험 파일의 rule_files는 저장소 뿌리 기준 경로이고,
//   실행기가 그 파일에서 규칙 묶음을 꺼낸 임시 파일로 바꿔 넘긴다. 실패하면 실패한 시험 묶음 이름을 찍는다(promtool --junit 결과에서 읽는다).
// - promtool: 환경 값 PEAKET_PROMTOOL(실행 파일 경로)이 있으면 그것, 없으면 deploy/local/observability.yaml의 prom/prometheus 이미지(다이제스트 포함)를
//   Docker로 띄운다(로컬 Prometheus와 같은 판). 컨테이너는 --rm이고 이름(prom-rules-<pid>-<n>)을 달아, 시간 초과로 끊으면 그 이름만 지운다.
// 쓰는 법: node tools/ci/prom-rules.mjs <check|test> [--root <저장소>]
// 끝 코드: 0 통과, 1 실패(파일마다 '막음: <저장소 기준 경로>: <까닭>'과 promtool 출력),
//   2 인자 오류·저장소나 파일 없음·시험 파일 0개·Docker와 PEAKET_PROMTOOL이 모두 없음·도구를 돌리지 못함(도구가 없는 것을 통과로 내지 않는다).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';

const USAGE = '쓰는 법: node tools/ci/prom-rules.mjs <check|test> [--root <저장소>]';
const OBS = 'deploy/platform/observability';
/** 규칙 파일이 있는 곳과 그 꼴(crd: PrometheusRule, plain: 최상위 groups) */
const RULE_DIRS = [
  [`${OBS}/rules`, 'crd'],
  [`${OBS}/alerts`, 'crd'],
  [`${OBS}/mimir/rules`, 'plain'],
];
const TEST_DIR = `${OBS}/test`;
const LOCAL_OBS = 'deploy/local/observability.yaml';
const IMAGE_RE = /image:\s*(prom\/prometheus:[^\s@]+@sha256:[0-9a-f]{64})/;
/** promtool 한 번의 시간 한도. 28일 묶음 시험이 몇 분 걸린다(계획 '시험 결과' 7) */
const RUN_TIMEOUT_MS = 20 * 60_000;
const DOCKER_PROBE_TIMEOUT_MS = 60_000;

/** 끝 코드 2로 끝낼 오류 */
class UsageError extends Error {}
/** 그 파일만 막는 오류 */
class BlockError extends Error {}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'check' && cmd !== 'test') throw new UsageError(cmd === undefined ? '명령이 없다' : `모르는 명령 ${cmd}`);
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--root') {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError('--root에 값이 없다');
      root = resolve(v);
      i++;
    } else if (a.startsWith('--root=') && a.length > '--root='.length) root = resolve(a.slice('--root='.length));
    else throw new UsageError(`모르는 인자 ${a}`);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`저장소 폴더가 없다: ${root}`);
  if (!existsSync(join(root, OBS))) throw new UsageError(`${OBS}가 없다: ${root}`);
  return { cmd, root };
}

const yamlFiles = (abs) => (existsSync(abs) ? readdirSync(abs).filter((f) => /\.ya?ml$/.test(f)).sort() : []);

/** 규칙 파일 하나를 promtool이 읽는 꼴({ groups })로. 기대 꼴(expect)이 없으면 내용으로 고른다 */
export function ruleGroups(root, rel, expect) {
  const abs = join(root, rel);
  if (!existsSync(abs)) throw new BlockError('파일이 없다');
  const docs = parseAllDocuments(readFileSync(abs, 'utf8'));
  for (const d of docs) if (d.errors.length) throw new BlockError(`YAML을 읽지 못했다: ${d.errors[0].message.split('\n')[0]}`);
  const values = docs.map((d) => d.toJS()).filter((x) => x !== null && x !== undefined);
  const crds = values.filter((v) => v?.kind === 'PrometheusRule');
  const kind = expect ?? (crds.length ? 'crd' : 'plain');
  if (kind === 'crd') {
    if (!crds.length) throw new BlockError('PrometheusRule 문서가 없다');
    const groups = crds.flatMap((c) => (Array.isArray(c.spec?.groups) ? c.spec.groups : []));
    if (crds.some((c) => !Array.isArray(c.spec?.groups))) throw new BlockError('spec.groups가 목록이 아니다');
    return { groups };
  }
  if (values.length !== 1 || values[0]?.kind !== undefined || !Array.isArray(values[0]?.groups)) throw new BlockError('최상위 groups 목록 하나인 규칙 파일이 아니다');
  return { groups: values[0].groups };
}

/** promtool을 부르는 방법. 없으면 UsageError(끝 코드 2) */
export function resolveTool(root, env = process.env) {
  const exe = env.PEAKET_PROMTOOL;
  if (exe) {
    if (!existsSync(exe)) throw new UsageError(`PEAKET_PROMTOOL이 가리키는 파일이 없다: ${exe}`);
    return { kind: 'exec', exe };
  }
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', env, timeout: DOCKER_PROBE_TIMEOUT_MS });
  if (probe.error || probe.status !== 0) {
    const why = probe.error ? probe.error.code ?? probe.error.message : (probe.stderr || '').trim().split('\n')[0];
    throw new UsageError(`promtool이 없다: PEAKET_PROMTOOL이 없고 Docker를 쓸 수 없다(${why})`);
  }
  const localObs = join(root, LOCAL_OBS);
  if (!existsSync(localObs)) throw new UsageError(`${LOCAL_OBS}가 없어 prom/prometheus 이미지를 정하지 못한다`);
  const m = IMAGE_RE.exec(readFileSync(localObs, 'utf8'));
  if (!m) throw new UsageError(`${LOCAL_OBS}에 다이제스트를 단 prom/prometheus 이미지가 없다`);
  return { kind: 'docker', image: m[1], env };
}

let runSeq = 0;
/** 작업 폴더(work)에서 promtool을 돌린다. 인자의 파일 경로는 작업 폴더 기준. { status, out, toolError } */
function promtool(tool, work, args) {
  return new Promise((done) => {
    let cmd;
    let full;
    let name;
    if (tool.kind === 'exec') {
      cmd = tool.exe;
      full = args;
    } else {
      name = `prom-rules-${process.pid}-${++runSeq}`;
      const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
      cmd = 'docker';
      full = ['run', '--rm', '--name', name, '--network', 'none', ...user, '--mount', `type=bind,source=${work},target=/work`, '-w', '/work', '--entrypoint', '/bin/promtool', tool.image, ...args];
    }
    const child = spawn(cmd, full, { cwd: work, env: tool.env ?? process.env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      if (name) spawnSync('docker', ['rm', '-f', name], { timeout: DOCKER_PROBE_TIMEOUT_MS });
    }, RUN_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ status: null, out: `${out}${e.message}`, toolError: `promtool을 띄우지 못했다(${e.code ?? e.message})` });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (timedOut) return done({ status: null, out, timedOut: true });
      // docker run 자체의 실패(125 데몬·이미지, 126·127 실행 불가)는 규칙 실패가 아니라 도구 오류다
      if (tool.kind === 'docker' && [125, 126, 127].includes(status)) return done({ status, out, toolError: `docker run이 ${status}로 끝났다` });
      done({ status, out });
    });
  });
}

const decodeXml = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** promtool --junit 결과에서 실패한 시험 묶음 이름 */
export function failedCases(xml) {
  const names = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1]);
    if (m[2] && /<(failure|error)\b/.test(m[2])) names.push(name ? decodeXml(name[1]) : '(이름 없음)');
  }
  return names;
}

const indent = (text) =>
  String(text)
    .trimEnd()
    .split(/\r?\n/)
    .map((l) => `    ${l}`)
    .join('\n');

/** check: 규칙 파일마다 promtool check rules */
async function checkRules(root, tool, work) {
  const files = RULE_DIRS.flatMap(([dir, kind]) => yamlFiles(join(root, dir)).map((f) => ({ rel: `${dir}/${f}`, kind })));
  if (!files.length) throw new UsageError(`규칙 파일이 없다(${RULE_DIRS.map(([d]) => d).join(', ')})`);
  const jobs = files.map(async ({ rel, kind }, i) => {
    try {
      const name = `check-${i}-${basename(rel)}`;
      writeFileSync(join(work, name), stringify(ruleGroups(root, rel, kind), { lineWidth: 0 }));
      const r = await promtool(tool, work, ['check', 'rules', name]);
      if (r.toolError) return { rel, toolError: r.toolError, out: r.out };
      if (r.timedOut) return { rel, block: `promtool이 ${RUN_TIMEOUT_MS / 60_000}분 안에 끝나지 않았다`, out: r.out };
      if (r.status !== 0) return { rel, block: 'promtool check rules가 규칙 오류를 냈다', out: r.out };
      return { rel, out: r.out };
    } catch (e) {
      if (e instanceof BlockError) return { rel, block: e.message };
      throw e;
    }
  });
  return Promise.all(jobs);
}

/** test: 시험 파일마다 promtool test rules(rule_files는 규칙 묶음을 꺼낸 임시 파일로 바꾼다) */
async function testRules(root, tool, work) {
  const tests = yamlFiles(join(root, TEST_DIR)).filter((f) => /\.test\.ya?ml$/.test(f));
  if (!tests.length) throw new UsageError(`시험 파일이 없다(${TEST_DIR}/*.test.yaml)`);
  const jobs = tests.map(async (f, i) => {
    const rel = `${TEST_DIR}/${f}`;
    try {
      let spec;
      try {
        spec = parse(readFileSync(join(root, rel), 'utf8'));
      } catch (e) {
        throw new BlockError(`YAML을 읽지 못했다: ${String(e.message).split('\n')[0]}`);
      }
      if (!Array.isArray(spec?.rule_files) || !spec.rule_files.length) throw new BlockError('rule_files가 없다');
      if (!Array.isArray(spec.tests) || !spec.tests.length) throw new BlockError('시험 묶음(tests)이 없다');
      const dir = `t${i}`;
      mkdirSync(join(work, dir, 'rules'), { recursive: true });
      const ruleFiles = spec.rule_files.map((rf, j) => {
        if (typeof rf !== 'string') throw new BlockError(`rule_files ${j + 1}번째가 경로가 아니다`);
        let groups;
        try {
          groups = ruleGroups(root, rf);
        } catch (e) {
          if (e instanceof BlockError) throw new BlockError(`rule_files ${rf}: ${e.message}`);
          throw e;
        }
        const name = `rules/${j}-${basename(rf)}`;
        writeFileSync(join(work, dir, name), stringify(groups, { lineWidth: 0 }));
        return name;
      });
      writeFileSync(join(work, dir, f), stringify({ ...spec, rule_files: ruleFiles }, { lineWidth: 0 }));
      const junit = 'junit.xml';
      const r = await promtool(tool, join(work, dir), ['test', 'rules', `--junit=${junit}`, f]);
      if (r.toolError) return { rel, toolError: r.toolError, out: r.out };
      if (r.timedOut) return { rel, block: `promtool이 ${RUN_TIMEOUT_MS / 60_000}분 안에 끝나지 않았다`, out: r.out };
      if (r.status === 0) return { rel, out: r.out, cases: spec.tests.length };
      const xmlPath = join(work, dir, junit);
      const failed = existsSync(xmlPath) ? failedCases(readFileSync(xmlPath, 'utf8')) : [];
      const why = failed.length ? `시험 묶음 ${failed.length}개 실패` : `promtool test rules가 ${r.status}로 끝났다`;
      return { rel, block: why, failed, out: r.out };
    } catch (e) {
      if (e instanceof BlockError) return { rel, block: e.message };
      throw e;
    }
  });
  return Promise.all(jobs);
}

/** @param {string[]} argv @returns {Promise<number>} */
export async function main(argv, env = process.env) {
  let work;
  try {
    const { cmd, root } = parseArgs(argv);
    const tool = resolveTool(root, env);
    work = mkdtempSync(join(tmpdir(), 'prom-rules-'));
    // Docker 안의 promtool(다른 사용자일 수 있다)이 --junit 결과를 쓸 수 있게 한다
    chmodSync(work, 0o777);
    const results = cmd === 'check' ? await checkRules(root, tool, work) : await testRules(root, tool, work);
    const toolErrors = results.filter((r) => r.toolError);
    if (toolErrors.length) {
      for (const r of toolErrors) console.error(`prom-rules: 도구 오류(${r.rel}): ${r.toolError}\n${indent(r.out ?? '')}`);
      return 2;
    }
    const blocked = results.filter((r) => r.block);
    for (const r of results) {
      if (r.block) {
        console.log(`막음: ${r.rel}: ${r.block}`);
        for (const n of r.failed ?? []) console.log(`  실패한 시험 묶음: ${n}`);
        if (r.out) console.log(indent(r.out));
      } else console.log(`통과: ${r.rel}${r.cases ? `(시험 묶음 ${r.cases}개)` : ''}`);
    }
    const what = cmd === 'check' ? '규칙 파일' : '시험 파일';
    if (blocked.length) {
      console.log(`prom-rules ${cmd}: ${what} ${results.length}개 가운데 ${blocked.length}개 막음`);
      return 1;
    }
    console.log(`prom-rules ${cmd}: ${what} ${results.length}개 통과(${tool.kind === 'docker' ? tool.image : tool.exe})`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`prom-rules: ${e.message}\n${USAGE}`);
      return 2;
    }
    throw e;
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`prom-rules: 뜻밖의 오류: ${e?.stack ?? e}`);
      process.exitCode = 2;
    },
  );
}
