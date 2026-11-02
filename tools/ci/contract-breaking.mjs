#!/usr/bin/env node
// 계약 깨짐 검사(docs/api/guidelines.md §1 '차이 검사 도구와 깨짐 기준', docs/devops.md §3.1 contract-check, D-T48·D-T38,
// openspec 변경 add-contract-breaking-check). PR의 계약을 대상 가지와 마지막 출시 태그의 계약과 둘 다 견준다(ADR-0165).
//
// 쓰는 법:
//   node tools/ci/contract-breaking.mjs --target origin/develop [--pull-request] [--labels <JSON 배열>]   (CI의 PR은 라벨을 GITHUB_EVENT_PATH에서 읽는다)
//   node tools/ci/contract-breaking.mjs services        서비스 OpenAPI 차이(D-T38, 비교 본체는 service-openapi.mjs)
// 도구는 판·다이제스트를 고정한 공식 이미지로 네트워크를 끊고 돈다(design.md 결정 1). Docker가 있어야 한다.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sortReleaseTags } from './release-tags.mjs';
import { checkServices, serviceTargets } from './service-openapi.mjs';

// oasdiff 1.34.1(2026-10-21 게시), AsyncAPI CLI 6.2.2(2026-10-26 게시). 판은 guidelines §1이 정한 판이다
export const IMAGES = {
  oasdiff: 'tufin/oasdiff@sha256:67a23cfea7d251e2ae34ee703ac8733c5d96bc2e7b90fd0f4d475ec99367b85f',
  asyncapi: 'asyncapi/cli@sha256:2617a547968342831b3485e30c3fb50fd2e5b9b6b3441abd3dbe18c5f4e5fe1e',
};
const OPENAPI = 'docs/api/openapi.yaml';
const ASYNCAPI = 'docs/api/asyncapi.yaml';
const BREAKING = 'docs/api/breaking';
const APPROVED = 'breaking-approved';
const REASON = /\s#\s*이유:\s*(.*)$/;
const CONVERTER = fileURLToPath(new URL('../../packages/contracts/scripts/asyncapi-messages.mjs', import.meta.url));

const gitIn = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};

/**
 * 견줄 기준: 대상 가지와 마지막 출시 태그(같은 커밋이면 하나). 대상 가지는 지금 커밋과 갈라진 점(merge-base)으로 본다.
 * 대상 가지가 그 뒤 앞서가면 거기 새로 생긴 경로·칸이 '지워졌다'로 보이기 때문이다. 대상 가지가 없으면 던진다
 */
export function chooseBases({ cwd, target }) {
  const sha = (ref) => gitIn(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)?.trim() || null;
  if (!sha(target)) throw new Error(`대상 가지 ${target}를 찾지 못했다(체크아웃에 대상 가지와 태그가 있어야 한다, fetch-depth: 0)`);
  const targetSha = gitIn(cwd, 'merge-base', 'HEAD', target)?.trim();
  if (!targetSha) throw new Error(`대상 가지 ${target}와 지금 커밋의 갈라진 점을 찾지 못했다`);
  const bases = [{ label: `대상 가지 ${target}`, ref: targetSha, sha: targetSha }];
  const notes = [];
  const [last] = sortReleaseTags((gitIn(cwd, 'tag', '--list', 'v*') ?? '').split('\n'));
  if (!last) notes.push('출시 태그가 없어 마지막 출시 태그와는 견주지 않는다(처음 출시 전)');
  else {
    const tagSha = sha(last.name);
    if (tagSha !== targetSha) bases.push({ label: `마지막 출시 태그 ${last.name}`, ref: tagSha, sha: tagSha });
  }
  return { bases, notes };
}

const readAt = (cwd, ref, path) => gitIn(cwd, 'show', `${ref}:${path}`);

/** oasdiff --err-ignore 파일: 빈 줄과 # 줄은 건너뛰고, 예외 줄은 끝에 `# 이유: …`가 있어야 한다 */
export function parseIgnore(text, file) {
  const entries = [];
  const errors = [];
  (text ?? '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = REASON.exec(line);
    const change = (m ? line.slice(0, m.index) : line).trim();
    if (!m || !m[1].trim()) errors.push(`${file}:${i + 1}: 예외에 이유가 없다(줄 끝에 '# 이유: …', guidelines §1): ${change}`);
    entries.push({ change, reason: m?.[1].trim() ?? '' });
  });
  return { entries, errors };
}

