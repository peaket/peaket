#!/usr/bin/env node
// 작업 가지 수 경고와 develop 병합 방식 주간 점검(docs/devops.md §2.2.1·§2.2.6·§3.1, FND-160, 추천 적용 2026-11-04).
// GitHub API는 읽기만 한다(워크플로 토큰 contents: read·pull-requests: read). 둘 다 경고만 하고 실패시키지 않는다.
// 쓰는 법:
//   GITHUB_EVENT_PATH=<PR 사건 파일> GITHUB_REPOSITORY=<o/r> GITHUB_TOKEN=<토큰> node tools/ci/branch-watch.mjs count [--codeowners 파일]
//   GITHUB_REPOSITORY=<o/r> GITHUB_TOKEN=<토큰> node tools/ci/branch-watch.mjs weekly [--since-days 8] [--branch origin/develop]
// PR 제목·가지 이름은 식으로 넘기지 않고 사건 파일·API에서 읽는다(check-workflows 규칙 4).
// 명령줄 규칙:
// - API 주소는 GITHUB_API_URL(없으면 https://api.github.com), 토큰이 있으면 Authorization: Bearer로 보낸다. 2xx가 아니면 그 요청이 던진다.
// - 경고는 한 줄에 하나씩 표준 출력에 `::warning::<글>`로 낸다. 글의 %, CR, LF는 %25, %0D, %0A로 바꾼다(워크플로 명령 규칙).
// - count의 CODEOWNERS: --codeowners를 주면 그 파일만 읽는다(없으면 1로 끝난다). 안 주면 GitHub처럼 대상 가지의 것
//   (`git show origin/<pull_request.base.ref>:.github/CODEOWNERS`)을 읽고, 그것이 실패하면 작업 트리의 .github/CODEOWNERS를 읽는다(그것도 없으면 1로 끝난다).
//   세지 않을 PR(작업 가지가 아니거나 포크)이면 CODEOWNERS를 읽지 않는다(없어도 0으로 끝난다).
// - weekly는 `git log --merges --first-parent --since=<n>.days --format=%H%x09%s <branch> --`로 병합 커밋을 고르고,
//   요약을 GITHUB_STEP_SUMMARY가 있으면 그 파일 끝에 붙이고 표준 출력에도 낸다.
// - 종료 코드: 0 정상(경고가 있어도), 2 쓰는 법 오류(명령이 count·weekly가 아님, GITHUB_REPOSITORY 없음, --since-days가 1 이상의 정수가 아님),
//   1 그 밖의 실패(사건 파일을 읽지 못함, weekly의 git log 실패 등. 점검 자체가 돌지 못했다는 뜻)

import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** 팀마다 열린 작업 가지 상한 [가정](docs/devops.md §2.2.1) */
export const MAX_WORK_BRANCHES_PER_TEAM = 3;
/** 주간 점검이 보는 기간(일) [가정]. 주 1회 점검이 빈틈 없이 겹치게 7일보다 하루 길다 */
export const WEEKLY_WINDOW_DAYS = 8;
/** 작업 가지 */
export const WORK_HEAD = /^(feature|bugfix)\//;
/** develop에 병합 커밋으로 들어와도 되는 가지(릴리스·핫픽스·역병합, §2.2.6) */
export const CARRY_HEAD = /^(release|hotfix|merge)\//;

/** 세는 꼴인가: '*', '/경로', '/경로/', '/경로/**'(경로에 글롭 문자가 없다) */
const supported = (pattern) => pattern === '*' || /^\/[^*?[\]!]+(\/\*\*)?$/.test(pattern);

/** 패턴 하나가 경로(앞 '/' 없음)에 맞는가. '/d/**'는 '/d/'와 같다 */
function matches(pattern, path) {
  if (pattern === '*') return true;
  if (!supported(pattern)) return false;
  const p = pattern.replace(/\*\*$/, '').slice(1);
  if (p.endsWith('/')) return path.startsWith(p);
  return path === p || path.startsWith(`${p}/`);
}

const teamsOf = (files, rules) => {
  const teams = new Set();
  for (const f of files) for (const o of ownersOf(f, rules)) teams.add(o);
  return teams;
};

const counted = (pr) => WORK_HEAD.test(pr.head) && !pr.fork;

const PAGE = 100;
const MAX_PAGES = 30;
async function pages(api, base) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const got = await api(`${base}${base.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`);
    if (!Array.isArray(got)) throw new Error(`${base}: 목록이 아니다`);
    all.push(...got);
    if (got.length < PAGE) break;
  }
  return all;
}

