// 경보 보내는 길 설정의 정적 시험(V-T53 ③, 그리고 ②⑤의 파일 몫). 계획 docs/review/plans/F-01-6.md §5·§6.
// 정본: docs/observability.md §5 '경보 보내는 길'(받는 곳 다섯·비밀 파일·경로·문구에 싣는 칸·데드맨), §4 '그 밖의 규칙 평가 간격',
// docs/verification.md V-T53 ③, docs/security/secrets-and-keys.md(주소·토큰은 설정 파일에 적지 않는다).
// 실제 저장소 파일을 읽는다. 경로가 실제로 그렇게 나뉘는지는 실제 Alertmanager로 V-T53 ①(packages/platform/test-int)이 본다.
// 실행(저장소 뿌리): node --test tools/ci/alertmanager-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AM_DIR = join(REPO, 'deploy', 'platform', 'observability', 'alertmanager');
const CONFIG = join(AM_DIR, 'alertmanager.yaml');
const TEMPLATE = join(AM_DIR, 'templates', 'peaket.tmpl');
const WATCHDOG = join(REPO, 'deploy', 'platform', 'observability', 'rules', 'watchdog.yaml');

// 정본 값(observability.md §5 '경보 보내는 길': 받는 곳 다섯, 비밀은 /etc/alertmanager/secrets/<이름>)
const RECEIVERS = ['deadman', 'evidence-collector', 'github-issues', 'irm-oncall', 'slack-ops'];
const SECRET_DIR = '/etc/alertmanager/secrets/';
// 받는 곳마다 읽는 비밀 파일(계획 §3 '받는 곳과 비밀'의 일곱 파일)
const FILES_BY_RECEIVER = {
  'irm-oncall': ['irm-oncall-url'],
  'slack-ops': ['slack-ops-url'],
  'github-issues': ['alert-issue-relay-token', 'alert-issue-relay-url'],
  deadman: ['healthchecks-ping-url'],
  'evidence-collector': ['evidence-collector-token', 'evidence-collector-url'],
};
// 글로 주소·토큰을 싣는 Alertmanager 설정 키(파일 판 *_file만 허용한다)
const LITERAL_SECRET_KEYS = new Set(['url', 'api_url', 'credentials', 'slack_api_url', 'bearer_token', 'password', 'service_key', 'routing_key', 'api_key', 'webhook_url', 'token', 'bot_token', 'smtp_auth_password']);
// 문구에 싣는 칸(observability.md §5 '문구에 싣는 것')
const ALLOWED_LABELS = ['alertname', 'severity', 'kind', 'event_id', 'journey', 'dependency'];
const ALLOWED_ANNOTATIONS = ['summary', 'runbook_url', 'dashboard_url', 'explore_url'];

function config() {
  assert.ok(existsSync(CONFIG), 'Alertmanager 설정 원천이 없다: deploy/platform/observability/alertmanager/alertmanager.yaml');
  return parse(readFileSync(CONFIG, 'utf8'));
}

/** 값 나무의 모든 (경로, 키, 값) */
function* walk(v, path = []) {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) yield* walk(v[i], [...path, i]);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      yield { path: [...path, k].join('.'), key: k, value: x };
      yield* walk(x, [...path, k]);
    }
  }
}

/** 받는 곳 하나가 읽는 *_file 값 */
const filesOf = (receiver) => [...walk(receiver)].filter((e) => e.key.endsWith('_file') && typeof e.value === 'string').map((e) => e.value);

/** 맞추기 글 하나 → [이름, 연산, 값](따옴표·띄어쓰기를 걷는다) */
function matcher(m) {
  const x = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*"?(.*?)"?\s*$/.exec(String(m));
  assert.ok(x, `맞추기 꼴이 아니다: ${m}`);
  return [x[1], x[2], x[3]];
}

/** 경로 나무를 위에서부터 펼친다(자식 차례 그대로) */
function* routes(r, depth = 0) {
  for (const child of r.routes ?? []) {
    yield { route: child, depth };
    yield* routes(child, depth + 1);
  }
}

