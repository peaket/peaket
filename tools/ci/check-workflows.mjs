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
// 쓰는 법: node tools/ci/check-workflows.mjs [파일...]  (파일이 없으면 .github/workflows/*.yml|yaml)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

function check(file, text) {
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
if (files.length === 0) {
  files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(DIR, f).replace(/\\/g, '/')) : [];
  if (files.length === 0) {
    console.log(`실패: ${DIR}에 검사할 워크플로가 없다`);
    process.exit(1);
  }
}
const errors = files.flatMap((f) => check(f, readFileSync(f, 'utf8')));
for (const e of errors) console.log(`실패: ${e}`);
if (errors.length === 0) console.log(`통과: 워크플로 ${files.length}개`);
process.exitCode = errors.length ? 1 : 0;
