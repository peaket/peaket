// SCR-029 실제 값 화면의 새 부품(pages/dashboard/ui/live/*.tsx)을 서버 그리기로 본다(F-03-3 T5·T7·T8·T10·T11·T12·T13·T14·T15·T16, 시험 먼저 ADR-0372).
// 구현 전 트리에는 부품 파일이 없어 시험마다 가져오기부터 실패한다(부품마다 따로 가져와 하나가 없어도 다른 시험은 돈다).
// 정본: docs/design/d5-screen-blueprint.md §7.2(체크리스트·판정 대화상자 글, '남은 허용 실패("결제 확정 12건 중 3건 사용")', 포화도 <정상>|<주의>|<위험>, '진단 힌트 · 운영 명령 없음',
// 제어 입력 없음 배너 "자동 제어 입력이 끊겼습니다 · 목표를 {n}명으로 유지합니다", 버짓 50% 배너 "자동 증액이 멈췄습니다. 명령 1로 목표를 정하세요",
// '경보 억제' "관련 경보 N건 접힘 · 알림은 보내지 않았습니다", 'viewer'(판정 버튼 없음), '위젯의 연결 판단' 표),
// docs/features/control-tower.md §2·§8·§12, docs/api/asyncapi.yaml OpsAlert.journey(여정 이름), docs/security/asvs/control-tower.md 1.2.2·3.7.2,
// docs/frontend.md §5.7(경보 목록 가상 스크롤), 계획 §4·1-10~1-14.
// 시험이 정한 부품과 속성: ControlBanner({ control }), BudgetWidget({ value, range }), SaturationWidget({ value, range }), DiagnosticsRow({ value, range }),
// ReadinessChecklist({ readiness, role }), JudgementDialog({ readiness }), LiveAlertPanel({ alerts, eventId }). value는 위젯 조회 응답 그대로, range는 { fromMs, toMs }.
// 위젯 값 모양은 test-int/ops-readiness.int.test.ts가 실제 ops-svc로 보는 모양과 같다.
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchors, elements, newTabNoOpener, textOf } from './live.test.html.mjs';

register('../board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';
globalThis.__SCANNER_ORIGIN__ = 'https://scanner.test';
globalThis.__CONSOLE_BUILD__ = 'mf';
globalThis.__CONSOLE_GRAFANA_URL__ = 'https://grafana.ops.test/d/onsale-f033';
globalThis.__CONSOLE_SENTRY_URL__ = 'https://sentry.ops.test/organizations/peaket/issues/';
globalThis.__CONSOLE_LINK_HOSTS__ = 'grafana.ops.test,sentry.ops.test,runbook.ops.test';
const ALLOWED = new Set(['grafana.ops.test', 'sentry.ops.test', 'runbook.ops.test']);

const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');

const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const AT = '2026-11-23T11:15:00.000Z';
const RANGE = { fromMs: Date.parse('2026-11-23T11:00:00.000Z'), toMs: Date.parse(AT) };

/** 부품 하나를 라우터 안에서 그린다 */
async function render(file, name, props) {
  const mod = await import(`./${file}`);
  assert.equal(typeof mod[name], 'function', `${file}에 ${name}이 없다`);
  return renderToString(createElement(MemoryRouter, { initialEntries: [`/dashboard?event=${E}`] }, createElement(mod[name], props)));
}

// ---------- d5 '위젯의 연결 판단' 표(정본을 읽어 대조한다) ----------
const D5 = readFileSync(new URL('../../../../../../../docs/design/d5-screen-blueprint.md', import.meta.url), 'utf8');
function judgementRow(tab, widget) {
  const start = D5.indexOf('위젯의 연결 판단(추천 적용 2026-10-20, ADR-0069)');
  assert.ok(start > 0, 'd5 연결 판단 표를 찾지 못했다');
  const row = D5.slice(start)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(`| ${tab} | ${widget} |`));
  assert.ok(row, `d5 연결 판단 표에 '${tab} | ${widget}' 줄이 없다`);
  return row.split('|')[3].trim();
}
/** 판단 글의 손잡이(명령 번호·런북 번호·엔지니어 호출) */
const handlesOf = (s) => [...new Set([...(s.match(/명령 \d+/g) ?? []), ...(s.match(/RB-\d+/g) ?? []), ...(s.includes('엔지니어') ? ['엔지니어'] : [])])];
function expectJudgementLine(html, tab, widget) {
  const text = textOf(html);
  const i = text.indexOf('판단:');
  assert.ok(i >= 0, `'판단:' 줄이 없다: ${text.slice(0, 300)}`);
  const line = text.slice(i);
  const want = handlesOf(judgementRow(tab, widget));
  assert.ok(want.length > 0);
  assert.deepEqual(
    want.filter((h) => !line.includes(h)),
    [],
    `판단 줄에 d5 손잡이가 빠졌다: ${line.slice(0, 200)}`,
  );
}
/** 위젯 머리의 '자세히 보기 ↗'(새 탭, opener 없음, 정한 Grafana(또는 Sentry)에 같은 회차) */
function expectDetailLink(html, host = 'grafana.ops.test') {
  const links = anchors(html).filter((a) => a.text.includes('자세히 보기'));
  assert.equal(links.length >= 1, true, '자세히 보기 링크가 없다');
  for (const a of links) {
    assert.ok(newTabNoOpener(a), `새 탭·noopener가 아니다: ${JSON.stringify(a)}`);
    const u = new URL(a.href);
    assert.equal(u.host, host);
    assert.ok([...u.searchParams.values()].includes(E) || u.href.includes(E), `같은 회차가 아니다: ${a.href}`);
  }
  assert.doesNotMatch(html, /<i?frame[\s>]/i);
}

