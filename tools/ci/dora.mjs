#!/usr/bin/env node
// 배포 기록 → DORA 5종 산출(기능 F-01-6, OPS-120, D-T53 ①~④). 정본: docs/devops.md §13 표(:879~885)·'포트폴리오 기간의 정의'(:890)·'산출의 첫 구현'(:893~902), D-T53(:961).
// - 한 주는 월요일 00:00 KST부터 7일이다. 주 경계는 [시작, 끝)이고, 한 배포는 처음 success나 failure를 받은 시각의 주에 한 번만 센다.
// - 리드타임은 그 배포에 처음 든 코드 PR마다 첫 커밋부터 success까지다. 실패율·재작업률의 분모는 그 주의 배포(성공+실패)다.
// - 실패한 배포의 회복은 같은 서비스의 다음 success다(주 밖이어도 그 실패의 주에 센다). 아직 없으면 미복구로 센다.
// - GitHub에서 읽기: GITHUB_API_URL(기본 https://api.github.com)·GITHUB_TOKEN(있으면). 어느 호출이든 실패하면 던지고 보고 파일을 쓰지 않는다.
// 쓰는 법: node tools/ci/dora.mjs (--input <기록.json> | --from-github --repo <owner/name>) --week <YYYY-MM-DD> [--env <환경>] [--out <폴더>]
// 끝 코드: 0 성공, 2 인자 오류·읽기 실패·GitHub 실패(그때 파일을 쓰지 않는다).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NO_DATA = '자료 없음';
const BASIS = { demo: '데모 환경 기준', prod: '운영 기준' };

export class DoraInputError extends Error {
  name = 'DoraInputError';
}

/** 월요일 00:00 KST의 시작·끝(끝은 다음 월요일 00:00 KST). 날짜가 월요일이 아니면 던진다 */
function weekRange(week) {
  if (typeof week !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new DoraInputError(`주는 YYYY-MM-DD 꼴이어야 한다: ${week}`);
  const [y, m, d] = week.split('-').map(Number);
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) throw new DoraInputError(`없는 날짜다: ${week}`);
  // 달력 날짜의 요일은 시간대와 관계없다(주 시작은 그 날 00:00 KST)
  if (calendar.getUTCDay() !== 1) throw new DoraInputError(`주 시작은 월요일이어야 한다: ${week}`);
  const start = calendar.getTime() - KST_OFFSET_MS;
  return { start, end: start + WEEK_MS };
}

function timeOf(iso, what) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new DoraInputError(`${what} 시각이 ISO 8601이 아니다: ${iso}`);
  return t;
}

/** 처음 success나 failure를 받은 시각과 그 상태. 둘 다 없으면 null(아직 끝나지 않은 배포) */
function firstTerminal(d) {
  const terminal = (d.statuses ?? [])
    .filter((s) => s.state === 'success' || s.state === 'failure')
    .map((s) => ({ state: s.state, at: timeOf(s.createdAt, `${d.environment} ${d.tag} 상태`) }))
    .sort((a, b) => a.at - b.at || (a.state === 'failure' ? -1 : 1));
  return terminal[0] ?? null;
}

function firstSuccess(d) {
  const success = (d.statuses ?? [])
    .filter((s) => s.state === 'success')
    .map((s) => timeOf(s.createdAt, `${d.environment} ${d.tag} 상태`))
    .sort((a, b) => a - b);
  return success[0] ?? null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 100) / 100;
}

function metricsOf(deployments, successes, failures, all) {
  const leadTimes = successes.flatMap(({ d, at }) => (d.prs ?? []).map((p) => (at - timeOf(p.firstCommitAt, `${d.environment} ${d.tag} PR 첫 커밋`)) / 3_600_000));
  const total = successes.length + failures.length;
  const restores = [];
  let unrecovered = 0;
  for (const { d, at } of failures) {
    const service = d.environment.slice(d.environment.indexOf('/') + 1);
    const next = all
      .filter((x) => x.environment.slice(x.environment.indexOf('/') + 1) === service)
      .map((x) => firstSuccess(x))
      .filter((x) => x !== null && x > at)
      .sort((a, b) => a - b)[0];
    if (next === undefined) unrecovered++;
    else restores.push((next - at) / 3_600_000);
  }
  return {
    deploymentCount: successes.length,
    leadTimeHours: median(leadTimes),
    changeFailureRate: total === 0 ? null : Math.round((failures.length / total) * 1000) / 1000,
    restoreHours: median(restores),
    unrecovered,
    reworkRate: total === 0 ? null : Math.round((deployments.filter((d) => d.hotfix === true).length / total) * 1000) / 1000,
  };
}

