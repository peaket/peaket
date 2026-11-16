#!/usr/bin/env node
// 합치기 전 역할 확인(ADR-0270 결정 5, docs/architecture.md §8.6의 4 '역할 나누기', 계획 docs/review/plans/W7-L1-roles-check.md).
// 작업 가지의 커밋 꼬리말(Batch·Role·Agent-Session·Fix-By)과 바뀐 파일, 머리 커밋의 계획 파일을 읽어
// 역할을 서로 다른 담당이 차례대로 맡았는지 본다. 시험은 tools/ci/roles-check.test.mjs.
//
// 공개 인터페이스(계획 §1, 내놓는 함수는 없다):
//   node tools/ci/roles-check.mjs [--base <리비전>] [--head <리비전>] [--root <저장소>]
//     --base  기본 origin/develop. 여기서 닿는 커밋은 보지 않는다
//     --head  기본 HEAD. 합칠 작업 가지의 끝
//     --root  기본 지금 폴더. git 저장소 뿌리
//   끝 코드: 0 모든 검사 통과, 1 검사 하나라도 실패(실패를 모두 찍은 뒤), 2 실행할 수 없음(인자·리비전·git 오류, 빈 범위)
//   표준 출력(한 줄에 하나):
//     실패: [<검사 이름>] <묶음 ID 또는 -> <짧은 해시 또는 -> <까닭>
//     묶음 <ID>: <코드|문서|기록만> 커밋 <k>개(plan a·test b·impl c·review d·review-fix e·verify f·record g·doc h)
//     통과: 묶음 <N>개, 커밋 <M>개
//     오류: <까닭>
//   GITHUB_ACTIONS=true이면 앞머리 대신 ::error::를 쓰고 값의 %·줄바꿈을 바꿔 쓴다.
import { spawnSync } from 'node:child_process';
import { cells } from './records.mjs';
import { runIfMain } from './entry.mjs';

const ROLES = ['plan', 'test', 'impl', 'review', 'review-fix', 'verify', 'record', 'doc'];
// 담당 표의 역할 칸(감독 record와 리뷰 반영 review-fix는 적지 않는다, 계획 §6의 10)
const TABLE_ROLES = ['plan', 'test', 'impl', 'review', 'verify', 'doc'];
const FIX_BY = ['test', 'impl'];
const BATCH = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Batch·Finding 값 꼴(파일 이름으로도 쓰므로 '..'를 막는다)
const idOk = (v) => BATCH.test(v) && !v.includes('..');
// 코드 경로: ADR-0270 결정 8의 맨 위 폴더 일곱
const CODE_DIRS = ['apps/', 'services/', 'packages/', 'data/', 'infra/', 'tools/', '.github/'];
// 코드를 쓰지 않는 역할. 이 역할의 커밋은 허용 목록(docs/ 아래, 코드 경로 밖의 .md)만 바꾼다(계획 8의 2, 리뷰 RV-02)
const NO_CODE = new Set(['plan', 'review', 'verify', 'record', 'doc']);
// 시험 파일: 이름이 *.test.*·*.spec.*·test_*.py이거나 폴더 마디가 아래 하나(계획 8의 1, 리뷰 RV-01)
const TEST_DIRS = new Set(['test', 'test-int', 'test-sim', '__tests__', 'e2e']);
const TEST_NAME = /^(?:.+\.(test|spec)\..+|test_.+\.py)$/;
const CODE_ORDER = ['plan', 'test', 'impl', 'review', 'verify'];
// 시험만 묶음(plan 커밋의 Batch-Kind: test-only로 밝힘, 계획 W7-L1-roles-testonly 1): 구현 없이 계획 < 시험 < 리뷰 < 검증
const TEST_ONLY_ORDER = ['plan', 'test', 'review', 'verify'];
const TEST_ONLY = 'test-only';
// 차례: 역할마다 첫 커밋보다 앞서야 할 역할들(리뷰·검증 사이는 없다)
const CODE_BEFORE = { test: ['plan'], impl: ['plan', 'test'], review: ['plan', 'test', 'impl'], verify: ['plan', 'test', 'impl'] };
const TEST_ONLY_BEFORE = { test: ['plan'], review: ['plan', 'test'], verify: ['plan', 'test'] };
const DOC_BEFORE = { doc: ['plan'], review: ['plan', 'doc'] };
const DOC_ORDER = ['plan', 'doc', 'review'];
const CODE_SECTIONS = ['실패 확인', '리뷰', '검증', '담당 표'];
const DOC_SECTIONS = ['리뷰', '담당 표'];
const TABLE_HEADER = ['역할', '세션 ID', '모델', '시작', '끝'];
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const SHORT = 10;