// ---------- 값 ----------
const budget = {
  widgetKey: 'ops-budget.journeys',
  source: 'prometheus',
  at: AT,
  eventId: E,
  journeys: [
    { journey: 'payment_confirm', linked: true, allowed: 12, used: 3, remaining: 9, burnShort: 2.5, burnLong: 1.2 },
    { journey: 'hold', linked: true, allowed: 40, used: 0, remaining: 40, burnShort: 0, burnLong: 0 },
    { journey: 'detail', linked: false, allowed: null, used: null, remaining: null, reason: 'source-unavailable' },
  ],
};
/** 포화도 위젯 값(level은 요약, 칸마다 { value, level }) */
const sat = (level, redisLevel, kafka = { value: 0, level: 'ok' }) => ({
  widgetKey: 'ops-saturation.summary',
  source: 'prometheus',
  at: AT,
  eventId: E,
  level,
  cpu: { value: 0.1, level: 'ok' },
  redisMemory: { value: redisLevel === 'ok' ? 0.1 : 0.99, level: redisLevel },
  kafkaLag: kafka,
  eventLoop: { value: 0.005, level: 'ok' },
});
const readiness = (o = {}) => ({
  eventId: E,
  stage: 't30',
  schedule: { opensAt: '2026-11-23T11:40:00.000Z', saleEndsAt: '2026-11-23T13:40:00.000Z' },
  items: [
    { key: 'clock-offset', group: 'required', status: 'fail', value: 30, unit: 'ms', at: AT },
    { key: 'datastores', group: 'required', status: 'pass', at: AT },
    { key: 'prewarm', group: 'required', status: 'not-in-env' },
    { key: 'freeze-window', group: 'required', status: 'unknown', reason: 'source-unavailable' },
    { key: 'cdn-hit-ratio', group: 'recommended', status: 'deferred', value: 412, unit: 'requests' },
    { key: 'demand-forecast', group: 'recommended', status: 'fail', value: 1_200_000 },
    { key: 'pg-assignment', group: 'display', status: 'display-only' },
  ],
  preview: { verdict: 'no-go', failedRequired: ['clock-offset', 'freeze-window'], failedRecommended: ['demand-forecast'] },
  judgeableUntil: '2026-11-23T11:20:00.000Z',
  ...o,
});
let n = 0;
const alert = (o) => ({ alertId: `al-${++n}`, status: 'firing', startsAt: AT, severity: 'SEV2', title: `경보 ${n}`, kind: 'slo', eventId: E, ...o });

// ---------- T5 배너 ----------
test('F-03-3 T5 C-T31 ①-5 입력 없음이면 danger 배너 "자동 제어 입력이 끊겼습니다 · 목표를 1,234명으로 유지합니다"를, 자동 증액 멈춤이면 그 배너를 보이고 정상이면 그리지 않는다', async () => {
  const noInput = await render('ControlBanner.tsx', 'ControlBanner', { control: { eventId: E, kind: 'no-input', since: AT, inputStaleKinds: ['downstream_latency'], targetNow: 1234, updatedAt: AT } });
  assert.ok(textOf(noInput).includes('자동 제어 입력이 끊겼습니다 · 목표를 1,234명으로 유지합니다'), textOf(noInput));
  assert.match(noInput, /role="alert"/);
  const raise = await render('ControlBanner.tsx', 'ControlBanner', { control: { eventId: E, kind: 'raise-stopped', budgetHoldAt: AT, targetNow: 1000, updatedAt: AT } });
  assert.ok(textOf(raise).includes('자동 증액이 멈췄습니다. 명령 1로 목표를 정하세요'), textOf(raise));
  const ok = await render('ControlBanner.tsx', 'ControlBanner', { control: { eventId: E, kind: 'ok', updatedAt: AT } });
  assert.equal(textOf(ok), '');
});