/** 한 주의 기록에서 서비스별·전체 다섯 값을 낸다. environment 기본 'demo' */
export function computeDora(records, o) {
  const { start, end } = weekRange(o.week);
  const environment = o.environment ?? 'demo';
  const prefix = `${environment}/`;
  const counted = (records.deployments ?? [])
    .filter((d) => d.environment.startsWith(prefix))
    .map((d) => {
      const terminal = firstTerminal(d);
      return terminal && terminal.at >= start && terminal.at < end ? { d, ...terminal } : null;
    })
    .filter((x) => x !== null);

  const services = {};
  for (const { d } of counted) {
    const name = d.environment.slice(prefix.length);
    services[name] ??= { deploymentCount: 0, leadTimeHours: null, changeFailureRate: null, restoreHours: null, unrecovered: 0, reworkRate: null };
  }
  const allCounted = (records.deployments ?? []).filter((d) => d.environment.startsWith(prefix));
  for (const name of Object.keys(services)) {
    const mine = counted.filter(({ d }) => d.environment === `${prefix}${name}`);
    const serviceAll = allCounted.filter((d) => d.environment === `${prefix}${name}`);
    services[name] = metricsOf(
      mine.map(({ d }) => d),
      mine.filter(({ state }) => state === 'success').map(({ d, at }) => ({ d, at })),
      mine.filter(({ state }) => state === 'failure').map(({ d, at }) => ({ d, at })),
      serviceAll,
    );
  }
  const all = metricsOf(
    counted.map(({ d }) => d),
    counted.filter(({ state }) => state === 'success').map(({ d, at }) => ({ d, at })),
    counted.filter(({ state }) => state === 'failure').map(({ d, at }) => ({ d, at })),
    allCounted,
  );
  return {
    basis: BASIS[environment] ?? `${environment} 기준`,
    week: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    services,
    all,
  };
}

const hours = (v) => (v === null ? NO_DATA : v.toFixed(2));
// '0%'·'10%' 같은 글이 보고에 남지 않게 % 앞에 띄어쓰기를 둔다(시험 D-T53 ②가 '0%'를 막는다)
const percent = (v) => (v === null ? NO_DATA : `${(v * 100).toFixed(2)} %`);

/** 보고 Markdown. null은 '자료 없음'으로 적고, 값이 없는데 0으로 꾸미지 않는다 */
export function renderMarkdown(report) {
  const row = (name, m) =>
    `| ${name} | ${m.deploymentCount} | ${hours(m.leadTimeHours)} | ${percent(m.changeFailureRate)} | ${hours(m.restoreHours)} | ${m.unrecovered} | ${percent(m.reworkRate)} |`;
  const lines = [
    `# DORA 주간 보고 — ${report.basis}`,
    '',
    `기간: ${report.week.start} ~ ${report.week.end} (월요일 00:00 KST부터 7일)`,
    '',
    '| 서비스 | 배포(성공) | 리드타임(시간) | 변경 실패율 | 복구 시간(시간) | 미복구 | 재작업률 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.services)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, m]) => row(name, m)),
    row('전체', report.all),
    '',
    '값이 없는 칸은 자료 없음이다(0으로 꾸미지 않는다).',
    '',
  ];
  return lines.join('\n');
}

