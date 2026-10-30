#!/usr/bin/env node
// 릴리스·핫픽스 계획(docs/devops.md §2.2.2~§2.2.5, 시험 D-T22·D-T23·D-T25·D-T41 ④, openspec 변경 add-release-workflows).
// git만 읽고 판단한다. 가지·커밋·태그·PR은 release.yml이 릴리스 봇 토큰으로 GitHub API를 불러 만든다.
// 쓰는 법:
//   node tools/ci/release-plan.mjs start --kind release|hotfix [--from origin/develop] [--notes 파일] [--package-json 파일]
//   node tools/ci/release-plan.mjs finish --branch release/X.Y.Z|hotfix/X.Y.Z [--merged <병합 커밋>] [--notes 파일] [--backmerge-package-json 파일]
//   node tools/ci/release-plan.mjs verify --merged <main 병합 커밋> --candidate <후보 커밋> [--notes 파일]
// 결과는 GITHUB_OUTPUT이 있으면 'key=value' 줄로, 없으면 JSON으로 표준 출력에 낸다. 안내는 표준 오류로 낸다.
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseTitle } from './conventional.mjs';

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CARRY_BRANCH = /^(release|hotfix)\/((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;
const RELEASE_COMMIT = /^chore\(release\): /;
// 바뀌면 자바스크립트 배포 단위를 모두 새로 만든다(공용 패키지·계약·작업 공간·Node 판·이미지 빌드 절차, 설계 결정 5)
const WIDEN_JS = [/^packages\//, /^docs\/api\//, /^package\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/, /^\.nvmrc$/, /^\.github\/workflows\/build-image\.yml$/];

class Stop extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trimEnd();
const gitOk = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};
const note = (msg) => console.error(msg);

const semver = (s) => s.split('.').map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// vX.Y.Z 꼴의 태그를 SemVer 차례로(가장 큰 것이 앞)
function releaseTags() {
  return git('tag', '--list', 'v*').split('\n').filter((t) => TAG.test(t))
    .map((t) => ({ name: t, v: semver(t.slice(1)) }))
    .sort((a, b) => compare(b.v, a.v));
}

// origin의 그 종류 가지 이름들(예: 'release/0.2.0')
const remoteBranches = (kind) => git('for-each-ref', '--format=%(refname:strip=3)', `refs/remotes/origin/${kind}/`).split('\n').filter(Boolean);

function commitsBetween(from, to) {
  const range = from ? [`${from}..${to}`] : [to];
  const out = git('log', '--no-merges', '--reverse', '--format=%H%x1f%s%x1f%b%x1e', ...range);
  return out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [sha, subject, body] = r.split('\x1f');
    return { sha, subject, body: body ?? '', cc: parseTitle(subject, body) };
  }).filter((c) => !RELEASE_COMMIT.test(c.subject));
}

// §2.2.5: !·BREAKING CHANGE는 MAJOR(0.y.z에서는 y), feat는 MINOR, 그 밖은 PATCH. 태그가 없으면 첫 판 0.1.0
function nextVersion(prev, commits) {
  if (!prev) return [0, 1, 0];
  const [M, m, p] = prev;
  if (commits.some((c) => c.cc?.breaking)) return M === 0 ? [0, m + 1, 0] : [M + 1, 0, 0];
  if (commits.some((c) => c.cc?.type === 'feat')) return [M, m + 1, 0];
  return [M, m, p + 1];
}

// 배포 단위: services/<이름>, apps/<이름>(관제 위젯은 apps/widgets/<이름>), data/dbt_project.yml이 있으면 data
function deployUnits(rev) {
  const dirs = (path) => (gitOk('ls-tree', '-d', '--name-only', `${rev}:${path}`) ?? '').split('\n').filter(Boolean);
  const js = [
    ...dirs('services').map((d) => `services/${d}`),
    ...dirs('apps').filter((d) => d !== 'widgets').map((d) => `apps/${d}`),
    ...dirs('apps/widgets').map((d) => `apps/widgets/${d}`),
  ];
  const data = gitOk('cat-file', '-e', `${rev}:data/dbt_project.yml`) !== null;
  return { js, data };
}