// ---------- T7 남은 허용 실패 ----------
test('F-03-3 T7 ② 버짓 위젯은 여정마다 "결제 확정 12건 중 3건 사용" 꼴로 남은 허용 실패를 그리고, 원천이 없는 여정은 0이 아니라 받지 못함이며, 판단 줄과 자세히 보기가 있다', async () => {
  const html = await render('BudgetWidget.tsx', 'BudgetWidget', { value: budget, range: RANGE });
  const text = textOf(html);
  assert.ok(text.includes('결제 확정 12건 중 3건 사용'), text);
  assert.ok(text.includes('좌석 홀드 40건 중 0건 사용'), text);
  assert.ok(text.includes('받지 못함'), text);
  assert.ok(!text.includes('공연 상세 0건'), `원천이 없는 여정을 0으로 그렸다: ${text}`);
  expectJudgementLine(html, 'T=0·판매 중', '소진 배수·남은 허용 실패');
  expectDetailLink(html);
});

// ---------- T8 포화도 ----------
test('F-03-3 T8 C-T30 ①-2 포화도 요약은 정상·주의·위험을 글자로 보이고(색만으로 나누지 않는다), 값이 없는 칸은 받지 못함이며, 판단 줄과 자세히 보기가 있다', async () => {
  // 판단 줄 글에도 '위험'이 들어 있어(d5 표) 같은 위젯의 정상 그림과 견줘 늘어난 수로 본다
  const count = (text, w) => text.split(w).length - 1;
  const calm = textOf(await render('SaturationWidget.tsx', 'SaturationWidget', { value: sat('ok', 'ok'), range: RANGE }));
  assert.ok(calm.includes('정상'), calm);
  const warnHtml = await render('SaturationWidget.tsx', 'SaturationWidget', { value: sat('warn', 'warn'), range: RANGE });
  const warn = textOf(warnHtml);
  const danger = textOf(await render('SaturationWidget.tsx', 'SaturationWidget', { value: sat('danger', 'danger'), range: RANGE }));
  const missing = textOf(await render('SaturationWidget.tsx', 'SaturationWidget', { value: sat('unknown', 'ok', { value: null, level: 'unknown' }), range: RANGE }));
  assert.ok(count(warn, '주의') > count(calm, '주의'), `주의가 글자로 보이지 않는다: ${warn}`);
  assert.ok(count(danger, '위험') > count(calm, '위험'), `위험이 글자로 보이지 않는다: ${danger}`);
  assert.ok(count(missing, '받지 못함') > count(calm, '받지 못함'), `값이 없는 칸이 받지 못함이 아니다: ${missing}`);
  expectJudgementLine(warnHtml, '판매 중', '포화도 요약');
  expectDetailLink(warnHtml);
});

// ---------- T16 진단 힌트 ----------
test('F-03-3 T16 ① 진단 힌트 줄은 운영 명령 없음으로 판단 위젯과 나뉘고, 원천이 없으면 받지 못함이다', async () => {
  const html = await render('DiagnosticsRow.tsx', 'DiagnosticsRow', { value: { widgetKey: 'ops-diagnostics.summary', source: 'prometheus', at: AT, eventId: E, error: 'source-unavailable' }, range: RANGE });
  const text = textOf(html);
  for (const w of ['진단 힌트', '운영 명령 없음', '받지 못함']) assert.ok(text.includes(w), `${w}가 없다: ${text}`);
});

// ---------- T10 체크리스트·판정 대화상자 ----------
test('F-03-3 T10 C-T25 ①-15 체크리스트는 항목마다 상태를 글자(실패·통과·이 환경에 없음·확인할 수 없음·판정 보류)로 보이고, Go/No-Go 판정 버튼은 operator·commander에만 있다', async () => {
  const op = await render('ReadinessChecklist.tsx', 'ReadinessChecklist', { readiness: readiness(), role: 'operator' });
  const text = textOf(op);
  for (const w of ['실패', '통과', '이 환경에 없음', '확인할 수 없음', '판정 보류']) assert.ok(text.includes(w), `상태 글 '${w}'가 없다: ${text}`);
  const judgeButtons = (html) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].filter((m) => textOf(m[1]).includes('Go/No-Go 판정'));
  assert.equal(judgeButtons(op).length, 1);
  assert.equal(judgeButtons(await render('ReadinessChecklist.tsx', 'ReadinessChecklist', { readiness: readiness(), role: 'commander' })).length, 1);
  for (const role of ['viewer', 'cs_agent', 'cs_lead']) {
    assert.equal(judgeButtons(await render('ReadinessChecklist.tsx', 'ReadinessChecklist', { readiness: readiness(), role })).length, 0, `${role}에게 판정 버튼이 있다`);
  }
});