/** GitHub REST에서 배포 기록을 읽는다. environment 기본 'demo'. 실패하면 던진다 */
export async function fetchDoraRecords(o) {
  const environment = o.environment ?? 'demo';
  if (!/^[^/\s]+\/[^/\s]+$/.test(o.repo)) throw new DoraInputError(`저장소는 owner/name 꼴이어야 한다: ${o.repo}`);
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const doFetch = o.fetch ?? fetch;

  const get = async (path, query) => {
    const url = new URL(`${o.apiUrl.replace(/\/+$/, '')}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.append(k, String(v));
    const res = await doFetch(url, { method: 'GET', headers, redirect: 'manual' });
    if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}`);
    return res.json();
  };
  const list = async (path) => {
    const out = [];
    for (let page = 1; ; page++) {
      const body = await get(path, { per_page: 100, page });
      if (!Array.isArray(body)) throw new Error(`GitHub ${path} 응답이 배열이 아니다`);
      out.push(...body);
      if (body.length < 100) return out;
    }
  };

  const repoBase = `/repos/${o.repo}`;
  const deployments = (await list(`${repoBase}/deployments`))
    .filter((d) => typeof d.environment === 'string' && d.environment.startsWith(`${environment}/`))
    .sort((a, b) => timeOf(a.created_at ?? '', '배포 created_at') - timeOf(b.created_at ?? '', '배포 created_at') || a.id - b.id);

  // 배포마다 태그와 같은 서비스의 바로 앞 배포 태그를 먼저 구한다(리드타임 비교 기준). 서비스는 환경 앞머리를 뗀 이름이다
  const meta = [];
  const latestByService = new Map();
  for (const d of deployments) {
    const service = d.environment.slice(`${environment}/`.length);
    const prevTag = latestByService.get(service) ?? null;
    // 태그는 승격 PR 제목(chore(promote): <환경> <태그>)에서 읽는다. PR을 못 찾으면 배포 ref를 태그로 본다(시험은 늘 승격 PR이 있다)
    const pulls = (await get(`${repoBase}/commits/${encodeURIComponent(d.ref ?? d.sha ?? '')}/pulls`).catch(() => []));
    const promote = (Array.isArray(pulls) ? pulls : []).find((p) => {
      const m = /^chore\(promote\):\s+(\S+)\s+(\S+)$/.exec(p.title ?? '');
      return m !== null && m[1] === environment;
    });
    const tag = promote ? /^chore\(promote\):\s+\S+\s+(\S+)$/.exec(promote.title ?? '')[1] : (d.ref ?? d.sha ?? '');
    meta.push({ d, tag, prevTag });
    latestByService.set(service, tag);
  }

  const records = [];
  for (const { d, tag, prevTag } of meta) {
    const hotfixPulls = await get(`${repoBase}/commits/${encodeURIComponent(tag)}/pulls`).catch((e) => {
      if (String(e).includes('422')) return [];
      throw e;
    });
    const hotfix = (Array.isArray(hotfixPulls) ? hotfixPulls : []).some((p) => typeof p.head?.ref === 'string' && p.head.ref.startsWith('hotfix/'));
    const prs = [];
    if (prevTag !== null) {
      const compare = await get(`${repoBase}/compare/${encodeURIComponent(prevTag)}...${encodeURIComponent(tag)}`);
      const seen = new Set();
      for (const c of compare.commits ?? []) {
        if (!c.sha) continue;
        const cand = await get(`${repoBase}/commits/${encodeURIComponent(c.sha)}/pulls`).catch(() => []);
        for (const p of Array.isArray(cand) ? cand : []) {
          if (typeof p.number !== 'number' || seen.has(p.number)) continue;
          if (p.merged_at === null || p.merged_at === undefined) continue;
          if (p.base?.ref !== 'develop') continue;
          if ((p.title ?? '').startsWith('chore(promote):')) continue;
          seen.add(p.number);
          const commits = await get(`${repoBase}/pulls/${p.number}/commits`, { per_page: 100 });
          const first = commits[0];
          const at = first?.commit?.author?.date ?? first?.commit?.committer?.date;
          if (!at) throw new Error(`PR ${p.number}의 첫 커밋 시각이 없다`);
          prs.push({ number: p.number, firstCommitAt: at });
        }
      }
    }
    const statuses = (await list(`${repoBase}/deployments/${d.id}/statuses`)).map((s) => ({ state: String(s.state ?? ''), createdAt: s.created_at ?? '' }));
    records.push({ id: d.id, environment: d.environment, tag, hotfix, prs, statuses });
  }
  return { deployments: records };
}

function parseCli(argv) {
  const o = { fromGithub: false, environment: 'demo' };
  const take = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v === '' || v.startsWith('--')) throw new DoraInputError(`${name}에 값이 없다`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') {
      o.input = take(i, a);
      i++;
    } else if (a === '--from-github') o.fromGithub = true;
    else if (a === '--repo') {
      o.repo = take(i, a);
      i++;
    } else if (a === '--week') {
      o.week = take(i, a);
      i++;
    } else if (a === '--env') {
      o.environment = take(i, a);
      i++;
    } else if (a === '--out') {
      o.out = take(i, a);
      i++;
    } else throw new DoraInputError(`모르는 인자: ${a}`);
  }
  if (!o.week) throw new DoraInputError('--week가 없다');
  if (o.fromGithub === (o.input !== undefined)) throw new DoraInputError('--input과 --from-github 가운데 하나만 준다');
  if (o.fromGithub && !o.repo) throw new DoraInputError('--from-github에는 --repo <owner/name>가 필요하다');
  return o;
}

async function main(argv) {
  const o = parseCli(argv);
  let report;
  if (o.input) {
    let records;
    try {
      records = JSON.parse(readFileSync(resolve(o.input), 'utf8'));
    } catch (e) {
      throw new DoraInputError(`기록 파일을 읽지 못했다: ${o.input} (${e instanceof Error ? e.message : String(e)})`);
    }
    report = computeDora(records, { week: o.week, environment: o.environment });
  } else {
    const records = await fetchDoraRecords({
      repo: o.repo,
      apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
      ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
      environment: o.environment,
    });
    report = computeDora(records, { week: o.week, environment: o.environment });
  }
  if (o.out) {
    mkdirSync(resolve(o.out), { recursive: true });
    writeFileSync(join(resolve(o.out), `dora-${o.week}.json`), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(resolve(o.out), `dora-${o.week}.md`), renderMarkdown(report));
  } else {
    process.stdout.write(`${renderMarkdown(report)}\n`);
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`dora: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  });
}