test('V-T53 ③ 받는 곳의 주소·토큰은 모두 파일에서 읽고 심각도마다 경로가 있다', () => {
  const c = config();

  // 받는 곳 다섯(이름 그대로, 겹침 없음)
  const names = (c.receivers ?? []).map((r) => r.name);
  assert.deepEqual([...names].sort(), RECEIVERS);
  assert.equal(new Set(names).size, names.length, '받는 곳 이름이 겹친다');

  // 주소·토큰을 글로 싣는 키가 설정 어디에도 없다
  const literal = [...walk(c)].filter((e) => LITERAL_SECRET_KEYS.has(e.key));
  assert.deepEqual(literal.map((e) => e.path), [], '주소·토큰은 *_file로만 읽는다');
  // 받는 곳 설정에 http로 시작하는 글이 없다
  const httpText = [...walk(c.receivers)].filter((e) => typeof e.value === 'string' && /^\s*https?:/i.test(e.value));
  assert.deepEqual(httpText.map((e) => e.path), [], '받는 곳 설정에 주소 글이 있다');
  // global에도 주소를 두지 않는다(slack_api_url 등)
  const globalHttp = [...walk(c.global ?? {})].filter((e) => typeof e.value === 'string' && /^\s*https?:/i.test(e.value));
  assert.deepEqual(globalHttp.map((e) => e.path), [], 'global에 주소 글이 있다');

  // 받는 곳마다 읽는 비밀 파일이 정한 것과 같고, 모두 /etc/alertmanager/secrets/ 아래 일곱 경로다
  const all = [];
  for (const r of c.receivers) {
    const files = filesOf(r);
    all.push(...files);
    assert.deepEqual([...new Set(files)].sort(), FILES_BY_RECEIVER[r.name].map((f) => `${SECRET_DIR}${f}`).sort(), `${r.name}의 비밀 파일`);
  }
  assert.equal(new Set(all).size, 7, '비밀 파일 일곱');
  for (const f of all) assert.ok(f.startsWith(SECRET_DIR), `비밀 파일 자리: ${f}`);

  // 받는 곳 종류: 온콜·데드맨·티켓·증거 수집기는 웹훅, 운영 채널은 Slack 수신 웹훅
  const kinds = Object.fromEntries(c.receivers.map((r) => [r.name, Object.keys(r).filter((k) => k.endsWith('_configs')).sort()]));
  assert.deepEqual(kinds, {
    deadman: ['webhook_configs'],
    'evidence-collector': ['webhook_configs'],
    'github-issues': ['webhook_configs'],
    'irm-oncall': ['webhook_configs'],
    'slack-ops': ['slack_configs'],
  });
  // 티켓 중계·증거 수집기는 Bearer 토큰 파일을 싣는다
  for (const n of ['github-issues', 'evidence-collector']) {
    const auth = c.receivers.find((r) => r.name === n).webhook_configs.map((w) => w.http_config?.authorization);
    for (const a of auth) {
      assert.ok(a, `${n}: http_config.authorization이 없다`);
      assert.ok(a.type === undefined || a.type === 'Bearer', `${n}: 인증 종류 ${a.type}`);
      assert.match(a.credentials_file, /-token$/);
    }
  }
  // 티켓 중계는 해제 경보를 받아야 티켓을 닫는다(§5 티켓 중계: 해제 경보는 그 티켓을 닫는다)
  for (const w of c.receivers.find((r) => r.name === 'github-issues').webhook_configs) assert.notEqual(w.send_resolved, false, 'github-issues는 send_resolved가 켜져 있어야 한다');

  // 문구 틀 자리
  assert.deepEqual(c.templates, ['/etc/alertmanager/templates/*.tmpl']);

  // 경로: 맨 위 받는 곳은 운영 채널(심각도가 없거나 모르는 값)
  assert.equal(c.route?.receiver, 'slack-ops');
  const flat = [...routes(c.route)];
  assert.ok(flat.length > 0, '경로가 없다');
  for (const { route } of flat) {
    assert.ok(route.match === undefined && route.match_re === undefined, '맞추기는 matchers 꼴로 쓴다');
    if (route.receiver !== undefined) assert.ok(RECEIVERS.includes(route.receiver), `없는 받는 곳을 가리킨다: ${route.receiver}`);
  }
  // 같음(=) 또는 값 전체가 맞는 정규식(=~)
  const has = (route, name, value) =>
    (route.matchers ?? []).map(matcher).some(([n, op, v]) => n === name && ((op === '=' && v === value) || (op === '=~' && new RegExp(`^(?:${v})$`).test(value))));

  // Watchdog 경로는 맨 앞이고, 데드맨으로 가며, 아래로 이어 가지 않는다
  const first = (c.route.routes ?? [])[0];
  assert.ok(first && has(first, 'alertname', 'Watchdog'), '첫 경로가 alertname="Watchdog"이 아니다');
  assert.equal(first.receiver, 'deadman');
  assert.ok(first.continue === undefined || first.continue === false, 'Watchdog 경로는 continue가 없다');

  // 심각도마다 경로가 있고 정한 받는 곳으로 간다
  const receiversFor = (name, value) => flat.filter(({ route }) => has(route, name, value)).map(({ route }) => route.receiver);
  assert.ok(receiversFor('severity', 'sev1').includes('irm-oncall'), 'sev1 → irm-oncall');
  assert.ok(receiversFor('severity', 'sev2').includes('slack-ops'), 'sev2 → slack-ops');
  assert.ok(receiversFor('severity', 'sev3').includes('github-issues'), 'sev3 → github-issues');
  assert.ok(receiversFor('alertname', 'IncidentDeclared').includes('evidence-collector'), 'IncidentDeclared → evidence-collector');
  // 증거 수집기로 가는 경로는 모두 아래로 이어 간다(같은 경보가 다른 받는 곳에도 가야 한다)
  for (const { route } of flat.filter(({ route }) => route.receiver === 'evidence-collector')) assert.equal(route.continue, true, '증거 수집기 경로는 continue: true');
  // 데드맨으로 가는 경로는 Watchdog 하나뿐이다
  assert.equal(flat.filter(({ route }) => route.receiver === 'deadman').length, 1);
});