function changedUnits(prevTag, rev) {
  const { js, data } = deployUnits(rev);
  const files = prevTag ? git('diff', '--name-only', '--no-renames', prevTag, rev).split('\n').filter(Boolean) : null;
  const touched = (unit) => files === null || files.some((f) => f.startsWith(`${unit}/`));
  const widen = files === null || files.some((f) => WIDEN_JS.some((r) => r.test(f)));
  const out = js.filter((u) => widen || touched(u));
  if (data && touched('data')) out.push('data');
  return out.sort();
}

// 제목의 @이름이 알림을 보내지 않게 코드 표시로 감싼다
const quiet = (s) => s.replace(/@([A-Za-z0-9][\w-]*(?:\/[\w.-]+)?)/g, '`@$1`');
const rank = (c) => (c.cc?.breaking ? 0 : c.cc?.type === 'feat' ? 1 : c.cc?.type === 'fix' ? 2 : 3);

function changelog(prevTag, version, commits, units) {
  const lines = [`## 변경 기록: ${prevTag ? `${prevTag} → ${version}` : `첫 출시 ${version}`}`, ''];
  const breaking = commits.filter((c) => c.cc?.breaking).length;
  if (breaking) lines.push(`- 호환을 깨는 변경: ${breaking}건`, '');
  if (commits.length === 0) lines.push('- 커밋 없음', '');
  // 범위(가상 팀 이름)별로 묶는다(§2.2.5). 범위 없는 것과 형식 밖 제목은 마지막 묶음이다
  const groups = new Map();
  for (const c of commits) {
    const key = c.cc?.scope ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  for (const key of keys) {
    lines.push(`### ${key || '(범위 없음)'}`, '');
    const items = groups.get(key).map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i);
    for (const { c } of items) {
      const text = c.cc ? `${c.cc.type}${c.cc.bang || c.cc.breaking ? '!' : ''}: ${c.cc.description}` : c.subject;
      lines.push(`- ${quiet(text)} (${c.sha.slice(0, 7)})`);
    }
    lines.push('');
  }
  lines.push('### 바뀐 배포 단위', '', ...(units.length ? units.map((u) => `- ${u}`) : ['- 없음']), '');
  return lines.join('\n');
}

// 'version'이 있으면 그 자리에서 바꾸고, 없으면 'name' 바로 뒤(이름도 없으면 맨 앞)에 둔다
function bumpedPackageJson(rev, version) {
  const pkg = JSON.parse(git('show', `${rev}:package.json`));
  const entries = Object.entries(pkg).filter(([k]) => k !== 'version');
  const at = 'version' in pkg ? Object.keys(pkg).indexOf('version') : entries.findIndex(([k]) => k === 'name') + 1;
  entries.splice(at, 0, ['version', version]);
  return JSON.stringify(Object.fromEntries(entries), null, 2) + '\n';
}

const branchVersion = (b) => semver(b.slice(b.indexOf('/') + 1));

