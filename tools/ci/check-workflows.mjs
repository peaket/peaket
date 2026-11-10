#!/usr/bin/env node
// 워크플로 규칙 검사(docs/devops.md §4.5, openspec 변경 add-ci-foundation).
// 줄 단위로 본다(YAML 해석기를 의존성으로 들이지 않는다). 들여쓰기는 두 칸이라고 본다.
//   1. uses:는 같은 저장소 경로(./)이거나 <소유자>/<저장소>[/경로]@<40자리 커밋 SHA>, docker://는 @sha256 다이제스트
//   2. pull_request_target을 쓰지 않는다
//   3. 맨 위에 permissions:를 둔다
//   4. ${{ }} 안에 사용자가 고칠 수 있는 값(PR 제목·본문, 가지 이름, 커밋 메시지 등)을 쓰지 않는다
//   5. actions/checkout 단계마다 persist-credentials: false를 둔다
//   6. 잡마다 timeout-minutes를 둔다(재사용 워크플로를 부르는 잡은 그 워크플로가 정한다)
//   7. build-image.yml의 잡 build는 잡 권한이 contents: read 하나뿐이고 레지스트리 로그인·푸시·서명·출처 증명 단계가 없다(D-T32 ①)
//   8. `branch-watch.mjs count`를 부르는 단계는 continue-on-error: true와 timeout-minutes를 둔다. 경고만 하는 점검이 필수 검사(branch-policy)를 막지 않게 한다(D-T49)
//   9. GitHub 소유(소유자가 actions·github)가 아닌 액션·재사용 워크플로는 조직 허용 목록(infra/stacks/global/github/variables.tf의
//      actions_patterns_allowed 기본값, 조직에 적용하는 것은 소유자)의 꼴(소유자/저장소@*, 소유자/*)에 맞아야 한다. 그 목록을 읽지 못하면 실패한다
//      (D-T12 ①, docs/devops.md §4.5 '서드파티 액션 탈취', ADR-0263 결정 10)
//  10. 같은 저장소의 재사용 워크플로(uses: ./.github/workflows/…)를 부르는 잡: 부른 워크플로의 모든 잡 권한(잡 권한, 없으면 그 워크플로 맨 위 권한)이
//      부르는 잡이 준 권한(잡 권한, 없으면 부르는 워크플로 맨 위 권한) 안에 든다. 적지 않은 권한은 none이고 none < read < write다. 넘으면 GitHub이
//      그 실행을 시작하지 않는다(docs/devops.md §4.4 '리뷰 뒤 더한 규칙' ①, ADR-0263 결정 13, 리뷰 H1)
// 쓰는 법: node tools/ci/check-workflows.mjs [--allowlist <variables.tf>] [파일...]  (파일이 없으면 .github/workflows/*.yml|yaml)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = '.github/workflows';
const SHA_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[^@\s]+)?@[0-9a-f]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
// 신뢰할 수 없는 입력: github.head_ref와, 마지막 이름이 이것으로 끝나는 github.event 경로(full_name·head_ref 등 포함.
// GitHub 문서 'Script injections', 2026-10-31 확인). 대신 사건 파일(GITHUB_EVENT_PATH)에서 스크립트로 읽는다
const UNTRUSTED_ENDINGS = ['body', 'default_branch', 'email', 'head_ref', 'label', 'message', 'name', 'page_name', 'ref', 'title'];
const untrusted = (expr) =>
  (expr.match(/\bgithub\.[\w.*[\]'"-]+/g) ?? []).some((path) => {
    const last = path.split(/[.[\]'"]+/).filter(Boolean).pop();
    // github.event_name(사건 종류)은 사건 본문이 아니다. github.event와 그 아래 경로만 본다
    const inEvent = path === 'github.event' || /^github\.event[.[]/.test(path);
    return path === 'github.head_ref' || (inEvent && UNTRUSTED_ENDINGS.some((e) => last.endsWith(e)));
  });

// 9. 조직 허용 목록(D-T12 ①). GitHub 소유는 소유자 이름이 정확히 actions·github인 것뿐이다(github-x·actions-x는 아니다)
const ALLOWLIST_TF = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra', 'stacks', 'global', 'github', 'variables.tf');
const GITHUB_OWNERS = new Set(['actions', 'github']);

/** variables.tf에서 actions_patterns_allowed 변수의 기본값 목록(글자들)을 읽는다. 없거나 꼴이 틀리면 던진다 */
function readAllowlist(text) {
  const head = /variable\s+"actions_patterns_allowed"\s*\{/.exec(text);
  if (!head) throw new Error('변수 actions_patterns_allowed가 없다');
  // 블록 끝: 중괄호 짝(글자 안의 괄호는 건너뛴다)
  let depth = 0;
  let end = -1;
  let inStr = false;
  for (let i = head.index + head[0].length - 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '#' || (c === '/' && text[i + 1] === '/')) i = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i);
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('변수 actions_patterns_allowed 블록이 닫히지 않았다');
  const block = text.slice(head.index, end);
  const def = /^\s*default\s*=\s*(.*)$/m.exec(block);
  if (!def) throw new Error('actions_patterns_allowed에 기본값(default)이 없다');
  const from = block.indexOf(def[1], def.index);
  if (!def[1].startsWith('[')) throw new Error(`actions_patterns_allowed의 기본값이 목록이 아니다: ${def[1].trim()}`);
  const close = block.indexOf(']', from);
  if (close < 0) throw new Error('actions_patterns_allowed의 기본값 목록이 닫히지 않았다');
  const body = block.slice(from + 1, close).replace(/(#|\/\/)[^\n]*/g, '');
  const items = [];
  const re = /\s*"([^"\\]*)"\s*(,|$)/y;
  let pos = 0;
  while (pos < body.length && body.slice(pos).trim() !== '') {
    re.lastIndex = pos;
    const m = re.exec(body);
    if (!m) throw new Error(`actions_patterns_allowed의 기본값에는 글자만 둔다: ${body.slice(pos).trim().slice(0, 40)}`);
    items.push(m[1]);
    pos = re.lastIndex;
  }
  return items;
}
const globRe = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

// 10. 권한(scope → none·read·write). read-all·write-all은 모든 권한이다
const PERMISSION_SCOPES = ['actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'id-token', 'issues', 'models', 'packages', 'pages', 'pull-requests', 'repository-projects', 'security-events', 'statuses'];
const LEVEL = { none: 0, read: 1, write: 2 };

/** permissions: 줄(code[i], 들여쓰기 base)과 그 아래 줄을 권한 표로 읽는다 */
function readPermissions(code, i, base) {
  const inline = /^\s*permissions:\s*(.*?)\s*(#.*)?$/.exec(code[i])[1];
  const all = (level) => Object.fromEntries(PERMISSION_SCOPES.map((k) => [k, level]));
  if (inline === 'read-all') return all('read');
  if (inline === 'write-all') return all('write');
  const out = {};
  let entries = [];
  if (inline) {
    const m = /^\{\s*(.*?)\s*\}$/.exec(inline);
    if (!m) throw new Error(`권한 꼴을 읽지 못했다: ${inline}`);
    entries = m[1] ? m[1].split(',') : [];
  } else {
    for (let j = i + 1; j < code.length && (code[j].trim() === '' || code[j].search(/\S/) > base); j++) if (code[j].trim()) entries.push(code[j]);
  }
  for (const e of entries) {
    const m = /^\s*([a-z-]+)\s*:\s*(none|read|write)\s*(#.*)?$/.exec(e);
    if (!m) throw new Error(`권한 줄을 읽지 못했다: ${e.trim()}`);
    out[m[1]] = m[2];
  }
  return out;
}

/** 맨 위 권한과 잡마다(이름, 줄, 권한, 부르는 재사용 워크플로) */
function workflowShape(code) {
  const topAt = code.findIndex((l) => /^permissions:/.test(l));
  const top = topAt >= 0 ? readPermissions(code, topAt, 0) : null;
  const jobs = [];
  const start = code.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start >= 0) {
    let job = null;
    for (let i = start + 1; i < code.length; i++) {
      const l = code[i];
      if (/^\S/.test(l)) break;
      const key = /^ {2}([A-Za-z_][\w-]*):\s*(#.*)?$/.exec(l);
      if (key) {
        job = { name: key[1], line: i, perms: null, uses: null };
        jobs.push(job);
      } else if (job) {
        if (/^ {4}permissions:/.test(l)) job.perms = readPermissions(code, i, 4);
        const u = /^ {4}uses:\s*(['"]?)(\.\/[^'"\s#]+)\1/.exec(l);
        if (u) job.uses = u[2];
      }
    }
  }
  return { top, jobs };
}

/** 10. 부른 워크플로의 잡 권한이 부르는 잡 권한 안인가 */
function checkCalledPermissions(file, code) {
  const errors = [];
  let shape;
  try {
    shape = workflowShape(code);
  } catch (e) {
    return [`${file}: ${e.message}`];
  }
  // 저장소 뿌리: .github/workflows/<파일>의 두 단계 위(그 밖의 자리면 파일과 같은 폴더에서 찾는다)
  const abs = resolve(file);
  const wfDir = dirname(abs);
  const root = /[\\/]\.github[\\/]workflows$/.test(wfDir) ? dirname(dirname(wfDir)) : null;
  for (const job of shape.jobs) {
    if (!job.uses) continue;
    const given = job.perms ?? shape.top ?? {};
    const target = root ? join(root, job.uses) : join(wfDir, job.uses.split('/').pop());
    let text;
    try {
      text = readFileSync(target, 'utf8');
    } catch {
      errors.push(`${file}:${job.line + 1}: 잡 ${job.name}가 부르는 ${job.uses}를 읽지 못했다(규칙 10)`);
      continue;
    }
    let calledShape;
    try {
      calledShape = workflowShape(text.split(/\r?\n/).map((l) => (/^\s*#/.test(l) ? '' : l)));
    } catch (e) {
      errors.push(`${job.uses}: ${e.message}`);
      continue;
    }
    for (const c of calledShape.jobs) {
      const want = c.perms ?? calledShape.top ?? given;
      for (const [scope, level] of Object.entries(want)) {
        const have = given[scope] ?? 'none';
        if (LEVEL[level] > LEVEL[have]) {
          errors.push(`${file}:${job.line + 1}: 잡 ${job.name}가 부르는 ${job.uses}의 잡 ${c.name}가 ${scope}: ${level}를 달라는데 부르는 잡은 ${scope}: ${have}만 준다. GitHub이 그 실행을 시작하지 않는다(규칙 10, devops §4.4 '리뷰 뒤 더한 규칙' ①)`);
        }
      }
    }
  }
  return errors;
}

function check(file, text, allowlist = []) {
  const errors = [];
  const at = (i, msg) => errors.push(`${file}:${i + 1}: ${msg}`);
  const lines = text.split(/\r?\n/);
  const code = lines.map((l) => (/^\s*#/.test(l) ? '' : l));

  const indent = (l) => l.search(/\S/);
  // 체크아웃 단계(그 단계의 '-'보다 깊게 들여쓴 줄들) 안에 persist-credentials: false가 있는가
  const persists = (i) => {
    let dash = i;
    while (dash >= 0 && !/^\s*-\s/.test(code[dash])) dash--;
    const stepIndent = dash >= 0 ? indent(code[dash]) : -1;
    for (let j = dash + 1; j < code.length && (code[j].trim() === '' || indent(code[j]) > stepIndent); j++) {
      if (/^\s*persist-credentials:\s*(['"]?)false\1\s*(#.*)?$/.test(code[j])) return true;
    }
    return false;
  };
  code.forEach((line, i) => {
    const uses = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"\s#]+)\1/.exec(line);
    if (uses) {
      const ref = uses[2];
      if (/^actions\/checkout@/.test(ref) && !persists(i)) at(i, 'actions/checkout에 persist-credentials: false가 없다');
      if (!ref.startsWith('./') && !SHA_REF.test(ref) && !DOCKER_DIGEST.test(ref)) at(i, `uses: ${ref}는 커밋 SHA(40자리)나 다이제스트로 고정하지 않았다`);
      if (!ref.startsWith('./') && !ref.startsWith('docker://')) {
        const owner = ref.split('/')[0].toLowerCase();
        if (!GITHUB_OWNERS.has(owner) && !allowlist.some((p) => globRe(p).test(ref))) {
          at(i, `uses: ${ref}는 GitHub 소유 액션이 아니고 조직 허용 목록(infra/stacks/global/github/variables.tf의 actions_patterns_allowed)에도 없다. 목록에 더하고 조직에 적용한다(D-T12 ①)`);
        }
      }
    }
    if (/\bpull_request_target\b/.test(line)) at(i, 'pull_request_target은 쓰지 않는다(PR 코드가 쓰기 토큰과 비밀을 얻을 수 있다)');
    for (const expr of line.match(/\$\{\{[^}]*\}\}/g) ?? []) {
      if (untrusted(expr)) at(i, `${expr}는 사용자가 고칠 수 있는 값이다. 사건 파일(GITHUB_EVENT_PATH)에서 스크립트로 읽는다`);
    }
  });
  if (!code.some((l) => /^permissions:/.test(l))) errors.push(`${file}: 맨 위에 permissions:가 없다(워크플로 토큰 권한을 줄여 둔다)`);

  // 잡 블록: jobs: 아래 두 칸 들여쓴 키부터 다음 같은 키나 맨 위 키 전까지
  const start = code.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start >= 0) {
    let job = null;
    const close = () => {
      if (job && !job.timeout && !job.reusable) at(job.line, `잡 ${job.name}에 timeout-minutes가 없다`);
    };
    for (let i = start + 1; i < code.length; i++) {
      const l = code[i];
      if (/^\S/.test(l)) break;
      const key = /^ {2}([A-Za-z_][\w-]*):\s*(#.*)?$/.exec(l);
      if (key) {
        close();
        job = { name: key[1], line: i, timeout: false, reusable: false };
      } else if (job) {
        if (/^ {4}timeout-minutes:/.test(l)) job.timeout = true;
        if (/^ {4}uses:/.test(l)) job.reusable = true;
      }
    }
    close();
  }
  if (/(^|[\\/])build-image\.ya?ml$/.test(file)) errors.push(...checkBuildJob(file, code, start));
  errors.push(...checkWatchSteps(file, code, indent));
  errors.push(...checkCalledPermissions(file, code));
  return errors;
}

// 8. 경고만 하는 가지 점검(D-T49): `branch-watch.mjs count`를 부르는 단계는 넘어지거나 느려도 필수 검사를 막지 않게
//    continue-on-error: true와 단계 timeout-minutes를 둔다(잡 시간 제한에 걸리면 continue-on-error가 소용없다)
function checkWatchSteps(file, code, indent) {
  const errors = [];
  code.forEach((line, i) => {
    if (!/\bbranch-watch\.mjs\s+count\b/.test(line)) return;
    // 그 단계: 위로 '-'로 시작하는 줄을 찾고, 그보다 깊게 들여쓴 줄들
    let dash = i;
    while (dash >= 0 && !/^\s*-\s/.test(code[dash])) dash--;
    const stepIndent = dash >= 0 ? indent(code[dash]) : -1;
    // 단계의 키만 본다: '-' 줄 자체의 키와, '-' 뒤 키와 같은 깊이(들여쓰기 + 2)의 줄. env: 아래나 run: | 블록 안의 글은 단계 키가 아니다
    const keys = [(code[dash] ?? '').replace(/^\s*-\s+/, '')];
    for (let j = dash + 1; j < code.length && (code[j].trim() === '' || indent(code[j]) > stepIndent); j++) {
      if (indent(code[j]) === stepIndent + 2) keys.push(code[j].trim());
    }
    const key = (k) => keys.some((l) => l.startsWith(`${k}:`));
    if (!keys.some((l) => /^continue-on-error:\s*(['"]?)true\1\s*(#.*)?$/.test(l))) {
      errors.push(`${file}:${i + 1}: branch-watch.mjs count 단계에 continue-on-error: true가 없다(경고만 하는 점검이 필수 검사를 막는다, D-T49)`);
    }
    if (!key('timeout-minutes')) {
      errors.push(`${file}:${i + 1}: branch-watch.mjs count 단계에 timeout-minutes가 없다(잡 시간 제한에 걸리면 필수 검사가 실패한다, D-T49)`);
    }
  });
  return errors;
}

// 7. build-image.yml의 빌드 잡(D-T32 ①, docs/devops.md §3.1·§4.2): 저장소 코드를 돌리는 잡은 서명 신원·레지스트리 쓰기·출처 증명 권한이 없다.
//    잡 권한은 contents: read 하나뿐이고, 레지스트리 로그인·푸시·서명·출처 증명 단계가 없어야 한다(게시 잡은 따로, wbs 0.1.5)
const BUILD_JOB_FORBIDDEN = [
  [/\bid-token\s*:/, 'id-token 권한'],
  [/\bpackages\s*:\s*write\b/, 'packages: write 권한'],
  [/\battestations\s*:\s*write\b/, 'attestations: write 권한'],
  [/\bdocker\s+login\b/, 'docker login'],
  [/\bdocker\s+push\b/, 'docker push'],
  [/--push\b/, '--push'],
  [/\bcosign\b/, 'cosign'],
  [/\buses:\s*['"]?docker\/login-action@/, 'docker/login-action'],
  [/\buses:\s*['"]?actions\/attest/, 'actions/attest'],
  [/^\s*push:\s*['"]?true\b/, 'push: true'],
  [/\btype=registry\b/, 'type=registry 출력'],
  [/\bpush=true\b/, 'push=true 출력'],
  // 레지스트리 자격 증명 같은 비밀 값은 빌드 잡에 들이지 않는다(2026-11-03 코드 리뷰)
  [/\$\{\{\s*secrets\./, '비밀 값(secrets.)'],
  [/^\s*secrets:\s*inherit\b/, 'secrets: inherit'],
  [/\bdocker\s+image\s+push\b/, 'docker image push'],
  [/\bcrane\s+(push|copy|cp|append|mutate)\b/, 'crane 푸시'],
  [/\bskopeo\s+copy\b/, 'skopeo copy'],
  [/\boras\s+push\b/, 'oras push'],
];

function checkBuildJob(file, code, jobsStart) {
  const errors = [];
  const where = (i) => `${file}:${i + 1}`;
  if (jobsStart < 0) return [`${file}: 잡 build가 없다(D-T32 ①: 빌드 잡과 게시 잡을 나눈다)`];
  let from = -1;
  let to = code.length;
  for (let i = jobsStart + 1; i < code.length; i++) {
    const l = code[i];
    if (/^\S/.test(l)) {
      to = Math.min(to, i);
      break;
    }
    const key = /^ {2}([A-Za-z_][\w-]*):\s*(#.*)?$/.exec(l);
    if (!key) continue;
    if (from >= 0) {
      to = i;
      break;
    }
    if (key[1] === 'build') from = i;
  }
  if (from < 0) return [`${file}: 잡 build가 없다(D-T32 ①: 빌드 잡과 게시 잡을 나눈다)`];
  const block = code.slice(from + 1, to);
  // 잡 권한: 4칸 들여쓴 permissions:(그 잡 바로 아래)
  const p = block.findIndex((l) => /^ {4}permissions:/.test(l));
  if (p < 0) {
    errors.push(`${where(from)}: 잡 build에 잡 권한(permissions: contents: read)이 없다(D-T32 ①)`);
  } else {
    const inline = /^ {4}permissions:\s*(.*?)\s*(#.*)?$/.exec(block[p])[1];
    let entries;
    if (inline) {
      const m = /^\{\s*(.*?)\s*\}$/.exec(inline);
      entries = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [inline];
    } else {
      entries = [];
      for (let j = p + 1; j < block.length && (block[j].trim() === '' || /^ {6,}/.test(block[j])); j++) if (block[j].trim()) entries.push(block[j].trim());
    }
    const norm = entries.map((e) => e.replace(/\s*:\s*/, ': '));
    if (!(norm.length === 1 && norm[0] === 'contents: read')) {
      errors.push(`${where(from + 1 + p)}: 잡 build의 권한은 contents: read 하나뿐이어야 한다(D-T32 ①): ${entries.join(', ') || '(비었음)'}`);
    }
  }
  block.forEach((l, k) => {
    for (const [re, what] of BUILD_JOB_FORBIDDEN) if (re.test(l)) errors.push(`${where(from + 1 + k)}: 잡 build에 ${what}이 있다(D-T32 ①: 빌드 잡은 레지스트리·서명·출처 증명 권한이 없다)`);
  });
  return errors;
}

let files = process.argv.slice(2);
let allowlistFile = ALLOWLIST_TF;
const flag = files.indexOf('--allowlist');
if (flag >= 0) {
  allowlistFile = files[flag + 1];
  files.splice(flag, 2);
}
let allowlist;
try {
  allowlist = readAllowlist(readFileSync(allowlistFile, 'utf8'));
} catch (e) {
  console.log(`실패: 조직 액션 허용 목록을 읽지 못했다(${allowlistFile}): ${e.code ?? e.message} (D-T12 ①)`);
  process.exit(1);
}
if (files.length === 0) {
  files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(DIR, f).replace(/\\/g, '/')) : [];
  if (files.length === 0) {
    console.log(`실패: ${DIR}에 검사할 워크플로가 없다`);
    process.exit(1);
  }
}
const errors = files.flatMap((f) => check(f, readFileSync(f, 'utf8'), allowlist));
for (const e of errors) console.log(`실패: ${e}`);
if (errors.length === 0) console.log(`통과: 워크플로 ${files.length}개`);
process.exitCode = errors.length ? 1 : 0;
