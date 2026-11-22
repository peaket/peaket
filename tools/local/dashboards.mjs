#!/usr/bin/env node
// 템플릿 대시보드 생성기(Dashboards as Code, docs/observability.md §3 '템플릿 대시보드'·'대상·폴더·조직', wbs 1.3.1·4.1.2, ADR-0356 결정 1).
// 서비스마다 같은 모양의 Grafana 대시보드 JSON을 만든다. 첫 행은 네 신호(지연·트래픽·오류·포화도)이고, 서비스 템플릿이 내는
// 지표(packages/platform/src/metrics.ts)만 쓴다.
// - 대상: docs/architecture.md §3.1 서비스 맵 표의 업무 서비스 전부와 EXTRA_SERVICES(목록을 손으로 적지 않고 표를 읽는다)
// - 폴더: .github/CODEOWNERS가 정한 주인 팀(그 서비스 폴더에 맞는 가장 아래 줄). EXTRA_SERVICES는 '/services/' 기본 줄의 팀
// - 온세일 공용 대시보드 하나(ONSALE_FOLDER 폴더): 서비스를 고르는 네 신호와 주석 셋(배포·장애 주입·운영 사건 줄 ops_event)
// 파일은 deploy/local/dashboards/<폴더>/<이름>.json에 두고, Grafana 공급자(deploy/platform/observability/grafana/provisioning/dashboards.yaml)가
// 폴더마다 싣는다(화면에서 고친 것은 저장하지 않는다).
// 쓰는 법(저장소 뿌리에서):
//   node tools/local/dashboards.mjs            파일을 다시 쓴다(대상에 없는 파일은 지운다)
//   node tools/local/dashboards.mjs --check    다시 만든 결과가 커밋된 파일과 같은지 본다
//   [--dir <폴더>]                             기본 <저장소>/deploy/local/dashboards
//   [--root <저장소>]                          대상·폴더를 읽을 저장소(기본 이 파일의 두 단계 위). 시험이 임시 저장소를 넘긴다
// 끝 코드: 0 같음(쓰기 성공), 1 다름·빠짐·남음, 2 원천(§3.1 표·CODEOWNERS) 읽기 실패·인자 오류
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASHBOARDS_REL = join('deploy', 'local', 'dashboards');

/** §3.1 표에 없지만 대시보드를 두는 배포 단위: 서비스 템플릿 예시(example-svc)와 비교 기준(v0-monolith) */
export const EXTRA_SERVICES = ['example-svc', 'v0-monolith'];
/** 온세일 공용 대시보드 폴더(Grafana 폴더 uid와 같다. 제목 '온세일 공용'은 deploy/platform/observability/grafana/access.yaml) */
export const ONSALE_FOLDER = 'onsale';
/** 온세일 공용 대시보드 파일 이름(확장자 뺌)과 uid */
export const ONSALE_DASHBOARD = { name: 'onsale', uid: 'peaket-onsale' };

const DS = { type: 'prometheus', uid: 'prometheus' };
/** 주석 데이터 소스(Loki, uid loki). 로컬에는 없어 실제 표시는 구간 5(INF-040)에서 본다(ADR-0356 결정 1) */
const LOKI = { type: 'loki', uid: 'loki' };
// 집계 창은 Grafana가 수집 간격과 점 간격에 맞춰 정하는 $__rate_interval(넓은 시간 범위에서도 표본을 건너뛰지 않는다)
const RANGE = '[$__rate_interval]';
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,27}$/;

/** 원천 읽기 실패(끝 코드 2) */
export class DashboardSourceError extends Error {}