const reason = (e) => (e instanceof Error ? e.message : String(e));

const toPr = (repo, raw, files = []) => ({
  number: raw.number,
  head: raw.head?.ref ?? '',
  fork: (raw.head?.repo?.full_name ?? null) !== repo,
  files,
});

/** 잡 요약(마크다운 표)의 칸: 역슬래시를 먼저 이스케이프한 뒤 |를 이스케이프하고 줄바꿈을 띄어 쓴다(CodeQL js/incomplete-sanitization) */
const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');

/**
 * CODEOWNERS 글 → 규칙 목록 [{ pattern, owners }](파일의 줄 차례 그대로). 빈 줄과 '#'로 시작하는 줄은 건너뛴다.
 * 줄은 공백으로 나눠 첫 칸이 경로 패턴, 나머지가 주인(예: '@peaket/queue')이다. 주인이 없는 줄은 건너뛴다.
 * 줄 끝 주석('… # 설명', '#' 앞에 공백이나 탭이 있을 때)의 '#' 뒤는 버린다. 앞뒤 공백을 지운 뒤 판단하므로 들여 쓴 주석 줄도 건너뛰고,
 * 칸은 공백·탭으로 나누며 CRLF 줄 끝도 받는다
 * @param {string} text
 * @returns {Array<{ pattern: string, owners: string[] }>}
 */
export function parseCodeowners(text) {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (owners.length === 0) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * 파일 경로(저장소 뿌리 기준 '/'로 나눈 상대 경로, 앞 '/' 없음)의 주인 목록. 맞는 규칙 가운데 마지막 것(GitHub 규칙)을 쓴다.
 * 패턴: '*'는 모든 파일, '/d/'처럼 '/'로 끝나면 그 폴더 아래 모든 파일('/d/**'도 같다), '/f'는 그 파일 하나 또는 'f/' 아래 모든 파일.
 * 그 밖의 꼴(글롭, 앞 '/'가 없는 경로 등)은 어떤 파일에도 맞지 않는 것으로 본다. 맞는 규칙이 없으면 빈 배열
 * @param {string} path
 * @param {Array<{ pattern: string, owners: string[] }>} rules
 * @returns {string[]}
 */
export function ownersOf(path, rules) {
  let owners = [];
  for (const r of rules) if (matches(r.pattern, path)) owners = r.owners;
  return [...owners];
}

/**
 * 세지 못하는 패턴 목록(ownersOf가 어떤 파일에도 맞추지 않는 꼴: '*', '/경로', '/경로/', '/경로/**' 밖. 경로는 비어 있지 않고 글롭 문자 *?[]!가 없다.
 * 그래서 '/'와 '/**'도 세지 못한다). 규칙 차례, 겹치지 않음
 * @param {Array<{ pattern: string, owners: string[] }>} rules
 * @returns {string[]}
 */
export function unsupportedPatterns(rules) {
  return [...new Set(rules.map((r) => r.pattern).filter((p) => !supported(p)))];
}

/**
 * 열린 PR → 팀마다 그 팀 파일을 바꾸는 열린 작업 가지 PR 번호(오름차순, 겹치지 않음). 센 PR이 없는 팀은 Map에 넣지 않는다.
 * 작업 가지(WORK_HEAD)이고 같은 저장소(fork가 false)인 PR만 센다. PR 하나가 여러 팀의 파일을 바꾸면 팀마다 센다.
 * @param {Array<{ number: number, head: string, fork: boolean, files: string[] }>} prs
 * @param {Array<{ pattern: string, owners: string[] }>} rules
 * @returns {Map<string, number[]>}
 */
export function workBranchesByTeam(prs, rules) {
  const byTeam = new Map();
  for (const pr of prs) {
    if (!counted(pr)) continue;
    for (const team of teamsOf(pr.files, rules)) {
      if (!byTeam.has(team)) byTeam.set(team, new Set());
      byTeam.get(team).add(pr.number);
    }
  }
  return new Map([...byTeam].map(([t, s]) => [t, [...s].sort((a, b) => a - b)]));
}

/**
 * 작업 가지 수 경고 글 목록. current(이번 PR)가 작업 가지가 아니거나 포크면 빈 배열이다.
 * 이번 PR이 바꾼 파일(current.files)의 팀마다, 열린 작업 가지 PR(prs에 current와 번호가 같은 항목이 없으면 current를 더해서 센다.
 * 같은 번호의 항목이 있으면 그 항목을 쓴다)이 max를 넘으면 경고 하나:
 * `팀 <팀>의 열린 작업 가지가 <수>개다(<max>개 이하, docs/devops.md §2.2.1): #<번호>, #<번호>, …`(팀 이름 차례, 번호 오름차순)
 * @param {{ number: number, head: string, fork: boolean, files: string[] }} current
 * @param {Array<{ number: number, head: string, fork: boolean, files: string[] }>} prs
 * @param {Array<{ pattern: string, owners: string[] }>} rules
 * @param {number} [max]
 * @returns {string[]}
 */
export function countWarnings(current, prs, rules, max = MAX_WORK_BRANCHES_PER_TEAM) {
  if (!counted(current)) return [];
  const all = prs.some((p) => p.number === current.number) ? prs : [...prs, current];
  const byTeam = workBranchesByTeam(all, rules);
  return [...teamsOf(current.files, rules)]
    .sort()
    .filter((t) => (byTeam.get(t)?.length ?? 0) > max)
    .map((t) => {
      const nums = byTeam.get(t);
      return `팀 ${t}의 열린 작업 가지가 ${nums.length}개다(${max}개 이하, docs/devops.md §2.2.1): ${nums.map((n) => `#${n}`).join(', ')}`;
    });
}

/**
 * 병합 커밋 제목에서 들어온 가지 이름. 모르면 null.
 * - 'Merge pull request #12 from peaket/feature/x' → 'feature/x'(첫 '/' 앞의 소유자를 뗀다)
 * - "Merge branch 'release/1.0.0' into develop", "Merge branch 'release/1.0.0'" → 'release/1.0.0'
 * - "Merge remote-tracking branch 'origin/hotfix/1.0.1'", "… into develop" → 'hotfix/1.0.1'(앞의 원격 이름 한 칸, 예 'origin/'을 뗀다)
 * 첫 꼴에서 from 뒤에 '/'가 없으면 null이다. 'Merge tag …' 같은 그 밖의 꼴도 null
 * @param {string} subject
 * @returns {string | null}
 */
export function headFromMergeSubject(subject) {
  const s = String(subject);
  let m = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(s);
  if (m) return m[1];
  m = /^Merge remote-tracking branch '(?:[^/']+\/)?([^']+)'/.exec(s);
  if (m) return m[1];
  m = /^Merge branch '([^']+)'/.exec(s);
  if (m) return m[1];
  return null;
}