/** asyncapi diff --overrides 파일: { "<JSON 포인터>": { "reason": "…", "add|remove|edit": "…" } }. reason은 빼고 CLI에 넘긴다 */
export function parseOverrides(text, file) {
  let json;
  try {
    json = JSON.parse(text ?? '{}');
  } catch (e) {
    return { cli: {}, keys: [], errors: [`${file}: JSON으로 읽지 못했다(${e.message})`] };
  }
  const cli = {};
  const errors = [];
  for (const [pointer, value] of Object.entries(json ?? {})) {
    const { reason, ...rest } = value ?? {};
    if (typeof reason !== 'string' || !reason.trim()) errors.push(`${file}: ${pointer}에 이유(reason)가 없다(guidelines §1)`);
    cli[pointer] = rest;
  }
  return { cli, keys: Object.keys(cli), errors };
}

function exceptions(read) {
  const o = parseIgnore(read(`${BREAKING}/openapi-ignore.txt`), `${BREAKING}/openapi-ignore.txt`);
  const a = parseIgnore(read(`${BREAKING}/asyncapi-ignore.txt`), `${BREAKING}/asyncapi-ignore.txt`);
  const v = parseOverrides(read(`${BREAKING}/asyncapi-overrides.json`), `${BREAKING}/asyncapi-overrides.json`);
  // 덮어쓰기는 키와 값을 함께 견준다(값을 넓혀도 예외가 는 것이다)
  return {
    list: [...o.entries.map((e) => `openapi-ignore: ${e.change}`), ...a.entries.map((e) => `asyncapi-ignore: ${e.change}`),
      ...v.keys.map((k) => `asyncapi-overrides: ${k} ${JSON.stringify(v.cli[k])}`)],
    errors: [...o.errors, ...a.errors, ...v.errors],
    overrides: v.cli,
    // oasdiff는 # 줄도 예외로 읽으므로, 스크립트가 본 예외 문장만 담은 사본을 넘긴다(주석·이유는 뺀다)
    ignoreForTool: {
      'openapi-ignore.txt': o.entries.map((e) => `${e.change}\n`).join(''),
      'asyncapi-ignore.txt': a.entries.map((e) => `${e.change}\n`).join(''),
    },
  };
}

const LEVELS = ['openapi-levels.txt', 'asyncapi-levels.txt', 'asyncapi-avro-levels.txt'];
const RANK = { NONE: 0, INFO: 1, WARN: 2, ERR: 3 };
const levelLines = (text) => (text ?? '').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
const levelsForTool = (text) => levelLines(text).map((l) => `${l}\n`).join('');
const levelMap = (text) => new Map(levelLines(text).map((l) => l.split(/\s+/)).map(([id, lv]) => [id, (lv ?? '').toUpperCase()]));

/** 수준을 낮추는 바꿈: 기준에 있던 줄을 지우거나 낮춤, 기준에 없던 검사를 ERR 아닌 수준으로 둠(oasdiff 기본보다 낮을 수 있다) */
function loweredLevels(baseText, headText) {
  const base = levelMap(baseText);
  const head = levelMap(headText);
  const out = [];
  for (const [id, lv] of base) {
    if (!head.has(id)) out.push(`${id} ${lv} → (기본)`);
    else if ((RANK[head.get(id)] ?? -1) < (RANK[lv] ?? -1)) out.push(`${id} ${lv} → ${head.get(id)}`);
  }
  for (const [id, lv] of head) if (!base.has(id) && lv !== 'ERR') out.push(`${id} (기본) → ${lv}`);
  return out;
}

const warningsOf = (out) => (/\b[1-9]\d* warning/.test(out) || /^warning\b/m.test(out) ? out.trim() : null);