/** docs/architecture.md §3.1 서비스 맵 표의 첫 칸(서비스 이름), 표 차례 그대로. 표를 찾지 못하거나 비면 던진다 */
export function serviceMapNames(repoRoot) {
  const file = join(repoRoot, 'docs', 'architecture.md');
  if (!existsSync(file)) throw new DashboardSourceError(`${file}이 없다`);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const head = lines.findIndex((l) => /^###\s+3\.1\s/.test(l));
  if (head < 0) throw new DashboardSourceError('docs/architecture.md에 §3.1 제목이 없다');
  const names = [];
  let inTable = false;
  for (let i = head + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,3}\s/.test(l)) break;
    if (!inTable) {
      if (/^\|\s*서비스명\s*\|/.test(l)) inTable = true;
      continue;
    }
    // 표가 끝나면(| 로 시작하지 않는 줄) 멈춘다. 마지막 줄까지 읽는다
    if (!l.startsWith('|')) break;
    const first = (l.split('|')[1] ?? '').trim().replace(/`/g, '');
    if (first === '' || /^:?-+:?$/.test(first)) continue;
    if (!SERVICE_NAME.test(first)) throw new DashboardSourceError(`docs/architecture.md:${i + 1}: 서비스 맵 표의 첫 칸이 서비스 이름이 아니다: ${first}`);
    names.push(first);
  }
  if (!inTable) throw new DashboardSourceError('docs/architecture.md §3.1에 서비스 맵 표(첫 칸 서비스명)가 없다');
  if (names.length === 0) throw new DashboardSourceError('docs/architecture.md §3.1 서비스 맵 표에 서비스가 없다');
  return names;
}

/** CODEOWNERS 줄: [{ pattern, owners }] (파일 차례 그대로) */
function codeownersLines(repoRoot) {
  const file = join(repoRoot, '.github', 'CODEOWNERS');
  if (!existsSync(file)) throw new DashboardSourceError(`${file}이 없다`);
  const out = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, '').trim();
    if (!l) continue;
    const [pattern, ...owners] = l.split(/\s+/);
    out.push({ pattern, owners });
  }
  return out;
}

/** 패턴이 폴더 경로(앞뒤 /)에 맞는가. CODEOWNERS의 '*'와 '/<폴더>/' 꼴만 다룬다(지금 파일이 쓰는 꼴) */
const matches = (pattern, path) => pattern === '*' || (pattern.endsWith('/') && path.startsWith(pattern.startsWith('/') ? pattern : `/${pattern}`));

const teamOf = (line, what) => {
  if (!line) throw new DashboardSourceError(`CODEOWNERS에 ${what}에 맞는 줄이 없다`);
  if (line.owners.length !== 1 || !/^@peaket\/[a-z0-9-]+$/.test(line.owners[0])) {
    throw new DashboardSourceError(`CODEOWNERS ${line.pattern} 줄의 주인이 팀 하나(@peaket/<팀>)가 아니다: ${line.owners.join(' ') || '없음'} (${what})`);
  }
  return line.owners[0].slice('@peaket/'.length);
};

/**
 * 대시보드 대상과 폴더(주인 팀 slug): §3.1 표의 서비스마다 CODEOWNERS에서 '/services/<서비스>/'에 맞는 가장 아래 줄의 팀,
 * EXTRA_SERVICES는 '/services/' 줄의 팀. 원천을 읽지 못하거나 팀이 하나로 정해지지 않으면 던진다
 * @returns {{ service: string, folder: string }[]}
 */
export function dashboardTargets(repoRoot) {
  const owners = codeownersLines(repoRoot);
  const targets = serviceMapNames(repoRoot).map((service) => {
    const path = `/services/${service}/`;
    return { service, folder: teamOf(owners.filter((o) => matches(o.pattern, path)).at(-1), path) };
  });
  const base = owners.filter((o) => o.pattern === '/services/').at(-1);
  for (const service of EXTRA_SERVICES) {
    if (!targets.some((t) => t.service === service)) targets.push({ service, folder: teamOf(base, "'/services/' 기본 줄") });
  }
  return targets;
}

function panel(id, title, gridPos, targets, unit, extra = {}) {
  return {
    id,
    type: 'timeseries',
    title,
    datasource: DS,
    gridPos,
    fieldConfig: { defaults: { unit }, overrides: [] },
    options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    targets: targets.map(([expr, legendFormat], i) => ({ refId: String.fromCharCode(65 + i), datasource: DS, expr, legendFormat })),
    ...extra,
  };
}

/** 첫 행 네 신호와 경로별 표. sel은 서비스 지표 고르기, app은 Node 기본 지표(수집 대상 라벨 app) 고르기 */
function signalPanels(sel, app) {
  const bucket = (status) => `sum by (le) (rate(http_server_request_duration_seconds_bucket{${sel}, status_class${status}}${RANGE}))`;
  const q = (p, status) => `histogram_quantile(${p}, ${bucket(status)})`;
  const total = `sum(rate(http_server_request_duration_seconds_count{${sel}}${RANGE}))`;
  let id = 0;
  const next = () => ++id;
  const row = (title, y) => ({ id: next(), type: 'row', title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] });
  return [
    row('네 신호', 0),
    // 지연: 성공(5xx가 아닌 응답)과 실패(5xx)를 나눈 p50·p99·p99.9(docs/observability.md §2 '레이턴시 히스토그램')
    panel(next(), '지연', { h: 8, w: 6, x: 0, y: 1 }, [
      [q('0.5', '!="5xx"'), '성공 p50'],
      [q('0.99', '!="5xx"'), '성공 p99'],
      [q('0.999', '!="5xx"'), '성공 p99.9'],
      [q('0.5', '="5xx"'), '실패 p50'],
      [q('0.99', '="5xx"'), '실패 p99'],
      [q('0.999', '="5xx"'), '실패 p99.9'],
    ], 's'),
    panel(next(), '트래픽', { h: 8, w: 6, x: 6, y: 1 }, [
      [`sum by (route) (rate(http_server_request_duration_seconds_count{${sel}}${RANGE}))`, '{{route}}'],
    ], 'reqps'),
    // 오류: 5xx 비율과, 그와 따로 센 정상 분기 거절 비율(좌석 경합 409 등, docs/api/guidelines.md §2)
    // 라벨 있는 카운터는 처음 오를 때까지 시계열이 없어 분자가 비면 식 전체가 빈다('No data'). 트래픽이 있으면 0으로 메운다
    panel(next(), '오류', { h: 8, w: 6, x: 12, y: 1 }, [
      [`(sum(rate(http_server_errors_total{${sel}}${RANGE})) or 0 * ${total}) / ${total}`, '5xx 비율'],
      [`(sum(rate(http_server_business_rejections_total{${sel}}${RANGE})) or 0 * ${total}) / ${total}`, '정상 분기 거절 비율'],
    ], 'percentunit'),
    // 포화도: 처리 중 요청 수(ADR-0077)와 이벤트 루프 지연 p99(Node 기본 지표는 service 라벨이 없어 수집 대상 라벨 app으로 고른다)
    panel(next(), '포화도', { h: 8, w: 6, x: 18, y: 1 }, [
      [`sum by (route) (http_server_active_requests{${sel}})`, '처리 중 {{route}}'],
      [`max by (pod) (nodejs_eventloop_lag_p99_seconds{${app}})`, '이벤트 루프 지연 p99 {{pod}}'],
    ], 'short', {
      // 처리 중 요청 수(개)와 지연(초)은 단위가 달라 지연 선을 오른쪽 축에 초로 그린다
      fieldConfig: {
        defaults: { unit: 'short' },
        overrides: [{ matcher: { id: 'byRegexp', options: '이벤트 루프 지연.*' }, properties: [{ id: 'unit', value: 's' }, { id: 'custom.axisPlacement', value: 'right' }] }],
      },
    }),
    row('경로별', 9),
    {
      id: next(),
      type: 'table',
      title: '경로·응답 종류별 p99와 요청 수(최근 5분)',
      datasource: DS,
      gridPos: { h: 10, w: 24, x: 0, y: 10 },
      targets: [
        { refId: 'A', datasource: DS, format: 'table', instant: true, legendFormat: 'p99',
          expr: `histogram_quantile(0.99, sum by (le, route, status_class) (rate(http_server_request_duration_seconds_bucket{${sel}}[5m])))` },
        { refId: 'B', datasource: DS, format: 'table', instant: true, legendFormat: '요청 수',
          expr: `sum by (route, status_class) (increase(http_server_request_duration_seconds_count{${sel}}[5m]))` },
      ],
      transformations: [
        { id: 'merge', options: {} },
        { id: 'organize', options: { excludeByName: { Time: true }, renameByName: { 'Value #A': 'p99(초)', 'Value #B': '요청 수(5분)' } } },
      ],
    },
  ];
}

const routeVariable = (serviceSel) => ({
  name: 'route',
  label: '경로',
  type: 'query',
  datasource: DS,
  query: { query: `label_values(http_server_request_duration_seconds_count{${serviceSel}}, route)`, refId: 'route' },
  includeAll: true,
  multi: true,
  allValue: '.*',
  current: { text: 'All', value: '$__all' },
  refresh: 2,
  sort: 1,
});

/** 서비스 하나의 대시보드. 같은 입력이면 같은 JSON이다(--check가 견준다) */
export function serviceDashboard(service) {
  // uid `peaket-svc-<서비스>`가 Grafana 한도 40자 안에 들도록 서비스 이름은 28자까지
  if (!SERVICE_NAME.test(service)) throw new Error(`서비스 이름이 아니다(소문자·숫자·-, 28자까지): ${service}`);
  return {
    uid: `peaket-svc-${service}`,
    title: `서비스: ${service}`,
    description: '서비스 템플릿이 내는 지표의 템플릿 대시보드. tools/local/dashboards.mjs가 만든다(손으로 고치지 않는다)',
    tags: ['peaket', 'service-template'],
    editable: false,
    schemaVersion: 39,
    time: { from: 'now-30m', to: 'now' },
    refresh: '10s',
    templating: { list: [routeVariable(`service="${service}"`)] },
    panels: signalPanels(`service="${service}", route=~"$route"`, `app="${service}"`),
  };
}

/** 온세일 공용 대시보드의 주석 이름(주석 셋, observability §2 '대시보드 거버넌스') */
export const ONSALE_ANNOTATIONS = ['배포', '장애 주입', '운영 사건'];

/**
 * 온세일 공용 대시보드(observability §2 '대시보드 거버넌스'). 첫 행은 고른 서비스의 네 신호이고, 주석 셋을 Loki 조회로 그린다:
 * 배포(정형 로그 줄 kind deploy), 장애 주입(kind chaos), 운영 사건 줄(ops-svc의 kind ops_event, §7 '운영 사건 줄').
 * 배포·장애 주입 줄을 누가 남기는지는 구간 5(INF-040)에서 정한다 [가정]. 같은 입력이면 같은 JSON이다
 * @param {string[]} services 고를 서비스(대상 차례 그대로)
 */
export function onsaleDashboard(services) {
  if (!Array.isArray(services) || services.length === 0) throw new Error('온세일 공용 대시보드에 고를 서비스가 없다');
  for (const s of services) if (!SERVICE_NAME.test(s)) throw new Error(`서비스 이름이 아니다: ${s}`);
  const annotation = (name, iconColor, expr, titleFormat, textFormat) => ({ name, datasource: LOKI, enable: true, iconColor, expr, titleFormat, textFormat, instant: false });
  const [deploy, chaos, ops] = ONSALE_ANNOTATIONS;
  return {
    uid: ONSALE_DASHBOARD.uid,
    title: '온세일 공용',
    description: '온세일 구간의 서비스 네 신호와 배포·장애 주입·운영 사건 주석. tools/local/dashboards.mjs가 만든다(손으로 고치지 않는다)',
    tags: ['peaket', 'onsale'],
    editable: false,
    schemaVersion: 39,
    time: { from: 'now-1h', to: 'now' },
    refresh: '10s',
    annotations: {
      list: [
        annotation(deploy, 'blue', '{service_name=~".+"} | json | kind="deploy"', '배포 {{service}}', '{{version}}'),
        annotation(chaos, 'red', '{service_name=~".+"} | json | kind="chaos"', '장애 주입 {{scenario}}', '{{target}}'),
        annotation(ops, 'orange', '{service_name="ops-svc"} | json | kind="ops_event"', '{{opsEvent}} {{stage}}', '회차 {{eventId}} · {{actorRole}}'),
      ],
    },
    templating: {
      list: [
        {
          name: 'service',
          label: '서비스',
          type: 'custom',
          query: services.join(','),
          options: services.map((s, i) => ({ text: s, value: s, selected: i === 0 })),
          current: { text: services[0], value: services[0] },
          includeAll: false,
          multi: true,
        },
        routeVariable('service=~"$service"'),
      ],
    },
    panels: signalPanels('service=~"$service", route=~"$route"', 'app=~"$service"'),
  };
}

const jsonText = (d) => `${JSON.stringify(d, null, 2)}\n`;
export const dashboardText = (service) => jsonText(serviceDashboard(service));

/** 저장소의 대시보드 파일 전부: [{ rel: '<폴더>/<이름>.json', folder, text }] */
export function dashboardFiles(repoRoot) {
  const targets = dashboardTargets(repoRoot);
  const files = targets.map((t) => ({ rel: `${t.folder}/${t.service}.json`, folder: t.folder, text: dashboardText(t.service) }));
  files.push({ rel: `${ONSALE_FOLDER}/${ONSALE_DASHBOARD.name}.json`, folder: ONSALE_FOLDER, text: jsonText(onsaleDashboard(targets.map((t) => t.service))) });
  return files;
}

/** 폴더 아래 .json 파일(하위 폴더 포함)의 '/'로 이은 상대 경로 */
export function jsonFilesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return out.sort();
}

function main(argv) {
  let check = false;
  let root = REPO;
  let dir;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--dir' && argv[i + 1]) dir = resolve(argv[++i]);
    else if (a === '--root' && argv[i + 1]) root = resolve(argv[++i]);
    else {
      console.error(`dashboards: 모르는 인자 ${a} (쓰는 법: node tools/local/dashboards.mjs [--check] [--dir <폴더>] [--root <저장소>])`);
      return 2;
    }
  }
  dir ??= join(root, DASHBOARDS_REL);
  let files;
  try {
    files = dashboardFiles(root);
  } catch (e) {
    if (e instanceof DashboardSourceError) {
      console.error(`dashboards: 원천을 읽지 못했다: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const want = new Set(files.map((f) => f.rel));
  // 대상에 없는 파일(지운 서비스·옮긴 폴더·폴더 밖 파일)이 남으면 Grafana에 실리므로 --check가 잡고, 쓰기는 지운다
  const stray = jsonFilesUnder(dir).filter((rel) => !want.has(rel));
  if (check) {
    let bad = 0;
    for (const rel of stray) {
      bad++;
      console.log(`대상에 없는 대시보드: ${join(dir, rel)} (docs/architecture.md §3.1 표에 없는 서비스이거나 CODEOWNERS의 팀 폴더가 아니다)`);
    }
    for (const f of files) {
      const file = join(dir, f.rel);
      if (!existsSync(file) || readFileSync(file, 'utf8') !== f.text) {
        bad++;
        console.log(`${existsSync(file) ? '다르다' : '없다'}: ${file} (node tools/local/dashboards.mjs로 다시 만든다)`);
      }
    }
    console.log(bad ? `대시보드 ${bad}개가 생성기와 다르다` : `대시보드 ${files.length}개가 생성기와 같다`);
    return bad ? 1 : 0;
  }
  for (const rel of stray) {
    rmSync(join(dir, rel));
    console.log(`지웠다: ${join(dir, rel)}`);
  }
  for (const f of files) {
    const file = join(dir, f.rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, f.text);
    console.log(`썼다: ${file}`);
  }
  // 비게 된 폴더를 지운다(공급자 경로와 어긋나지 않게)
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && jsonFilesUnder(join(dir, e.name)).length === 0) rmSync(join(dir, e.name), { recursive: true });
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