/**
 * develop 병합 커밋 → 경고 목록. 들어온 가지 = prHead(API가 준 병합 PR의 머리 가지)가 있으면(null·빈 글이 아니면) 그것, 없으면 제목에서 읽은 것.
 * CARRY_HEAD면 통과. 그 밖의 가지면 `<sha 앞 7자리> <가지>: develop에 병합 커밋으로 들어왔다(작업 가지는 스쿼시, §2.2.6)`,
 * 가지를 모르면 `<sha 앞 7자리>: 들어온 가지를 알 수 없는 병합 커밋이다(§2.2.6)`. 커밋 차례 그대로
 * @param {Array<{ sha: string, subject: string, prHead: string | null }>} merges
 * @returns {string[]}
 */
export function mergeWarnings(merges) {
  const out = [];
  for (const { sha, subject, prHead } of merges) {
    const head = prHead || headFromMergeSubject(subject);
    const short = String(sha).slice(0, 7);
    if (!head) out.push(`${short}: 들어온 가지를 알 수 없는 병합 커밋이다(§2.2.6)`);
    else if (!CARRY_HEAD.test(head)) out.push(`${short} ${head}: develop에 병합 커밋으로 들어왔다(작업 가지는 스쿼시, §2.2.6)`);
  }
  return out;
}