function start({ kind, from, notes, 'package-json': pkgOut }) {
  const tags = releaseTags();
  const prev = tags[0];
  let base;
  let version;
  let commits = [];
  if (kind === 'release') {
    const open = remoteBranches('release');
    if (open.length) return { release: 'false', reason: `이미 열린 릴리스 가지 ${open.join(', ')}가 있다. 마무리하거나 닫은 뒤 다시 자른다(§2.2.1)`, kind };
    base = git('rev-parse', `${from}^{commit}`);
    commits = commitsBetween(prev?.name, base);
    if (prev && commits.length === 0) return { release: 'false', reason: `${prev.name} 뒤에 출시할 변경이 없다`, kind };
    // 열린 핫픽스보다 큰 판을 받는다. 같은 판을 두 가지가 받으면 나중에 마무리하는 쪽이 태그가 이미 있어 끝나지 않는다
    const floor = [prev?.v, ...remoteBranches('hotfix').map(branchVersion)].filter(Boolean).sort((a, b) => compare(b, a))[0];
    version = nextVersion(floor, commits).join('.');
  } else {
    if (!prev) throw new Stop('출시 태그가 없다. 핫픽스는 출시본에서만 연다(§2.2.3)');
    const open = remoteBranches('hotfix');
    if (open.length) throw new Stop(`이미 열린 핫픽스 가지 ${open.join(', ')}가 있다. 핫픽스는 하나씩 연다(§2.2.1)`);
    version = [prev.v[0], prev.v[1], prev.v[2] + 1].join('.');
    const clash = remoteBranches('release').find((b) => b === `release/${version}`);
    if (clash) throw new Stop(`열린 릴리스 가지 ${clash}과 판이 겹친다. 릴리스를 닫고(§2.2.2 6번 포기) 핫픽스를 연 뒤 다시 자른다`);
    base = git('rev-parse', `${prev.name}^{commit}`);
  }
  const units = changedUnits(prev?.name, base);
  if (notes) writeFileSync(notes, changelog(prev?.name, version, commits, units) + (kind === 'hotfix' ? '\n핫픽스 수정은 마무리 때 변경 기록을 다시 만들어 GitHub Release에 붙인다.\n' : ''));
  if (pkgOut) writeFileSync(pkgOut, bumpedPackageJson(base, version));
  return {
    release: 'true', reason: '', kind, version, branch: `${kind}/${version}`, base_sha: base,
    previous_tag: prev?.name ?? '', package_blob: git('rev-parse', `${base}:package.json`), units: JSON.stringify(units),
  };
}