test('F-03-3 T10 C-T25 ①-16 판정 대화상자는 No-Go면 "입장 일시정지(명령 2)와 공지(명령 7)로 시작합니다"를 보이고, 실패한 권고 항목마다 사유 칸을 둔다', async () => {
  const noGo = await render('JudgementDialog.tsx', 'JudgementDialog', { readiness: readiness() });
  assert.ok(textOf(noGo).includes('입장 일시정지(명령 2)와 공지(명령 7)로 시작합니다'), textOf(noGo));
  assert.ok(elements(noGo, 'textarea').length + elements(noGo, 'input').filter((i) => i.type === 'text').length >= 1, '권고 실패 사유 칸이 없다');
  const go = await render('JudgementDialog.tsx', 'JudgementDialog', {
    readiness: readiness({ items: [{ key: 'clock-offset', group: 'required', status: 'pass' }], preview: { verdict: 'go', failedRequired: [], failedRecommended: [] } }),
  });
  assert.ok(!textOf(go).includes('입장 일시정지(명령 2)와 공지(명령 7)로 시작합니다'), textOf(go));
});

// ---------- 경보 패널 ----------
test('F-03-3 T12 C-T32 ②-4 같은 회차·여정의 SEV1 아래 SEV2가 "관련 경보 1건 접힘 · 알림은 보내지 않았습니다"로 보인다', async () => {
  const top = alert({ severity: 'SEV1', kind: 'slo', journey: 'payment_confirm', title: '결제 확정 에러 버짓 10배 소진' });
  const child = alert({ severity: 'SEV2', kind: 'cause', journey: 'payment_confirm', foldedUnder: top.alertId, title: '결제사 승인 호출 p99 2초 초과' });
  const text = textOf(await render('LiveAlertPanel.tsx', 'LiveAlertPanel', { alerts: [child, top], eventId: E }));
  assert.ok(text.includes('관련 경보 1건 접힘 · 알림은 보내지 않았습니다'), text);
  // 접힌 줄은 위 경보 뒤에 온다
  assert.ok(text.indexOf('결제 확정 에러 버짓 10배 소진') < text.indexOf('관련 경보 1건 접힘'), text);
});

test('F-03-3 T13 C-T32 ③-3 경보 패널은 이 회차 판단과 플랫폼·위생·법정 두 묶음으로 나뉘고, 다른 회차·위생 경보는 뒤 묶음에 보인다', async () => {
  const mine = alert({ severity: 'SEV2', kind: 'control', title: '이 회차 입력 없음' });
  const other = alert({ severity: 'SEV1', kind: 'slo', eventId: '7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a', title: '다른 회차 소진' });
  const hygiene = alert({ severity: 'SEV3', kind: 'hygiene', title: '런북 없음 위생' });
  const text = textOf(await render('LiveAlertPanel.tsx', 'LiveAlertPanel', { alerts: [other, hygiene, mine], eventId: E }));
  const a = text.indexOf('이 회차 판단');
  const b = text.indexOf('플랫폼·위생·법정');
  assert.ok(a >= 0 && b > a, `두 묶음 머리가 없거나 차례가 다르다: ${text}`);
  assert.ok(text.indexOf('이 회차 입력 없음') > a && text.indexOf('이 회차 입력 없음') < b, text);
  for (const t of ['다른 회차 소진', '런북 없음 위생']) assert.ok(text.indexOf(t) > b, `${t}가 플랫폼 묶음에 없다: ${text}`);
});

