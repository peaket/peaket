// 관제 콘솔 밖 도구 링크(shared/lib/links.ts) 시험(F-03-3 T9·T10·T14, 시험 먼저 ADR-0372). 구현 전 트리에는 파일이 없어 가져오기부터 실패한다.
// 정본: docs/features/control-tower.md §2·§12('자세히 보기 ↗'는 같은 회차·같은 시간대의 Grafana(오류 위젯은 Sentry)를 새 탭 rel="noopener"로 연다, ADR-0067),
// §8('runbookUrl과 대시보드 링크는 https이고 정한 호스트일 때만 링크, 아니면 글자로만'), docs/security/asvs/control-tower.md 1.2.2(주소 틀에는 회차 ID·시작·끝 시각뿐, 값은 인코딩),
// 계획 docs/review/plans/F-03-3.md §4 '콘솔'(detailHref·safeAlertHref, 빌드 값 PEAKET_CONSOLE_GRAFANA_URL·PEAKET_CONSOLE_SENTRY_URL·PEAKET_CONSOLE_LINK_HOSTS)·6-10.
// 빌드 값은 webpack DefinePlugin 전역으로 들어온다(__OPS_API_ORIGIN__과 같은 방식). 시험이 정한 전역 이름: __CONSOLE_GRAFANA_URL__·__CONSOLE_SENTRY_URL__·__CONSOLE_LINK_HOSTS__(쉼표로 이은 호스트).
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../api/live/live.test.resolve.mjs', import.meta.url);
const GRAFANA = 'https://grafana.ops.test/d/onsale-f033';
const SENTRY = 'https://sentry.ops.test/organizations/peaket/issues/';
globalThis.__CONSOLE_GRAFANA_URL__ = GRAFANA;
globalThis.__CONSOLE_SENTRY_URL__ = SENTRY;
globalThis.__CONSOLE_LINK_HOSTS__ = 'grafana.ops.test,sentry.ops.test,runbook.ops.test';
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const load = () => import('./links.ts');
const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const FROM = Date.parse('2026-11-23T11:00:00.000Z');
const TO = Date.parse('2026-11-23T11:15:00.000Z');

test('F-03-3 T9 C-T30 ③-1 자세히 보기 주소는 정한 Grafana 틀(오류 위젯은 Sentry)에 같은 회차 ID와 같은 시간대만 담는다', async () => {
  const { detailHref } = await load();
  const g = new URL(detailHref({ kind: 'grafana', panel: 'budget', eventId: E, fromMs: FROM, toMs: TO }));
  const base = new URL(GRAFANA);
  assert.equal(g.origin, base.origin);
  assert.equal(g.pathname, base.pathname);
  assert.equal(g.hash, '');
  const values = [...g.searchParams.values()];
  for (const v of [E, String(FROM), String(TO)]) assert.ok(values.includes(v), `${v}가 주소에 없다: ${g.href}`);
  // 회차 ID·시작·끝(과 패널) 밖의 값은 싣지 않는다
  assert.ok(g.searchParams.size <= 4, `값이 너무 많다: ${g.href}`);
  const s = new URL(detailHref({ kind: 'sentry', panel: 'errors', eventId: E, fromMs: FROM, toMs: TO }));
  assert.equal(s.origin, new URL(SENTRY).origin);
  assert.ok([...s.searchParams.values()].join(' ').includes(E), `Sentry 주소에 회차가 없다: ${s.href}`);
});

test('F-03-3 T10 [ASVS v5.0.0-1.2.2] 회차 ID·시간 범위에 &·#·javascript:를 넣어도 인코딩되어 주소 구조가 바뀌지 않는다', async () => {
  const { detailHref } = await load();
  for (const evil of ['x&var-other=1#frag', 'javascript:alert(1)', '"><script>1</script>', 'a/../../admin?b=1']) {
    const u = new URL(detailHref({ kind: 'grafana', panel: 'budget', eventId: evil, fromMs: FROM, toMs: TO }));
    assert.equal(u.protocol, 'https:');
    assert.equal(u.host, new URL(GRAFANA).host);
    assert.equal(u.pathname, new URL(GRAFANA).pathname, `경로가 바뀌었다: ${u.href}`);
    assert.equal(u.hash, '', `조각이 생겼다: ${u.href}`);
    assert.equal(u.searchParams.has('var-other'), false, `새 쿼리 이름이 생겼다: ${u.href}`);
    assert.ok([...u.searchParams.values()].includes(evil), `넣은 값이 한 값으로 남지 않았다: ${u.href}`);
  }
});

test('F-03-3 T10 [ASVS v5.0.0-1.2.2] 경보 주소는 정한 호스트의 https만 링크이고, http·정하지 않은 호스트·javascript:·data:·정한 이름이 앞에 붙은 다른 호스트·사용자 정보 속임은 링크가 아니다', async () => {
  const { safeAlertHref } = await load();
  const ok = 'https://runbook.ops.test/RB-07';
  assert.equal(new URL(safeAlertHref(ok)).href, new URL(ok).href);
  assert.equal(new URL(safeAlertHref('https://grafana.ops.test/explore?left=%7B%7D')).host, 'grafana.ops.test');
  const rejected = [
    'http://runbook.ops.test/RB-07',
    'https://evil.example/RB-07',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>1</script>',
    'https://runbook.ops.test.evil.example/RB-07',
    'https://evil-runbook.ops.test/RB-07',
    'https://sub.runbook.ops.test/RB-07',
    'https://runbook.ops.test@evil.example/RB-07',
    '//runbook.ops.test/RB-07',
    '/audit',
    '',
    'not a url',
  ];
  assert.deepEqual(
    rejected.map((u) => [u, safeAlertHref(u)]),
    rejected.map((u) => [u, null]),
  );
});

test('F-03-3 T14 C-T32 ④-1 SLO 경보의 실패 사건 보기(exploreUrl)는 허용 호스트면 그 주소를, 아니면 null을 낸다', async () => {
  const { safeAlertHref } = await load();
  const explore = 'https://grafana.ops.test/explore?schemaVersion=1&panes=%7B%22a%22%3A%7B%7D%7D&from=1763895600000&to=1763896500000';
  assert.equal(safeAlertHref(explore), new URL(explore).href);
  assert.equal(safeAlertHref('https://grafana.other.test/explore?x=1'), null);
});