// --merged: main 병합 뒤 다음 단계에서 멈춘 마무리를 다시 돌릴 때 준다. 릴리스 가지는 병합 때 지워졌을 수 있으므로
// 후보는 병합 커밋의 두 번째 부모로 잇고, 그 병합 커밋에 이미 단 태그는 받아들인다
function finish({ branch, notes, merged, 'backmerge-package-json': backmergePkgOut }) {
  const m = CARRY_BRANCH.exec(branch ?? '');
  if (!m) throw new Stop(`마무리할 가지는 release/X.Y.Z나 hotfix/X.Y.Z여야 한다: '${branch ?? ''}'`);
  const [, kind, version] = m;
  const tag = `v${version}`;
  const tagCommit = gitOk('rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`);
  let candidate;
  let mergedSha = '';
  if (merged) {
    mergedSha = gitOk('rev-parse', '--verify', '--quiet', `${merged}^{commit}`);
    if (mergedSha === null) throw new Stop(`병합 커밋 ${merged}을 읽지 못했다`);
    candidate = gitOk('rev-parse', '--verify', '--quiet', `${mergedSha}^2`);
    if (candidate === null) throw new Stop(`병합 커밋 ${mergedSha}에 두 번째 부모가 없다`);
    if (tagCommit !== null && tagCommit !== mergedSha) throw new Stop(`태그 ${tag}이 병합 커밋이 아닌 곳(${tagCommit})에 있다`);
  } else if (tagCommit !== null) {
    throw new Stop(`태그 ${tag}이 이미 있다. 태그는 옮기거나 지우지 않는다(§2.2.5)`);
  }
  const tags = releaseTags().filter((t) => t.name !== tag);
  if (tags[0] && compare(semver(version), tags[0].v) <= 0) throw new Stop(`판 ${version}은 마지막 출시 태그 ${tags[0].name}보다 커야 한다`);
  if (!merged) {
    candidate = gitOk('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`);
    if (candidate === null) throw new Stop(`원격 가지 origin/${branch}이 없다(체크아웃의 fetch-depth를 확인)`);
  }
  let target = 'develop';
  if (kind === 'hotfix') {
    // 열린 릴리스 가지가 있으면 그 가지로 역병합한다(§2.2.3, D-T25)
    const open = remoteBranches('release');
    if (open.length > 1) throw new Stop(`열린 릴리스 가지가 둘 이상이다(${open.join(', ')}). 역병합 대상을 정하지 못한다`);
    if (open.length === 1) target = open[0];
  }
  const prev = tags.find((t) => compare(t.v, semver(version)) < 0);
  const units = changedUnits(prev?.name, candidate);
  if (notes) writeFileSync(notes, changelog(prev?.name, version, commitsBetween(prev?.name, candidate), units));
  // 핫픽스를 열린 릴리스로 역병합하면 두 가지가 package.json의 판 줄을 서로 다르게 바꿔 늘 충돌한다.
  // 역병합 가지에 대상의 판으로 맞춘 커밋을 얹으면 두 쪽의 바꿈이 같아져 충돌하지 않는다
  let backmergeVersion = '';
  if (target.startsWith('release/')) {
    const targetVersion = JSON.parse(git('show', `refs/remotes/origin/${target}:package.json`)).version ?? '';
    if (targetVersion && targetVersion !== JSON.parse(git('show', `${candidate}:package.json`)).version) backmergeVersion = targetVersion;
  }
  if (backmergeVersion && backmergePkgOut) writeFileSync(backmergePkgOut, bumpedPackageJson(candidate, backmergeVersion));
  return {
    kind, version, tag, tag_exists: String(tagCommit !== null), merged: mergedSha, branch, candidate, previous_tag: prev?.name ?? '',
    backmerge_target: target, backmerge_branch: `merge/${kind}-${version}-to-${target.replace('/', '-')}`,
    backmerge_version: backmergeVersion, backmerge_package_blob: backmergeVersion ? git('rev-parse', `${candidate}:package.json`) : '',
    units: JSON.stringify(units),
  };
}

// §2.2.4 병합 뒤: main 병합 커밋의 두 번째 부모가 후보이고 트리가 후보와 같아야 태그를 단다
function verify({ merged, candidate, notes }) {
  if (!merged || !candidate) throw new Stop('verify에는 --merged와 --candidate가 있어야 한다', 2);
  const m = gitOk('rev-parse', '--verify', '--quiet', `${merged}^{commit}`);
  const c = gitOk('rev-parse', '--verify', '--quiet', `${candidate}^{commit}`);
  if (m === null || c === null) throw new Stop(`커밋을 읽지 못했다: ${m === null ? merged : candidate}`);
  const second = gitOk('rev-parse', '--verify', '--quiet', `${m}^2`);
  if (second !== c) throw new Stop(`병합 커밋 ${m}의 두 번째 부모(${second ?? '없음'})가 후보 ${c}가 아니다`);
  const tree = git('rev-parse', `${m}^{tree}`);
  const candidateTree = git('rev-parse', `${c}^{tree}`);
  if (tree !== candidateTree) {
    const diff = git('diff', '--name-only', candidateTree, tree).split('\n').filter(Boolean);
    throw new Stop(`병합 결과 트리가 후보와 다르다: ${diff.join(', ')}. 태그를 달지 않는다(§2.2.4)`);
  }
  if (notes) {
    appendFileSync(notes, ['', '### 출시 기록', '', '| 항목 | 값 |', '| --- | --- |', `| 태그 커밋 | \`${m}\` |`, `| 후보 커밋 | \`${c}\` |`, `| 트리 | \`${tree}\` |`, ''].join('\n'));
  }
  return { merged: m, candidate: c, tree };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      kind: { type: 'string' }, from: { type: 'string', default: 'origin/develop' }, notes: { type: 'string' },
      'package-json': { type: 'string' }, 'backmerge-package-json': { type: 'string' },
      branch: { type: 'string' }, merged: { type: 'string' }, candidate: { type: 'string' },
    },
  });
  if (command === 'start') {
    if (values.kind !== 'release' && values.kind !== 'hotfix') throw new Stop('start에는 --kind release나 --kind hotfix가 있어야 한다', 2);
    return start(values);
  }
  if (command === 'finish') return finish(values);
  if (command === 'verify') return verify(values);
  throw new Stop('쓰는 법: release-plan.mjs start|finish|verify …(파일 머리 주석)', 2);
}

try {
  const result = main();
  if (result.reason) note(`경고: ${result.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    note(`통과: ${JSON.stringify(result)}`);
  } else {
    console.log(JSON.stringify(result));
  }
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  note(`실패: ${e.message}`);
  process.exitCode = e.code;
}