test('F-03-3 T14 C-T32 ④-2 SLO 경보의 실패 사건 보기는 허용 호스트의 exploreUrl을 새 탭으로 열고, 허용 밖 주소와 http 런북은 글자로만 보인다', async () => {
  const ok = alert({ severity: 'SEV2', kind: 'slo', title: '좌석 홀드 3배 소진', exploreUrl: 'https://grafana.ops.test/explore?left=%7B%7D', runbookUrl: 'https://runbook.ops.test/RB-23' });
  const bad = alert({ severity: 'SEV2', kind: 'slo', title: '결제 접수 3배 소진', exploreUrl: 'https://grafana.ops.test.evil.example/explore', runbookUrl: 'http://runbook.ops.test/RB-07' });
  const html = await render('LiveAlertPanel.tsx', 'LiveAlertPanel', { alerts: [ok, bad], eventId: E });
  const links = anchors(html);
  const explore = links.filter((a) => a.text.includes('실패 사건 보기'));
  assert.deepEqual(
    explore.map((a) => a.href),
    [new URL(ok.exploreUrl).href],
  );
  assert.ok(newTabNoOpener(explore[0]), JSON.stringify(explore[0]));
  assert.ok(links.some((a) => a.href === ok.runbookUrl && newTabNoOpener(a)), '허용 런북이 링크가 아니다');
  for (const href of [bad.exploreUrl, bad.runbookUrl]) assert.ok(!links.some((a) => a.href === href), `허용 밖 주소가 링크다: ${href}`);
  // 허용 밖 주소도 글자로는 남는다(경보 둘 다 '실패 사건 보기' 글이 있다)
  assert.ok(textOf(html).split('실패 사건 보기').length - 1 >= 2, textOf(html));
});

test('F-03-3 T15 ① 경보가 50줄까지면 모두 그리고, 51줄부터는 보이는 줄만 DOM에 두며 전체 수를 보조 기술에 알린다', async () => {
  const many = (k) => Array.from({ length: k }, (_, i) => alert({ severity: 'SEV3', kind: 'flow', title: `가상 경보 ${i + 1}번` }));
  const rendered = (html, k) => Array.from({ length: k }, (_, i) => `가상 경보 ${i + 1}번`).filter((t) => textOf(html).includes(t)).length;
  const fifty = await render('LiveAlertPanel.tsx', 'LiveAlertPanel', { alerts: many(50), eventId: E });
  assert.equal(rendered(fifty, 50), 50);
  for (const k of [51, 60]) {
    const html = await render('LiveAlertPanel.tsx', 'LiveAlertPanel', { alerts: many(k), eventId: E });
    const shown = rendered(html, k);
    assert.ok(shown > 0 && shown < k, `${k}건 가운데 ${shown}건을 그렸다(보이는 줄만 그려야 한다)`);
    assert.match(html, new RegExp(`aria-(setsize|rowcount)="${k}"`), `${k}건 전체 수를 알리지 않았다`);
    assert.match(html, /aria-(posinset|rowindex)="\d+"/);
  }
});

// ---------- T11 자동 이동 없음 ----------
test('F-03-3 T11 [ASVS v5.0.0-3.7.2] 경보·위젯·판정 화면의 다른 호스트 링크는 모두 허용 목록 안의 새 탭 링크이고, 자동 이동(meta refresh)과 프레임이 없다', async () => {
  const pages = [
    await render('LiveAlertPanel.tsx', 'LiveAlertPanel', {
      alerts: [alert({ severity: 'SEV1', kind: 'slo', runbookUrl: 'https://runbook.ops.test/RB-23', dashboardUrl: 'https://grafana.ops.test/d/x', exploreUrl: 'https://evil.example/explore' })],
      eventId: E,
    }),
    await render('BudgetWidget.tsx', 'BudgetWidget', { value: budget, range: RANGE }),
    await render('SaturationWidget.tsx', 'SaturationWidget', { value: sat('warn', 'warn'), range: RANGE }),
    await render('ReadinessChecklist.tsx', 'ReadinessChecklist', { readiness: readiness(), role: 'operator' }),
    await render('JudgementDialog.tsx', 'JudgementDialog', { readiness: readiness() }),
  ];
  let external = 0;
  for (const html of pages) {
    assert.doesNotMatch(html, /<meta[^>]+http-equiv="?refresh/i);
    assert.doesNotMatch(html, /<i?frame[\s>]/i);
    for (const a of anchors(html)) {
      if (!a.href || !/^[a-z][a-z0-9+.-]*:/i.test(a.href)) continue;
      const u = new URL(a.href);
      if (u.host === 'ops-api.test') continue;
      external += 1;
      assert.equal(u.protocol, 'https:', a.href);
      assert.ok(ALLOWED.has(u.host), `허용 밖 호스트로 가는 링크: ${a.href}`);
      assert.ok(newTabNoOpener(a), `새 탭·noopener가 아니다: ${a.href}`);
    }
  }
  assert.ok(external >= 3, `다른 호스트 링크가 너무 적다(${external}): 시험이 빈 화면을 보고 있다`);
});