/** 기본 도구 실행: docker run --rm --network none -v <폴더>:/w <이미지> <인자> */
export async function dockerRun(tool, args, dir) {
  const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '-e', 'SUPPRESS_NO_CONFIG_WARNING=1', '-v', `${dir}:/w`, IMAGES[tool], ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker를 부르지 못했다: ${r.error.message}`);
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 기본 메시지 본문 변환: packages/contracts의 변환기(yaml 패키지를 쓰므로 pnpm install 뒤에 돈다) */
export function nodeConvert(from, to, kind) {
  execFileSync(process.execPath, [CONVERTER, from, to, kind], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * @param {{ cwd: string, target: string, labels: string[], pullRequest: boolean,
 *   run?: (tool: string, args: string[], dir: string) => Promise<{ code: number, out: string }>,
 *   convert?: (from: string, to: string, kind: 'json' | 'avro') => void }} o
 */
export async function checkContracts({ cwd, target, labels, pullRequest, run = dockerRun, convert = nodeConvert }) {
  const failures = [];
  const warnings = [];
  const notes = [];
  const readHead = (p) => (existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), 'utf8') : null);

  for (const f of [...LEVELS, 'openapi-ignore.txt', 'asyncapi-ignore.txt', 'asyncapi-overrides.json']) {
    if (readHead(`${BREAKING}/${f}`) === null) failures.push(`${BREAKING}/${f}가 없다(수준·예외 파일, design.md 결정 3~5)`);
  }
  if (failures.length) return { failures, warnings, notes };

  const head = exceptions(readHead);
  failures.push(...head.errors);

  let bases;
  try {
    const chosen = chooseBases({ cwd, target });
    bases = chosen.bases;
    notes.push(...chosen.notes);
  } catch (e) {
    failures.push(e.message);
    return { failures, warnings, notes };
  }

  if (pullRequest && !labels.includes(APPROVED)) {
    const fork = bases[0].ref;
    const before = new Set(exceptions((p) => readAt(cwd, fork, p)).list);
    const added = head.list.filter((e) => !before.has(e));
    if (added.length) failures.push(`대상 가지보다 깨짐 예외가 늘었는데 PR에 ${APPROVED} 라벨이 없다(guidelines §1):\n  ${added.join('\n  ')}`);
    // 수준을 낮추면 그 종류의 깨짐이 예외 없이 통째로 빠지므로 같은 승인을 받는다
    const lowered = LEVELS.flatMap((f) => loweredLevels(readAt(cwd, fork, `${BREAKING}/${f}`), readHead(`${BREAKING}/${f}`)).map((x) => `${f}: ${x}`));
    if (lowered.length) failures.push(`대상 가지보다 깨짐 검사 수준을 낮췄는데 PR에 ${APPROVED} 라벨이 없다(guidelines §1):\n  ${lowered.join('\n  ')}`);
  }

  for (const b of bases) {
    const dir = mkdtempSync(join(tmpdir(), 'contract-breaking-'));
    // 도구 이미지가 루트가 아닌 사용자로 돌 수 있다(AsyncAPI CLI는 myuser). mkdtemp의 0700을 풀어 읽게 한다(파일은 umask 기본값 0644)
    chmodSync(dir, 0o755);
    try {
      const put = (name, text) => writeFileSync(join(dir, name), text);
      // 수준 파일은 oasdiff가 주석을 받지 않으므로(1.34.1) 주석과 빈 줄을 지운 사본을, 예외 파일은 oasdiff가 # 줄도 예외로
      // 읽으므로 스크립트가 읽은 예외 문장만 담은 사본을 넘긴다(스크립트가 본 것과 도구가 쓰는 것이 같게)
      for (const f of LEVELS) put(f, levelsForTool(readHead(`${BREAKING}/${f}`)));
      for (const [f, text] of Object.entries(head.ignoreForTool)) put(f, text);
      put('asyncapi-overrides.json', JSON.stringify(head.overrides, null, 2));
      const tool = async (what, name, args) => {
        try {
          const r = await run(name, args, dir);
          if (r.code !== 0) failures.push(`${what}이(가) ${b.label}과 견줘 깨진다(또는 도구가 실패했다):\n${r.out.trim()}`);
          else if (warningsOf(r.out)) warnings.push(`${what}(${b.label}):\n${warningsOf(r.out)}`);
        } catch (e) {
          failures.push(`${what}을(를) ${b.label}과 견주지 못했다: ${e.message}`);
        }
      };

      const oldRest = readAt(cwd, b.ref, OPENAPI);
      if (oldRest === null) notes.push(`${b.label}에 ${OPENAPI}이 없어 OpenAPI는 견주지 않는다`);
      else {
        put('base.openapi.yaml', oldRest);
        put('new.openapi.yaml', readHead(OPENAPI));
        await tool('OpenAPI', 'oasdiff', ['breaking', '/w/base.openapi.yaml', '/w/new.openapi.yaml', '--fail-on', 'ERR',
          '--severity-levels', '/w/openapi-levels.txt', '--err-ignore', '/w/openapi-ignore.txt']);
      }

      const oldEvents = readAt(cwd, b.ref, ASYNCAPI);
      if (oldEvents === null) notes.push(`${b.label}에 ${ASYNCAPI}이 없어 AsyncAPI는 견주지 않는다`);
      else {
        put('base.asyncapi.yaml', oldEvents);
        put('new.asyncapi.yaml', readHead(ASYNCAPI));
        await tool('AsyncAPI 채널·작업', 'asyncapi', ['diff', '/w/base.asyncapi.yaml', '/w/new.asyncapi.yaml', '-t', 'breaking',
          '--overrides', '/w/asyncapi-overrides.json']);
        // 메시지 본문은 내용 형식별로 견준다. JSON 메시지는 화면이 생성 Zod(열거는 zod.enum)로 읽어 열거 값 더하기도 깨짐이고,
        // Avro 메시지는 열거 맨 앞 UNRECOGNIZED 규칙으로 새 기호를 받는다(design.md 결정 4)
        for (const [kind, label, levels] of [['json', 'JSON', 'asyncapi-levels.txt'], ['avro', 'Avro', 'asyncapi-avro-levels.txt']]) {
          const what = `AsyncAPI 메시지 본문(${label})`;
          try {
            convert(join(dir, 'base.asyncapi.yaml'), join(dir, `base.asyncapi.${kind}-messages.json`), kind);
            convert(join(dir, 'new.asyncapi.yaml'), join(dir, `new.asyncapi.${kind}-messages.json`), kind);
          } catch (e) {
            failures.push(`${what}을(를) ${b.label}과 견주려고 바꾸지 못했다: ${e.message}`);
            continue;
          }
          await tool(what, 'oasdiff', ['breaking', `/w/base.asyncapi.${kind}-messages.json`, `/w/new.asyncapi.${kind}-messages.json`, '--fail-on', 'ERR',
            '--severity-levels', `/w/${levels}`, '--err-ignore', '/w/asyncapi-ignore.txt']);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { failures, warnings, notes };
}

/** PR 라벨 이름. 라벨은 사용자가 고칠 수 있는 값이라 워크플로 식이 아니라 사건 파일(GITHUB_EVENT_PATH)에서 읽는다(워크플로 규칙 4) */
export function labelsFromEvent(file) {
  let event;
  try {
    event = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`사건 파일 ${file}을 읽지 못했다: ${e.message}`);
  }
  return (event?.pull_request?.labels ?? []).map((l) => l?.name).filter((n) => typeof n === 'string');
}

// 서비스 OpenAPI 차이(D-T38)의 대상 찾기는 비교 본체(service-openapi.mjs)에 있다. 이 파일의 시험이 그대로 쓰게 다시 내보낸다
export { serviceTargets };

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { target: { type: 'string' }, labels: { type: 'string', default: '[]' }, 'pull-request': { type: 'boolean', default: false } },
  });
  const cwd = process.cwd();
  if (positionals[0] === 'services') {
    // 서비스마다 openapi:emit으로 문서를 뽑아, 맡는 계약 작업만 모양으로 견준다(service-openapi.mjs)
    const r = await checkServices({ cwd });
    if (!r.targets.length) console.log('서비스 OpenAPI 차이(D-T38): openapi:emit을 가진 서비스가 없어 견줄 것이 없다');
    for (const svc of r.checked) console.log(`서비스 OpenAPI 차이(D-T38) 통과: ${svc}`);
    for (const f of r.failures) console.log(`실패: 서비스 OpenAPI 차이(D-T38) ${f}`);
    if (r.failures.length) process.exitCode = 1;
  } else {
    if (!values.target) {
      console.error('사용: node tools/ci/contract-breaking.mjs --target <대상 가지> [--pull-request] [--labels <JSON 배열>]');
      process.exit(2);
    }
    let labels = [];
    try {
      // CI의 PR은 사건 파일에서 읽고, 로컬에서는 --labels로 줄 수 있다
      labels = values['pull-request'] && process.env.GITHUB_EVENT_PATH ? labelsFromEvent(process.env.GITHUB_EVENT_PATH) : JSON.parse(values.labels);
    } catch (e) {
      console.error(`라벨을 읽지 못했다: ${e.message}`);
      process.exit(2);
    }
    const r = await checkContracts({ cwd, target: values.target, labels: Array.isArray(labels) ? labels : [], pullRequest: values['pull-request'] });
    for (const n of r.notes) console.log(`알림: ${n}`);
    for (const w of r.warnings) console.log(`::warning title=계약 깨짐 검사 WARN::${w.replace(/\n/g, '%0A')}`);
    for (const f of r.failures) console.log(`실패: ${f}`);
    if (r.failures.length) process.exitCode = 1;
    else console.log('계약 깨짐 검사 통과');
  }
}