test('V-T53 ② 데드맨 규칙 Watchdog은 늘 울리고 severity none·kind control이다', () => {
  assert.ok(existsSync(WATCHDOG), '규칙 파일이 없다: deploy/platform/observability/rules/watchdog.yaml');
  const docs = parseAllDocuments(readFileSync(WATCHDOG, 'utf8'))
    .map((d) => d.toJS())
    .filter(Boolean);
  assert.equal(docs.length, 1);
  const pr = docs[0];
  assert.equal(pr.apiVersion, 'monitoring.coreos.com/v1');
  assert.equal(pr.kind, 'PrometheusRule');
  const groups = pr.spec?.groups ?? [];
  const wd = groups.filter((g) => g.name === 'watchdog');
  assert.equal(wd.length, 1, "묶음 'watchdog' 하나");
  // 평가 간격 30초(observability.md §4 '그 밖의 규칙 평가 간격')
  assert.equal(wd[0].interval, '30s');
  const alerts = groups.flatMap((g) => g.rules ?? []).filter((r) => r.alert);
  assert.deepEqual(alerts.map((r) => r.alert), ['Watchdog']);
  const w = alerts[0];
  assert.equal(String(w.expr).replace(/\s+/g, ''), 'vector(1)');
  assert.ok(w.for === undefined || /^0[smh]?$/.test(String(w.for)), '늘 울리는 규칙은 기다리지 않는다');
  assert.equal(w.labels?.severity, 'none');
  assert.equal(w.labels?.kind, 'control');
  // 주석 검사(alert-check, F-01-7)가 요구하는 런북·대시보드 링크를 미리 둔다(observability.md §5 OpsAlert 주석)
  for (const k of ['summary', 'runbook_url', 'dashboard_url']) assert.equal(typeof w.annotations?.[k], 'string', `주석 ${k}`);
  assert.ok(w.annotations.summary.trim().length > 0);
});

test('V-T53 ⑤ [ASVS v5.0.0-14.2.3] 알림 문구 틀은 정한 라벨·주석만 꺼낸다', () => {
  assert.ok(existsSync(TEMPLATE), '문구 틀이 없다: deploy/platform/observability/alertmanager/templates/peaket.tmpl');
  const t = readFileSync(TEMPLATE, 'utf8');
  // 틀 이름(계획 §3 '문구에 싣는 칸')
  assert.match(t, /define\s+"peaket\.slack\.title"/);
  assert.match(t, /define\s+"peaket\.slack\.text"/);
  // 라벨·주석 전체를 늘어놓지 않는다
  for (const bad of [/\.(Common|Group)?(Labels|Annotations)\.(SortedPairs|Names|Values|Remove)\b/, /range[^}]*\.(Common|Group)?(Labels|Annotations)\s*-?\}\}/]) {
    assert.doesNotMatch(t, bad, `라벨·주석 전체를 꺼낸다: ${bad}`);
  }
  // 꺼내는 칸은 정한 목록 안이다(description 주석·목록 밖 라벨 없음)
  const labels = [...t.matchAll(/\.(?:Common|Group)?Labels\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const annots = [...t.matchAll(/\.(?:Common)?Annotations\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const indexed = [...t.matchAll(/index\s+\$?[A-Za-z_.]*\.?(?:Common|Group)?(Labels|Annotations)\s+"([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(labels.filter((l) => !ALLOWED_LABELS.includes(l)), [], '목록 밖 라벨');
  assert.deepEqual(annots.filter((a) => !ALLOWED_ANNOTATIONS.includes(a)), [], '목록 밖 주석');
  assert.deepEqual(indexed.filter(([k, n]) => !(k === 'Labels' ? ALLOWED_LABELS : ALLOWED_ANNOTATIONS).includes(n)), [], '목록 밖 칸(index)');
  assert.ok(labels.length + indexed.length > 0 && annots.length + indexed.length > 0, '문구가 라벨·주석을 하나도 싣지 않는다');

  // 설정의 Slack 받는 곳은 그 틀을 쓴다
  const slack = config().receivers.find((r) => r.name === 'slack-ops').slack_configs;
  for (const s of slack) {
    assert.match(String(s.title), /template\s+"peaket\.slack\.title"/);
    assert.match(String(s.text), /template\s+"peaket\.slack\.text"/);
  }
});
