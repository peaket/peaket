#!/usr/bin/env node
// 템플릿 대시보드 생성기(Dashboards as Code, docs/observability.md §3 '로컬 관측 최소와 템플릿 대시보드', wbs 1.3.1).
// 서비스마다 같은 모양의 Grafana 대시보드 JSON을 만든다. 첫 행은 네 신호(지연·트래픽·오류·포화도)이고, 서비스 템플릿이 내는
// 지표(packages/platform/src/metrics.ts)만 쓴다. 파일은 deploy/local/dashboards/<서비스>.json에 두고 Grafana가 시작할 때 읽는다.
// 쓰는 법(저장소 뿌리에서):
//   node tools/local/dashboards.mjs            파일을 다시 쓴다
//   node tools/local/dashboards.mjs --check    다시 만든 결과가 커밋된 파일과 같은지 본다(다르면 종료 1)
//   [--dir <폴더>]                             기본 deploy/local/dashboards
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DIR = join(REPO, 'deploy', 'local', 'dashboards');

/** 대시보드를 만들 서비스(서비스 템플릿의 `service` 라벨 = 차트의 `name`) */
export const DASHBOARD_SERVICES = ['example-svc', 'v0-monolith'];

const DS = { type: 'prometheus', uid: 'prometheus' };
// 집계 창은 Grafana가 수집 간격과 점 간격에 맞춰 정하는 $__rate_interval(넓은 시간 범위에서도 표본을 건너뛰지 않는다)
const RANGE = '[$__rate_interval]';

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

/** 서비스 하나의 대시보드. 같은 입력이면 같은 JSON이다(--check가 견준다) */
export function serviceDashboard(service) {
  // uid `peaket-svc-<서비스>`가 Grafana 한도 40자 안에 들도록 서비스 이름은 28자까지
  if (!/^[a-z][a-z0-9-]{0,27}$/.test(service)) throw new Error(`서비스 이름이 아니다(소문자·숫자·-, 28자까지): ${service}`);
  const sel = `service="${service}", route=~"$route"`;
  const bucket = (status) => `sum by (le) (rate(http_server_request_duration_seconds_bucket{${sel}, status_class${status}}${RANGE}))`;
  const q = (p, status) => `histogram_quantile(${p}, ${bucket(status)})`;
  const total = `sum(rate(http_server_request_duration_seconds_count{${sel}}${RANGE}))`;
  let id = 0;
  const next = () => ++id;
  const row = (title, y) => ({ id: next(), type: 'row', title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] });
  const panels = [
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
      [`max by (pod) (nodejs_eventloop_lag_p99_seconds{app="${service}"})`, '이벤트 루프 지연 p99 {{pod}}'],
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
  return {
    uid: `peaket-svc-${service}`,
    title: `서비스: ${service}`,
    description: '서비스 템플릿이 내는 지표의 템플릿 대시보드. tools/local/dashboards.mjs가 만든다(손으로 고치지 않는다)',
    tags: ['peaket', 'service-template'],
    editable: false,
    schemaVersion: 39,
    time: { from: 'now-30m', to: 'now' },
    refresh: '10s',
    templating: {
      list: [{
        name: 'route',
        label: '경로',
        type: 'query',
        datasource: DS,
        query: { query: `label_values(http_server_request_duration_seconds_count{service="${service}"}, route)`, refId: 'route' },
        includeAll: true,
        multi: true,
        allValue: '.*',
        current: { text: 'All', value: '$__all' },
        refresh: 2,
        sort: 1,
      }],
    },
    panels,
  };
}

export const dashboardText = (service) => `${JSON.stringify(serviceDashboard(service), null, 2)}\n`;

function main(argv) {
  const check = argv.includes('--check');
  const di = argv.indexOf('--dir');
  const dir = di >= 0 ? resolve(argv[di + 1]) : DEFAULT_DIR;
  let bad = 0;
  if (!check) mkdirSync(dir, { recursive: true });
  // 목록에 없는 서비스의 파일(지운 서비스)이 남으면 Grafana에 실리므로 --check가 잡는다
  const known = new Set(DASHBOARD_SERVICES.map((s) => `${s}.json`));
  if (check && existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && !known.has(f))) {
      bad++;
      console.log(`목록에 없는 대시보드: ${join(dir, f)} (지우거나 DASHBOARD_SERVICES에 더한다)`);
    }
  }
  for (const s of DASHBOARD_SERVICES) {
    const file = join(dir, `${s}.json`);
    const want = dashboardText(s);
    if (check) {
      if (!existsSync(file) || readFileSync(file, 'utf8') !== want) {
        bad++;
        console.log(`다르다: ${file} (node tools/local/dashboards.mjs로 다시 만든다)`);
      }
    } else {
      writeFileSync(file, want);
      console.log(`썼다: ${file}`);
    }
  }
  if (check) console.log(bad ? `대시보드 ${bad}개가 생성기와 다르다` : `대시보드 ${DASHBOARD_SERVICES.length}개가 생성기와 같다`);
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
