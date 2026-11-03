#!/usr/bin/env node
// 가지 규칙 검사(필수 검사 branch-policy, docs/devops.md §2.2.6, 시험 D-T41, openspec 변경 add-ci-foundation).
// PR 정보는 GITHUB_EVENT_PATH의 사건 파일에서 읽는다. PR 제목·본문·가지 이름을 워크플로의 run:에
// 끼워 넣으면 명령 주입이 되기 때문이다. 바뀐 파일과 가지 나이는 체크아웃한 저장소의 git으로 읽는다.
// 실패: 허용 밖 가지 쌍, PR 제목 형식, 빌드 절차(.github/workflows/) 변경에 다른 경로가 섞임.
// 같은 저장소의 릴리스·핫픽스·역병합 PR은 이미 병합된 변경을 옮길 뿐이라, 보호 가지에 아직 없는 새 커밋이 바꾼 파일만
// 섞임 검사를 한다. 포크 PR과 그 밖의 PR은 바뀐 파일 전부로 한다(add-release-workflows).
// 경고만: 작업 가지가 3일을 넘김.
// 쓰는 법: GITHUB_EVENT_PATH=<사건 파일> node tools/ci/branch-policy.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { titleErrors } from './conventional.mjs';

// 머리 가지 → 받을 수 있는 대상 가지(§2.2.6). '열린 release/*'는 PR이 이미 있는 가지를 대상으로 하므로 이름만 본다
const PAIRS = [
  [/^(feature|bugfix|renovate|promote|calendar)\/.+/, /^develop$/],
  [/^bugfix\/.+/, /^(release|hotfix)\/.+/],
  [/^release\/.+/, /^(main|develop)$/],
  [/^hotfix\/.+/, /^(main|develop|release\/.+)$/],
  [/^merge\/.+/, /^(develop|release\/.+)$/],
];
const WORK = /^(feature|bugfix)\//;
// 이미 병합된 변경을 옮기는 가지(출시·역병합). 같은 저장소의 PR일 때만 이렇게 본다
const CARRY = /^(release|hotfix|merge)\//;
// 검토를 거친 변경만 들어오는 보호 가지(규칙 세트, §2.2.6). 여기에 이미 있는 커밋은 다시 나누라고 하지 않는다
const PROTECTED = ['refs/remotes/origin/main', 'refs/remotes/origin/develop', 'refs/remotes/origin/release/', 'refs/remotes/origin/hotfix/'];
const WORKFLOWS = '.github/workflows/';
const MAX_AGE_DAYS = 3; // [가정] §2.2.1

const gh = Boolean(process.env.GITHUB_ACTIONS);
// 주석 명령의 값은 %·줄바꿈을 바꿔 쓴다. 제목이 다음 줄에 워크플로 명령을 만들지 못하게 한다
const escape = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const say = (kind, msg) => console.log(gh ? `::${kind}::${escape(msg)}` : `${kind === 'error' ? '실패' : '경고'}: ${msg}`);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function separationErrors(files) {
  const inside = files.filter((f) => f.startsWith(WORKFLOWS));
  const outside = files.filter((f) => !f.startsWith(WORKFLOWS));
  if (inside.length === 0 || outside.length === 0) return [];
  const shown = outside.slice(0, 5).join(', ') + (outside.length > 5 ? ` 외 ${outside.length - 5}개` : '');
  return [`빌드 절차(${WORKFLOWS})를 바꾸는 PR에 다른 경로가 섞였다(ADR-0169): ${shown}`];
}

const eventPath = process.env.GITHUB_EVENT_PATH;
const pr = eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')).pull_request : undefined;
if (!pr) {
  say('error', 'PR 사건 파일(GITHUB_EVENT_PATH의 pull_request)이 없다');
  process.exit(2);
}

const head = pr.head.ref;
const base = pr.base.ref;
const errors = [];
if (!PAIRS.some(([h, b]) => h.test(head) && b.test(base))) errors.push(`가지 쌍 ${head} → ${base}는 허용 목록(§2.2.6)에 없다`);
errors.push(...titleErrors(pr.title ?? '', pr.body));
// 출시·역병합 PR이 옮기는 커밋 가운데 보호 가지에 아직 없는 새 커밋이 바꾼 파일. 병합 커밋은 손으로 고친 파일만 센다(--cc)
function freshFiles() {
  const refs = git('for-each-ref', '--format=%(refname)', ...PROTECTED).split('\n').filter(Boolean);
  const fresh = git('rev-list', pr.head.sha, '--not', pr.base.sha, ...refs).split('\n').filter(Boolean);
  if (fresh.length === 0) return [];
  return [...new Set(git('log', '--no-walk', '--cc', '--name-only', '--no-renames', '--format=', ...fresh).split('\n').filter(Boolean))];
}

const sameRepo = Boolean(pr.head.repo?.full_name) && pr.head.repo.full_name === pr.base.repo?.full_name;
try {
  // --no-renames: 워크플로를 다른 곳으로 옮기는 것도 두 경로를 함께 바꾼 것으로 본다
  const files = CARRY.test(head) && sameRepo
    ? freshFiles()
    : git('diff', '--name-only', '--no-renames', `${pr.base.sha}...${pr.head.sha}`).split('\n').filter(Boolean);
  errors.push(...separationErrors(files));
} catch (e) {
  // 바뀐 파일을 모르면 섞임 검사를 건너뛰지 않고 실패한다
  errors.push(`바뀐 파일을 읽지 못했다(체크아웃의 fetch-depth를 확인): ${String(e.stderr || e.message).trim()}`);
}
if (WORK.test(head)) {
  try {
    const times = git('log', '--format=%at', `${pr.base.sha}..${pr.head.sha}`).split('\n').filter(Boolean).map(Number);
    const days = times.length ? (Date.now() / 1000 - Math.min(...times)) / 86400 : 0;
    if (days > MAX_AGE_DAYS) say('warning', `작업 가지가 ${Math.floor(days)}일째다. ${MAX_AGE_DAYS}일 안에 develop에 넣도록 작게 나눈다(§2.2.1)`);
  } catch {
    say('warning', '가지 나이를 읽지 못했다');
  }
}

for (const msg of errors) say('error', msg);
if (errors.length === 0) console.log(`통과: ${head} → ${base}`);
process.exitCode = errors.length ? 1 : 0;