/**
 * count 명령의 본체(입출력을 바꿔 끼울 수 있다). event는 PR 사건 본문, api(path)는 GitHub REST GET의 JSON(페이지는 부르는 쪽이 붙인다),
 * codeowners는 CODEOWNERS 글. 열린 PR은 `/repos/<repo>/pulls?state=open&per_page=100&page=<n>`, 바뀐 파일은
 * `/repos/<repo>/pulls/<번호>/files?per_page=100&page=<n>`(page는 1부터, 한 쪽에 100개보다 적게 오면 그 쪽이 마지막, 최대 30쪽)으로 읽는다.
 * 바뀐 파일은 각 항목의 filename과, 이름을 바꾼 항목이면 previous_filename도다(옛 경로의 팀에도 센다). 이번 PR은 event.pull_request(number, head.ref, head.repo.full_name)에서 읽고,
 * 포크 여부는 head.repo.full_name이 repo와 다른지(head.repo가 null이면 포크)로 정한다. 열린 PR 목록의 항목도 같은 칸으로 본다.
 * 이번 PR이 작업 가지가 아니거나 포크면 API를 부르지 않고 빈 경고를 낸다. 셀 PR(같은 저장소의 작업 가지 PR)의 파일만 읽고,
 * 이번 PR의 파일은 목록에 없어도 읽어 더해 센다. 30쪽에 닿아도 따로 경고하지 않는다(GitHub가 PR 파일을 3000개까지만 준다).
 * 셀 때는 unsupportedPatterns마다 경고 `CODEOWNERS 패턴 '<패턴>'은 세지 못하는 꼴이라 건너뛴다('*', '/경로', '/경로/', '/경로/**'만 센다)`를
 * countWarnings의 경고보다 먼저 낸다(API를 부르기 전에 정해지므로 API가 던져도 낸다).
 * API가 던지면 경고 `작업 가지 수를 읽지 못했다: <까닭>`을 하나 더하고 거기서 그친다(던지지 않는다).
 * @param {{ event: any, repo: string, api: (path: string) => Promise<any>, codeowners: string }} o
 * @returns {Promise<{ warnings: string[] }>}
 */
export async function runCount({ event, repo, api, codeowners }) {
  const pr = event?.pull_request;
  if (!pr) return { warnings: [] };
  const current = toPr(repo, pr);
  if (!counted(current)) return { warnings: [] };
  const rules = parseCodeowners(codeowners);
  const warnings = unsupportedPatterns(rules).map(
    (p) => `CODEOWNERS 패턴 '${p}'은 세지 못하는 꼴이라 건너뛴다('*', '/경로', '/경로/', '/경로/**'만 센다)`,
  );
  try {
    // 이름을 바꾼 파일은 옛 경로도 바뀐 파일로 센다
    const files = async (n) =>
      (await pages(api, `/repos/${repo}/pulls/${n}/files`)).flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
    current.files = await files(current.number);
    const open = [];
    for (const raw of await pages(api, `/repos/${repo}/pulls?state=open`)) {
      const p = toPr(repo, raw);
      if (!counted(p)) continue;
      p.files = p.number === current.number ? current.files : await files(p.number);
      open.push(p);
    }
    return { warnings: [...warnings, ...countWarnings(current, open, rules)] };
  } catch (e) {
    return { warnings: [...warnings, `작업 가지 수를 읽지 못했다: ${reason(e)}`] };
  }
}

/**
 * weekly 명령의 본체. merges는 `git log --merges --first-parent --since=<n>.days <branch>`로 고른 [{ sha, subject }],
 * api는 GET JSON. 커밋마다 차례로 `/repos/<repo>/commits/<sha>/pulls`(쿼리·쪽 넘김 없이)의 PR 가운데 merge_commit_sha가 그 커밋인 것의 head.ref를 prHead로 쓴다
 * (없으면 null, API가 던지면 null로 보고 경고 `<sha 앞 7자리>: 병합 PR을 읽지 못했다: <까닭>`을 더한다).
 * 경고 차례: 커밋 차례대로, 한 커밋에서 'PR을 읽지 못했다'가 mergeWarnings의 경고보다 먼저다.
 * 결과 summary는 잡 요약용 마크다운이다. 검사한 병합 커밋 수, 보는 기간(sinceDays일, 기본 WEEKLY_WINDOW_DAYS)과 경고 글이 모두 들어간다.
 * 경고 글을 표 칸에 넣을 때 '|'는 '\|'로, 줄바꿈 하나(CRLF·LF·홀로 있는 CR)는 공백 하나로 바꾼다. summary에는 CR이 남지 않는다
 * @param {{ repo: string, merges: Array<{ sha: string, subject: string }>, api: (path: string) => Promise<any>, sinceDays?: number }} o
 * @returns {Promise<{ warnings: string[], summary: string }>}
 */