const gh = process.env.GITHUB_ACTIONS === 'true';
// 주석 명령의 값은 %·줄바꿈을 바꿔 쓴다(branch-policy.mjs와 같다). Actions 밖에서도 한 줄에 하나를 지킨다
const escape = (s) => (gh ? s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A') : s.replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
const errorLine = (msg) => (gh ? `::error::${escape(msg)}` : `오류: ${escape(msg)}`);

class RunError extends Error {}

// ---- 인자 ----

function parseArgs(argv) {
  const opt = {};
  const keys = { '--base': 'base', '--head': 'head', '--root': 'root' };
  for (let i = 0; i < argv.length; i++) {
    const key = keys[argv[i]];
    if (!key) throw new RunError(`모르는 인자: ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw new RunError(`${argv[i]}에 값이 없다`);
    if (key in opt) throw new RunError(`${argv[i]}를 두 번 줬다`);
    opt[key] = value;
    i++;
  }
  return { base: opt.base ?? 'origin/develop', head: opt.head ?? 'HEAD', root: opt.root ?? process.cwd() };
}

// ---- git ----

function gitIn(root) {
  return (args, input) => {
    const r = spawnSync('git', args, { cwd: root, input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.error) throw new RunError(`git을 실행하지 못했다: ${r.error.message}`);
    return { status: r.status, out: r.stdout, err: String(r.stderr ?? '').trim() };
  };
}

function must(run, args, input, what) {
  const r = run(args, input);
  if (r.status !== 0) throw new RunError(`${what}: ${r.err || `git ${args[0]} 끝 코드 ${r.status}`}`);
  return r.out;
}

function resolveCommit(run, rev) {
  const r = run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  const sha = r.status === 0 ? r.out.toString('utf8').trim() : '';
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new RunError(`리비전 ${rev}를 커밋으로 읽지 못했다`);
  return sha;
}

// cat-file --batch 출력: '<sha> commit <크기>\n<내용>\n'이 이어진다
function readCommits(run, shas) {
  const buf = must(run, ['cat-file', '--batch'], `${shas.join('\n')}\n`, '커밋을 읽지 못했다');
  const out = [];
  let at = 0;
  for (const sha of shas) {
    const nl = buf.indexOf(0x0a, at);
    const head = buf.subarray(at, nl).toString('utf8').split(' ');
    if (head[0] !== sha || head[1] !== 'commit') throw new RunError(`커밋 ${sha}를 읽지 못했다`);
    const size = Number(head[2]);
    const raw = buf.subarray(nl + 1, nl + 1 + size).toString('utf8').replace(/\r\n/g, '\n');
    at = nl + 1 + size + 1;
    const split = raw.indexOf('\n\n');
    const headers = split < 0 ? raw : raw.slice(0, split);
    const parents = headers.split('\n').filter((l) => l.startsWith('parent ')).map((l) => l.slice(7).trim());
    out.push({ sha, parents, message: split < 0 ? '' : raw.slice(split + 2) });
  }
  return out;
}

// 커밋마다 바뀐 파일(옮기기는 옛 경로 지우기와 새 경로 더하기 둘, 합치기 커밋은 첫 부모와 견줌)
function readFiles(run, commits) {
  const lines = commits.map((c) => (c.parents.length ? `${c.sha} ${c.parents[0]}` : c.sha));
  const buf = must(run, ['diff-tree', '--stdin', '-r', '--root', '--always', '--no-renames', '--name-only', '-z'], `${lines.join('\n')}\n`, '바뀐 파일을 읽지 못했다');
  const tokens = buf.toString('utf8').split('\0');
  const files = new Map(commits.map((c) => [c.sha, []]));
  let k = -1;
  for (const t of tokens) {
    if (t === '') continue;
    if (k + 1 < commits.length && t === commits[k + 1].sha) {
      k++;
      continue;
    }
    if (k < 0) throw new RunError('바뀐 파일 출력의 꼴을 읽지 못했다');
    files.get(commits[k].sha).push(t);
  }
  if (k !== commits.length - 1) throw new RunError('바뀐 파일 출력에 빠진 커밋이 있다');
  return files;
}

// ---- 꼬리말 ----

// 마지막 꼬리말 덩이: 제목 문단이 아닌 끝 문단이고 모든 줄이 '키: 값'(이어진 줄은 공백으로 시작)이다. 키는 대소문자 그대로 둔다
function trailers(message) {
  const paragraphs = [];
  let cur = [];
  for (const line of message.split('\n')) {
    if (line.trim() === '') {
      if (cur.length) paragraphs.push(cur);
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) paragraphs.push(cur);
  if (paragraphs.length < 2) return null;
  const last = paragraphs.at(-1);
  const out = [];
  for (const line of last) {
    const m = line.match(/^([A-Za-z0-9-]+):(.*)$/);
    if (m) out.push({ key: m[1], value: m[2] });
    else if (/^[ \t]/.test(line) && out.length) out.at(-1).value += ` ${line.trim()}`;
    else return null;
  }
  return out;
}

function readTrailers(c) {
  const problems = [];
  const block = trailers(c.message);
  const all = block ?? [];
  const values = (key) => all.filter((t) => t.key === key).map((t) => t.value.trim());
  const one = (key) => {
    const v = values(key);
    if (v.length === 0) problems.push(`꼬리말 ${key}가 없다${block ? '' : '(마지막 문단이 꼬리말 덩이가 아니다)'}`);
    else if (v.length > 1) problems.push(`꼬리말 ${key}가 ${v.length}개다`);
    return v.length === 1 ? v[0] : null;
  };
  let batch = one('Batch');
  if (batch !== null && !idOk(batch)) {
    problems.push(`Batch 값 '${batch}'의 꼴이 틀렸다(영문·숫자로 시작하고 영문·숫자·. _ -만, '..' 없음)`);
    batch = null;
  }
  let role = one('Role');
  if (role !== null && !ROLES.includes(role)) {
    problems.push(`Role 값 '${role}'은 목록(${ROLES.join('·')}) 밖이다`);
    role = null;
  }
  let session = one('Agent-Session');
  if (session !== null && (session === '' || /\s/.test(session))) {
    problems.push(`Agent-Session 값 '${session}'이 비었거나 공백이 있다`);
    session = null;
  }
  const fix = values('Fix-By');
  let fixBy = null;
  if (role === 'review-fix') {
    if (fix.length !== 1) problems.push(`review-fix 커밋에 Fix-By(test 또는 impl)가 ${fix.length === 0 ? '없다' : `${fix.length}개다`}`);
    else if (!FIX_BY.includes(fix[0])) problems.push(`Fix-By 값 '${fix[0]}'은 test·impl이 아니다`);
    else fixBy = fix[0];
  } else if (fix.length) problems.push(`Fix-By는 review-fix 커밋에만 단다(이 커밋은 ${role ?? '역할 모름'})`);
  // Finding: 리뷰 반영이 고치는 지적마다 한 줄(계획 8의 3, 리뷰 RV-03)
  const found = values('Finding');
  const findings = [];
  if (role === 'review-fix') {
    if (found.length === 0) problems.push('review-fix 커밋에 Finding(고치는 지적 번호)이 없다');
    for (const f of found) {
      if (idOk(f)) findings.push(f);
      else problems.push(`Finding 값 '${f}'의 꼴이 틀렸다(Batch와 같은 꼴)`);
    }
  } else if (found.length) problems.push(`Finding은 review-fix 커밋에만 단다(이 커밋은 ${role ?? '역할 모름'})`);
  // Batch-Kind: plan 커밋에만 하나, 값은 그대로 test-only(시험만 묶음을 밝힌다)
  const kinds = values('Batch-Kind');
  let testOnly = false;
  if (kinds.length && role !== 'plan') problems.push(`Batch-Kind는 plan 커밋에만 단다(이 커밋은 ${role ?? '역할 모름'})`);
  else if (kinds.length > 1) problems.push(`꼬리말 Batch-Kind가 ${kinds.length}개다`);
  else if (kinds.length === 1 && kinds[0] !== TEST_ONLY) problems.push(`Batch-Kind 값 '${kinds[0]}'은 ${TEST_ONLY}가 아니다`);
  else testOnly = kinds.length === 1;
  // 세션·담당 표에서 세는 역할: 리뷰 반영은 Fix-By 쪽 역할이다(모르면 세지 않는다)
  const acting = role === 'review-fix' ? fixBy : role;
  return { batch, role, session, fixBy, acting, findings, testOnly, problems };
}

// ---- 경로 ----

function isTestPath(p) {
  const parts = p.split('/');
  const name = parts.at(-1);
  return TEST_NAME.test(name) || parts.slice(0, -1).some((d) => TEST_DIRS.has(d));
}
const isCodePath = (p) => CODE_DIRS.some((d) => p.startsWith(d));
// 코드를 쓰지 않는 역할이 바꿔도 되는 경로(허용 목록, 대소문자 그대로)
const isDocPath = (p) => p.startsWith('docs/') || (!isCodePath(p) && p.endsWith('.md'));

// ---- 계획 파일 ----

// 펜스 밖의 제목 줄: { line, level, name }(name은 앞 번호를 뺀 것)
function headings(lines) {
  const out = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      return;
    }
    if (fence) return;
    const h = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/);
    if (!h) return;
    const text = (h[2] ?? '').replace(/[ \t]+#+$/, '').trim();
    out.push({ line: i, level: h[1].length, name: text.replace(/^\d+(?:\.\d+)*\.?[ \t]+/, '') });
  });
  return out;
}

// 절 이름에 맞는 제목(수준 2·3)마다 [시작 줄, 끝 줄) 범위
function sections(lines, hs, name) {
  return hs
    .map((h, k) => ({ h, k }))
    .filter(({ h }) => (h.level === 2 || h.level === 3) && h.name === name)
    .map(({ h, k }) => {
      const next = hs.slice(k + 1).find((x) => x.level <= h.level);
      return { from: h.line + 1, to: next ? next.line : lines.length };
    });
}

// 절 내용(같은 이름의 절 모두, 하위 제목과 그 아래 줄 포함). 빈 줄은 빼고 줄 끝 공백은 지운다. 절이 없으면 null
function sectionText(text, name) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const found = sections(lines, headings(lines), name);
  if (found.length === 0) return null;
  return found.flatMap((r) => lines.slice(r.from, r.to)).map((l) => l.trimEnd()).filter((l) => l !== '').join('\n');
}

function sectionFilled(lines, hs, range) {
  const isHeading = new Set(hs.map((h) => h.line));
  for (let i = range.from; i < range.to; i++) if (lines[i].trim() !== '' && !isHeading.has(i)) return true;
  return false;
}

function readTime(s) {
  const m = s.match(TIME);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return null;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > days) return null;
  let off = 0;
  if (m[7] !== 'Z') {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (oh > 23 || om > 59) return null;
    off = (m[8] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return Date.UTC(y, mo - 1, d, h, mi, se) - off * 60000;
}

// 담당 표 절 안의 첫 표를 읽는다. 문제 목록과 (역할, 세션) 줄을 돌려준다
function readTable(lines, range) {
  const problems = [];
  let i = range.from;
  while (i < range.to && !lines[i].trim().startsWith('|')) i++;
  if (i >= range.to) return { problems: ['담당 표 절에 표가 없다'], pairs: [] };
  const rows = [];
  for (; i < range.to && lines[i].trim().startsWith('|'); i++) rows.push({ n: i + 1, cells: cells(lines[i]) });
  const [header, sep, ...data] = rows;
  if (header.cells.join(' | ') !== TABLE_HEADER.join(' | ')) {
    return { problems: [`담당 표 머리가 '${TABLE_HEADER.join(' | ')}'가 아니다(${header.cells.join(' | ')})`], pairs: [] };
  }
  if (!sep || sep.cells.length !== TABLE_HEADER.length || !sep.cells.every((c) => /^:?-{3,}:?$/.test(c))) {
    return { problems: ['담당 표 머리 밑에 구분 줄(| --- | … |)이 없다'], pairs: [] };
  }
  const pairs = [];
  for (const r of data) {
    const at = `담당 표 ${r.n}번째 줄`;
    if (r.cells.length !== TABLE_HEADER.length) {
      problems.push(`${at}의 칸이 ${r.cells.length}개다(${TABLE_HEADER.length}개여야 한다)`);
      continue;
    }
    const empty = TABLE_HEADER.filter((_, k) => r.cells[k] === '');
    if (empty.length) {
      problems.push(`${at}의 ${empty.join('·')} 칸이 비었다`);
      continue;
    }
    const [role, session, , start, end] = r.cells;
    if (!TABLE_ROLES.includes(role)) problems.push(`${at}의 역할 '${role}'은 ${TABLE_ROLES.join('·')} 가운데 하나가 아니다`);
    const a = readTime(start);
    const b = readTime(end);
    if (a === null) problems.push(`${at}의 시작 '${start}'은 오프셋이 붙은 ISO 8601 시각이 아니다`);
    if (b === null) problems.push(`${at}의 끝 '${end}'은 오프셋이 붙은 ISO 8601 시각이 아니다`);
    if (a !== null && b !== null && b < a) problems.push(`${at}의 끝 ${end}이 시작 ${start}보다 이르다`);
    pairs.push(`${role} ${session}`);
  }
  return { problems, pairs };
}

// ---- 본체 ----

function check(opt) {
  const run = gitIn(opt.root);
  const top = run(['rev-parse', '--git-dir']);
  if (top.status !== 0) throw new RunError(`${opt.root}는 git 저장소가 아니다: ${top.err}`);
  const base = resolveCommit(run, opt.base);
  const head = resolveCommit(run, opt.head);
  const shas = must(run, ['rev-list', '--reverse', '--topo-order', `${base}..${head}`], undefined, '범위를 읽지 못했다')
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
  if (shas.length === 0) throw new RunError(`범위 ${opt.base}..${opt.head}에 커밋이 없다(빈 범위는 통과로 치지 않는다)`);

  const commits = readCommits(run, shas);
  const files = readFiles(run, commits);
  const fails = [];
  const fail = (name, batch, sha, reason) => fails.push(`[${name}] ${batch ?? '-'} ${sha ? sha.slice(0, SHORT) : '-'} ${reason}`);

  commits.forEach((c, i) => {
    Object.assign(c, readTrailers(c), { index: i, files: files.get(c.sha) });
  });

  // 커밋 하나로 보는 검사: ① 꼬리말, ② 범위, ⑤ 시험 파일, ⑥ 코드 경로
  for (const c of commits) {
    for (const p of c.problems) fail('꼬리말', c.batch, c.sha, p);
    if (c.parents.length > 1) fail('범위', c.batch, c.sha, `합치기 커밋이다(부모 ${c.parents.length}개). 묶음은 올린 뒤 앞으로 감기로 합친다`);
    if (c.acting === 'impl') {
      for (const p of c.files.filter(isTestPath)) fail('시험 파일', c.batch, c.sha, `${c.role === 'review-fix' ? '구현 쪽 리뷰 반영' : '구현'} 커밋이 시험 파일 ${p}를 바꿨다`);
    }
    if (NO_CODE.has(c.role)) {
      for (const p of c.files.filter((f) => !isDocPath(f))) fail('코드 경로', c.batch, c.sha, `${c.role} 커밋이 문서 밖 경로 ${p}를 바꿨다(docs/ 아래와 코드 경로 밖의 .md만 된다)`);
    }
  }

  // ⑦ 세션: 범위 전체에서 세션 하나는 역할 하나(처음 나온 커밋의 역할)만 맡는다
  const firstRole = new Map();
  const told = new Set();
  for (const c of commits) {
    if (!c.session || !c.acting) continue;
    const first = firstRole.get(c.session);
    if (first === undefined) firstRole.set(c.session, c.acting);
    else if (first !== c.acting && !told.has(`${c.session} ${c.acting}`)) {
      told.add(`${c.session} ${c.acting}`);
      fail('세션', c.batch, c.sha, `세션 ${c.session}가 ${first}와 ${c.acting}을 함께 맡았다`);
    }
  }

  // 묶음마다: ③ 차례, ④ 구성, ⑧ 계획 파일, ⑨ 담당 표
  const batches = new Map();
  for (const c of commits) {
    if (!c.batch) continue;
    if (!batches.has(c.batch)) batches.set(c.batch, []);
    batches.get(c.batch).push(c);
  }
  const summaries = [];
  for (const [id, list] of batches) {
    const roles = list.map((c) => c.role).filter(Boolean);
    // 종류: Batch-Kind: test-only를 단 plan 커밋 → 시험만, doc 커밋 → 문서, record만 → 기록만, 그 밖 → 코드
    const kind = list.some((c) => c.testOnly)
      ? '시험만'
      : roles.includes('doc')
        ? '문서'
        : roles.length > 0 && roles.every((r) => r === 'record')
          ? '기록만'
          : '코드';
    const count = (r) => list.filter((c) => c.role === r).length;
    summaries.push(`묶음 ${id}: ${kind} 커밋 ${list.length}개(${ROLES.map((r) => `${r} ${count(r)}`).join('·')})`);
    if (kind === '기록만') continue;

    // review·verify 커밋은 그 묶음 계획 파일의 자기 절('리뷰'·'검증')을 첫 부모보다 바꿔야 센다(계획 W7-L1-roles-testonly 8).
    // 세지 않는 커밋은 구성·차례에서 없는 것으로 보고, 세션·담당 표에서는 그 역할로 센다
    const planPath = `docs/review/plans/${id}.md`;
    const own = { review: '리뷰', verify: '검증' };
    const blobAt = (rev) => {
      const r = run(['cat-file', 'blob', `${rev}:${planPath}`]);
      return r.status === 0 ? r.out.toString('utf8') : null;
    };
    for (const c of list) {
      const name = own[c.role];
      if (!name || (kind === '문서' && c.role !== 'review')) continue;
      let changed = false;
      if (c.files.includes(planPath)) {
        const now = blobAt(c.sha);
        const mine = now === null ? null : sectionText(now, name);
        const old = c.parents.length ? blobAt(c.parents[0]) : null;
        const theirs = old === null ? null : sectionText(old, name);
        changed = mine !== null && (theirs === null ? mine !== '' : mine !== theirs);
      }
      if (!changed) {
        c.uncounted = true;
        fail('구성', id, c.sha, `${c.role} 커밋이 계획 파일 '${name}' 절을 바꾸지 않았다(${planPath}, 첫 부모와 견줌)`);
      }
    }
    const counted = list.filter((c) => !c.uncounted);

    const first = new Map();
    for (const c of counted) if (c.role && !first.has(c.role)) first.set(c.role, c);
    // 차례: 역할마다 처음 나온 커밋이 그보다 앞서야 할 역할의 첫 커밋보다 먼저 오면 그 먼저 나온 커밋의 실패다.
    // 리뷰와 검증 사이의 차례는 보지 않는다(계획 W7-L1-roles-testonly 7의 4)
    const order = kind === '코드' ? CODE_ORDER : kind === '시험만' ? TEST_ONLY_ORDER : DOC_ORDER;
    const before = kind === '문서' ? DOC_BEFORE : kind === '시험만' ? TEST_ONLY_BEFORE : CODE_BEFORE;
    for (const r of order) {
      const c = first.get(r);
      if (!c) continue;
      const later = (before[r] ?? []).filter((q) => first.has(q) && first.get(q).index > c.index);
      if (later.length) fail('차례', id, c.sha, `첫 ${r} 커밋이 첫 ${later.join('·')} 커밋보다 먼저 왔다`);
    }
    // 마지막 verify는 마지막 고침보다 뒤다(계획 W7-L1-roles-testonly 7의 1·2·5). 코드 묶음은 .md만 바꾸지 않은 구현 쪽 커밋,
    // 시험만 묶음은 시험 파일을 바꾼 시험 쪽 커밋이 고침이다. verify가 아예 없으면 [구성]이 잡는다
    if (kind !== '문서') {
      const fixes = kind === '코드'
        ? list.filter((c) => c.acting === 'impl' && !c.files.every((p) => p.endsWith('.md')))
        : list.filter((c) => c.acting === 'test' && c.files.some(isTestPath));
      const verifies = counted.filter((c) => c.role === 'verify');
      const lastFix = fixes.at(-1);
      if (lastFix && verifies.length && verifies.at(-1).index < lastFix.index) {
        fail('차례', id, lastFix.sha, kind === '코드' ? '마지막 코드 고침 커밋 뒤에 verify 커밋이 없다' : '시험 파일을 고친 마지막 시험 쪽 커밋 뒤에 verify 커밋이 없다');
      }
    }
    if (kind !== '문서' && first.has('review-fix')) {
      const fix = first.get('review-fix');
      const gate = ['review', 'verify'].filter((q) => first.has(q)).map((q) => first.get(q));
      if (gate.length && fix.index < Math.min(...gate.map((c) => c.index))) {
        fail('차례', id, fix.sha, `첫 review-fix 커밋이 첫 ${gate.map((c) => c.role).join('·')} 커밋보다 먼저 왔다`);
      }
    }

    // 리뷰 반영은 지적마다 시험 먼저: Fix-By: impl 커밋의 Finding마다 앞에 같은 값의 Fix-By: test 커밋이 같은 묶음에 있다.
    // 바꾼 파일이 모두 .md인 Fix-By: impl 커밋만 예외다
    const tested = new Set();
    for (const c of list) {
      if (c.acting === 'test' && c.role === 'review-fix') for (const f of c.findings) tested.add(f);
      if (c.acting !== 'impl' || c.role !== 'review-fix' || c.files.every((p) => p.endsWith('.md'))) continue;
      const untested = c.findings.filter((f) => !tested.has(f));
      if (untested.length) fail('차례', id, c.sha, `지적 ${untested.join('·')}의 Fix-By: impl 커밋 앞에 같은 묶음의 Fix-By: test 커밋이 없다(리뷰 반영도 시험 먼저)`);
    }

    // 구성
    const missing = order.filter((r) => !first.has(r));
    if (missing.length) fail('구성', id, null, `${kind} 묶음에 ${missing.join('·')} 커밋이 없다`);
    if (kind === '시험만') {
      const extra = [...new Set(list.filter((c) => c.role === 'impl' || c.role === 'doc' || (c.role === 'review-fix' && c.fixBy === 'impl')).map((c) => (c.role === 'review-fix' ? 'Fix-By: impl' : c.role)))];
      if (extra.length) fail('구성', id, null, `시험만 묶음에 ${extra.join('·')} 커밋이 섞였다(구현이 있으면 Batch-Kind를 빼고 코드 묶음으로 한다)`);
      // 시험 쪽 커밋(test, Fix-By: test)은 시험 파일과 문서 경로만 바꾼다
      for (const c of list.filter((x) => x.acting === 'test')) {
        for (const p of c.files.filter((f) => !isTestPath(f) && !isDocPath(f))) {
          fail('코드 경로', id, c.sha, `시험만 묶음의 시험 쪽 커밋이 시험 파일·문서 밖 경로 ${p}를 바꿨다`);
        }
      }
    }
    if (kind === '문서') {
      const extra = ['test', 'impl', 'review-fix', 'verify'].filter((r) => first.has(r));
      if (extra.length) fail('구성', id, null, `문서 묶음에 ${extra.join('·')} 커밋이 섞였다`);
    }

    // 계획 파일(머리 커밋의 것)
    const path = `docs/review/plans/${id}.md`;
    const blob = run(['cat-file', 'blob', `${head}:${path}`]);
    if (blob.status !== 0) {
      fail('계획 파일', id, null, `머리 커밋에 ${path}가 없다`);
      continue;
    }
    const lines = blob.out.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    const hs = headings(lines);
    let tableRange = null;
    for (const name of kind === '문서' ? DOC_SECTIONS : CODE_SECTIONS) {
      const found = sections(lines, hs, name);
      if (found.length === 0) fail('계획 파일', id, null, `${path}에 '${name}' 절(## 또는 ###)이 없다`);
      else if (!found.some((r) => sectionFilled(lines, hs, r))) fail('계획 파일', id, null, `${path}의 '${name}' 절이 비었다`);
      if (name === '담당 표' && found.length) tableRange = found[0];
    }

    // 담당 표
    if (!tableRange) continue;
    const table = readTable(lines, tableRange);
    for (const p of table.problems) fail('담당 표', id, null, p);
    if (table.problems.length && table.pairs.length === 0) continue;
    const seen = new Set();
    for (const c of list) {
      if (!c.session || !c.acting || c.acting === 'record') continue;
      const key = `${c.acting} ${c.session}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!table.pairs.includes(key)) fail('담당 표', id, null, `커밋의 역할 ${c.acting}·세션 ${c.session}가 담당 표에 없다`);
    }
  }

  return { fails, summaries, batches: batches.size, commits: commits.length };
}

function main(argv) {
  let result;
  try {
    result = check(parseArgs(argv));
  } catch (e) {
    console.log(errorLine(e instanceof RunError ? e.message : `실행하지 못했다: ${e.message}`));
    return 2;
  }
  const out = [...result.summaries, ...result.fails.map((f) => (gh ? `::error::${escape(f)}` : `실패: ${escape(f)}`))];
  if (result.fails.length === 0) out.push(`통과: 묶음 ${result.batches}개, 커밋 ${result.commits}개`);
  console.log(out.join('\n'));
  return result.fails.length ? 1 : 0;
}

await runIfMain(import.meta.url, () => main(process.argv.slice(2)));