export async function runWeekly({ repo, merges, api, sinceDays = WEEKLY_WINDOW_DAYS }) {
  const warnings = [];
  for (const m of merges) {
    let prHead = null;
    try {
      const prs = await api(`/repos/${repo}/commits/${m.sha}/pulls`);
      const hit = (Array.isArray(prs) ? prs : []).find((p) => p?.merge_commit_sha === m.sha);
      prHead = hit?.head?.ref ?? null;
    } catch (e) {
      warnings.push(`${String(m.sha).slice(0, 7)}: 병합 PR을 읽지 못했다: ${reason(e)}`);
    }
    warnings.push(...mergeWarnings([{ sha: m.sha, subject: m.subject, prHead }]));
  }
  const lines = [
    '## develop 병합 방식 주간 점검(docs/devops.md §2.2.6)',
    '',
    `지난 ${sinceDays}일 develop 첫 부모 이력의 병합 커밋 ${merges.length}개, 경고 ${warnings.length}건.`,
    '',
  ];
  if (warnings.length > 0) lines.push('| 경고 |', '| --- |', ...warnings.map((w) => `| ${cell(w)} |`), '');
  return { warnings, summary: lines.join('\n') };
}

/** GitHub REST GET(읽기만). 2xx가 아니면 상태 코드를 담아 던진다 */
function githubApi(token, base = process.env.GITHUB_API_URL || 'https://api.github.com') {
  return async (path) => {
    const res = await fetch(`${base}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'peaket-branch-watch',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GET ${path.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  };
}

// 워크플로 명령 줄의 메시지 부분 이스케이프(GitHub Actions 규칙: %, CR, LF)
const escapeCommand = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** develop 첫 부모 이력의 병합 커밋 [{ sha, subject }] */
function mergesSince(branch, sinceDays) {
  const out = execFileSync('git', ['log', '--merges', '--first-parent', `--since=${sinceDays}.days`, '--format=%H%x09%s', branch, '--'], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

/** count가 쓰는 CODEOWNERS 글: 준 파일, 아니면 GitHub처럼 대상 가지의 것, 그것도 못 읽으면 작업 트리의 것 */
function codeownersFor(event, file) {
  if (file) return readFileSync(file, 'utf8');
  const base = event?.pull_request?.base?.ref;
  if (base) {
    try {
      return execFileSync('git', ['show', `origin/${base}:.github/CODEOWNERS`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      // 대상 가지에 아직 CODEOWNERS가 없거나 가지를 받지 않았다
    }
  }
  return readFileSync('.github/CODEOWNERS', 'utf8');
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'since-days': { type: 'string' },
      branch: { type: 'string', default: 'origin/develop' },
      codeowners: { type: 'string' },
    },
  });
  const [command] = positionals;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!['count', 'weekly'].includes(command) || !repo) {
    console.error('쓰는 법: GITHUB_REPOSITORY=<o/r> node tools/ci/branch-watch.mjs count [--codeowners 파일] | weekly [--since-days 8] [--branch origin/develop]');
    return 2;
  }
  const api = githubApi(process.env.GITHUB_TOKEN);
  if (command === 'count') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    // 세지 않을 PR이면 runCount가 CODEOWNERS를 보지 않으니 읽지도 않는다
    const pr = event?.pull_request;
    const codeowners = pr && counted(toPr(repo, pr)) ? codeownersFor(event, values.codeowners) : '';
    const { warnings } = await runCount({ event, repo, api, codeowners });
    for (const w of warnings) console.log(`::warning::${escapeCommand(w)}`);
    console.log(`작업 가지 수 경고 ${warnings.length}건(경고만 한다)`);
    return 0;
  }
  const sinceDays = Number(values['since-days'] ?? WEEKLY_WINDOW_DAYS);
  if (!Number.isInteger(sinceDays) || sinceDays < 1) {
    console.error(`--since-days는 1 이상의 정수다(받은 값 ${values['since-days']})`);
    return 2;
  }
  // 이력을 읽지 못하면(가지 없음 등) 점검이 돌지 못한 것이라 던져서 잡을 실패시킨다
  const merges = mergesSince(values.branch, sinceDays);
  const { warnings, summary } = await runWeekly({ repo, merges, api, sinceDays });
  for (const w of warnings) console.log(`::warning::${escapeCommand(w)}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // process.exit 대신 종료 코드만 둔다(열린 fetch 연결이 닫히기 전에 끝내면 Windows Node가 넘어진다)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`branch-watch: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    },
  );
}
