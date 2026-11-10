// 좌석맵 에디터 흐름 시험(BUILD_ORDER HOT-220, ADR-0264, docs/frontend.md FE-T46·FE-T38). FE-T41과 같은 파트너 콘솔 운영 빌드·서버(4122)를 쓴다.
// 파트너 API(https://partner-api.peaket.example)는 page.route로 채우고, 답은 실제 core-svc 통합 시험과 같은 골든 파일
// (services/core-svc/test-int/fixtures/seatmap-editor/)이다. 문서 상태는 화면의 [JSON으로 내보내기] 파일로 읽는다(시험용 창 변수를 두지 않는다, FE-T21).
// 늦게 싣는 덩어리 크기와 CSP·Trusted Types 위반은 reports/seatmap-editor.json에 남긴다.
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { isBidiFirefox } from '../lib/firefox.mjs';

const API = 'https://partner-api.peaket.example';
const FIX = new URL('../../../services/core-svc/test-int/fixtures/seatmap-editor/', import.meta.url);
const fixture = (n) => readFileSync(new URL(n, FIX), 'utf8');
const fixtureJson = (n) => JSON.parse(fixture(n));
const P1 = '0b8f1f2e-4a1d-4c1e-9b5a-000000000150';
const P2 = '0b8f1f2e-4a1d-4c1e-9b5a-000000000151';
const OUT = 'reports/seatmap-editor.json';
const LAZY_BUDGET_KB = 300;

function record(key, value) {
  mkdirSync('reports', { recursive: true });
  const all = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  all[key] = value;
  writeFileSync(OUT, JSON.stringify(all, null, 2));
}

/** 계약 모양 가짜 파트너 API. answers의 함수가 요청마다 답을 정한다(없으면 골든) */
async function fakeApi(page, origin, o = {}) {
  const calls = [];
  const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'ETag, Retry-After', vary: 'Origin' };
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const m = /^\/v1\/partner\/productions\/([^/]+)\/(seatmap|seatmap-imports)$/.exec(url.pathname);
    const call = { method: req.method(), path: url.pathname, headers: req.headers(), body: req.postDataBuffer() };
    calls.push(call);
    const reply = (status, body, headers = {}) => route.fulfill({ status, headers: { ...cors, 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) });
    if (!m) return reply(404, { type: 'https://peaket.example/problems/not-found', status: 404 });
    const [, id, kind] = m;
    if (kind === 'seatmap-imports') return o.importAnswer ? o.importAnswer(call, reply) : reply(200, fixtureJson('import-rows-result.json'));
    if (req.method() === 'GET') {
      if (o.load) return o.load(id, reply);
      return id === P1 ? reply(200, fixtureJson('load-response.json'), { etag: '"1"' }) : reply(404, { type: 'https://peaket.example/problems/not-found', status: 404, title: '찾을 수 없습니다' });
    }
    if (o.save) return o.save(call, reply);
    // 판은 If-Match로 읽는다(BiDi Firefox는 보낸 본문을 주지 않는다)
    const v = Number(/\d+/.exec(call.headers['if-match'] ?? '0')[0]);
    return reply(200, { ...fixtureJson('save-response.json'), layoutVersion: v + 1 }, { etag: `"${v + 1}"` });
  });
  return calls;
}

async function open(page, id = P1, o = {}) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ directive: e.effectiveDirective, disposition: e.disposition, blocked: String(e.blockedURI).slice(0, 120), sample: (e.sample || '').slice(0, 80) }));
  });
  const scripts = [];
  page.on('response', async (r) => {
    if (r.request().resourceType() !== 'script') return;
    try {
      scripts.push({ path: new URL(r.url()).pathname, gz: gzipSync(await r.body()).length });
    } catch {
      // 본문을 못 읽는 응답은 건너뛴다
    }
  });
  const origin = new URL(test.info().project.use.baseURL).origin;
  const calls = await fakeApi(page, origin, o);
  const res = await page.goto(`/events/${id}/seatmap`);
  const html = await res.text();
  const inHtml = new Set([...html.matchAll(/\/_next\/static\/[^"'\s)]+\.js/g)].map((x) => x[0]));
  return { res, calls, scripts: () => scripts.map((s) => ({ ...s, phase: inHtml.has(s.path) ? 'initial' : 'lazy' })) };
}

/** 캔버스 맞춤 보기(fit: 캔버스 8,000×6,000cm를 0.95배로 가운데)에서 세계 좌표 → 화면 좌표 */
async function view(page, cw = 8000, ch = 6000) {
  const b = await page.getByTestId('seatmap-canvas').boundingBox();
  const s = Math.min(b.width / cw, b.height / ch) * 0.95;
  return { s, at: (x, y) => [b.x + (b.width - cw * s) / 2 + x * s, b.y + (b.height - ch * s) / 2 + y * s] };
}

/** [JSON으로 내보내기] 파일로 문서 상태를 읽는다 */
async function exported(page) {
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'JSON으로 내보내기' }).click()]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), doc: JSON.parse(readFileSync(path, 'utf8')) };
}

const summarySeats = (page) => page.getByTestId('summary-seats');

/** 숫자·글자 칸에 넣고 Enter. 칸은 Enter나 초점 떠남에서 한 번 명령을 만든다(BiDi Firefox는 Enter가 칸에 닿지 않을 때가 있어 초점도 뺀다) */
async function put(loc, v) {
  if (isBidiFirefox(test.info().project.name)) {
    // BiDi의 fill은 React가 듣는 input 사건 없이 값만 바꾼다. 눌러서 지우고 친다
    await loc.click();
    await loc.press('ControlOrMeta+a');
    await loc.pressSequentially(v);
  } else await loc.fill(v);
  await loc.press('Enter');
  await loc.blur();
}

test('FE-T46 ① 배치본이 있는 공연은 서버 판의 구역·좌석 수로 그리고 없는 공연(404)은 시작 화면이다', async ({ page, browserName }) => {
  const { res, scripts } = await open(page);
  // 에디터 경로도 묶음 B 파트너 CSP와 Trusted Types 보고 모드다(seat-hold ASVS 3.4.3)
  const h = res.headers();
  expect(h['content-security-policy']).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
  expect(h['content-security-policy']).toContain("worker-src 'self'");
  expect(h['content-security-policy-report-only']).toContain("require-trusted-types-for 'script'");
  await expect(summarySeats(page)).toHaveText('좌석 83');
  const tree = page.getByRole('tree', { name: '좌석 계층' });
  await expect(tree.getByRole('treeitem')).toHaveCount(5);
  await expect(tree.getByRole('treeitem').nth(1)).toContainText('A구역');
  await expect(page.getByRole('status').filter({ hasText: '변경 없음' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const s = scripts();
  const lazy = s.filter((x) => x.phase === 'lazy');
  const lazyKb = Math.round((lazy.reduce((n, x) => n + x.gz, 0) / 1024) * 10) / 10;
  const violations = await page.evaluate(() => window.__csp);
  record(`open/${browserName}`, { lazyKb, lazyFiles: lazy.length, initialKb: Math.round((s.filter((x) => x.phase === 'initial').reduce((n, x) => n + x.gz, 0) / 1024) * 10) / 10, violations });
  console.log(`seatmap-editor/${browserName}: 늦게 싣는 덩어리 ${lazyKb}kB(파일 ${lazy.length}개), 위반 ${JSON.stringify(violations)}`);
  expect(lazy.length).toBeGreaterThan(0);
  expect(lazyKb).toBeLessThanOrEqual(LAZY_BUDGET_KB);
  // CSP 강제 위반은 0이다(팬 좌석맵 패키지를 하위 경로로 가져와 Zod의 평가 가능 시험이 실리지 않는다, ADR-0264 결정 42). 보고 모드의 Trusted Types 위반은 기록만 한다
  expect(violations.filter((v) => v.disposition === 'enforce')).toEqual([]);

  // 배치본이 없는 공연(404): 시작 화면. 템플릿 카드는 HOT-230 전이라 숨긴다
  const page2 = await page.context().newPage();
  await fakeApi(page2, new URL(test.info().project.use.baseURL).origin);
  await page2.goto(`/events/${P2}/seatmap`);
  await expect(page2.getByRole('heading', { name: '어떻게 시작할까요?' })).toBeVisible();
  await expect(page2.getByRole('button', { name: /빈 캔버스에서 그리기/ })).toBeVisible();
  await expect(page2.getByRole('button', { name: /파일 가져오기/ })).toBeVisible();
  await expect(page2.getByText('템플릿으로 시작')).toHaveCount(0);
});

test('FE-T46 ⑪ 구역 이름 <img src=x onerror=alert(1)>는 캔버스 글자로만 그려지고 문서에 요소가 생기지 않는다 [ASVS v5.0.0-1.1.2] [ASVS v5.0.0-1.3.5] [ASVS v5.0.0-3.2.2]', async ({ page }) => {
  let alerted = false;
  page.on('dialog', async (d) => {
    alerted = true;
    await d.dismiss();
  });
  await open(page);
  const tree = page.getByRole('tree', { name: '좌석 계층' });
  await expect(tree.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  // 문서에 그 img 요소가 없다(이름은 글자 노드, 캔버스는 fillText)
  expect(await page.locator('img[src="x"], img[onerror]').count()).toBe(0);
  // 구역을 고르면 속성 칸 값으로도 글자 그대로다
  await tree.getByRole('treeitem').nth(2).click();
  await expect(page.locator('#sp-name')).toHaveValue('<img src=x onerror=alert(1)>');
  expect(await page.locator('img[src="x"], img[onerror]').count()).toBe(0);
  expect(alerted).toBe(false);
});

test('FE-T46 ⑦ 저장 본문은 If-Match "0"·색인과 응답 전용 칸 없음이고 412·409·403·422·429·503·12MiB·떠나기 확인이 정한 대로다 [ASVS v5.0.0-3.5.2]', async ({ page, browserName }) => {
  const queue = [];
  const { calls } = await open(page, P1, {
    save: (call, reply) => {
      const next = queue.shift();
      if (next) return next(call, reply);
      const v = Number(/\d+/.exec(call.headers['if-match'] ?? '0')[0]);
      return reply(200, { ...fixtureJson('save-response.json'), layoutVersion: v + 1 }, { etag: `"${v + 1}"` });
    },
  });
  await expect(summarySeats(page)).toHaveText('좌석 83');
  // 가격 하나를 바꾼다(명령 하나)
  const price = page.locator('#tier-S-price');
  await put(price, '98000');
  await expect(page.getByRole('status').filter({ hasText: '변경 1건 · 저장 전' })).toBeVisible();
  await page.getByRole('button', { name: '좌석맵 저장' }).click();
  await expect(page.getByRole('status').filter({ hasText: /에 저장함$/ })).toBeVisible();
  const sentPut = calls.find((c) => c.method === 'PUT');
  expect(sentPut.headers['if-match']).toBe('"1"');
  expect(sentPut.headers['content-type']).toContain('application/json');
  if (!isBidiFirefox(browserName)) {
    const body = JSON.parse(sentPut.body.toString('utf8'));
    expect(body.layoutVersion).toBe(1);
    for (const k of ['"index"', '"seatIndexRange"', '"fanFilePublished"', '"geometryLocked"', '"warnings"']) expect(JSON.stringify(body).includes(k)).toBe(false);
    expect(body.priceTiers[0]).toEqual({ tierId: 'S', name: 'S석', price: 98000 });
  }
  // 저장 뒤 되돌리기 기록이 비었다
  await expect(page.getByRole('button', { name: '실행 취소' })).toBeDisabled();

  // 실패 답마다: 문서·변경 수는 그대로이고 문구를 보인다
  const edit = (v) => put(price, String(v));
  const problem = (status, type, extra = {}, headers = {}) => (_c, reply) => reply(status, { type: `https://peaket.example/problems/${type}`, status, ...extra }, headers);
  await edit(97000);
  queue.push(problem(412, 'precondition-failed'));
  await page.getByRole('button', { name: '좌석맵 저장' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '다른 곳에서 좌석맵이 바뀌었습니다. 지금 변경을 JSON으로 내보낸 뒤 다시 불러오세요' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'JSON으로 내보내기' })).toBeVisible();
  await expect(page.getByRole('button', { name: '다시 불러오기' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '변경 1건 · 저장 전' })).toBeVisible();
  for (const [status, type, text] of [
    [409, 'seatmap-geometry-locked', '판매가 시작돼 도형과 좌석은 바꿀 수 없습니다'],
    [403, 'partner-admin-required', '판매 승인을 받은 공연의 좌석맵은 파트너 관리자만 저장할 수 있습니다'],
    // 본문 상한 413은 Fastify가 낸다(type about:blank)
    [413, 'about:blank', '좌석맵이 너무 큽니다'],
    [504, 'deadline-exceeded', '저장했는지 확인하지 못했습니다. 다시 불러와 확인해 주세요'],
  ]) {
    queue.push(problem(status, type));
    await page.getByRole('button', { name: '좌석맵 저장' }).click();
    await expect(page.getByRole('alert').filter({ hasText: text }).first()).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '변경 1건 · 저장 전' })).toBeVisible();
  }
  // 409 잠김은 화면도 잠근다(가격 칸이 꺼진다)
  await expect(price).toBeDisabled();
});

test('FE-T46 ⑦ 422는 오류 표, 429·503은 Retry-After 동안 [좌석맵 저장]이 잠기고 저장 전 떠나면 확인을 묻는다', async ({ page, browserName }) => {
  const queue = [];
  await open(page, P1, { save: (call, reply) => queue.shift()(call, reply) });
  await expect(summarySeats(page)).toHaveText('좌석 83');
  const price = page.locator('#tier-S-price');
  await put(price, '98000');
  queue.push((_c, reply) => reply(422, { type: 'https://peaket.example/problems/seatmap-invalid', status: 422, result: { ok: false, errors: [{ line: 0, field: 'sections[0].seats[3].tierId', code: 'TIER_UNKNOWN' }], warnings: [] } }));
  const save = page.getByRole('button', { name: '좌석맵 저장' });
  await save.click();
  const table = page.getByRole('region', { name: '저장 오류' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('가격 등급에 없는 등급입니다');
  // 자리는 원래 경로가 아니라 사람이 읽는 꼴이다
  await expect(table).toContainText('A구역 4번째 좌석');
  queue.push((_c, reply) => reply(429, { type: 'https://peaket.example/problems/server-busy', status: 429 }, { 'retry-after': '2' }));
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: '지금 저장이 많습니다' })).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(save).toBeEnabled({ timeout: 4_000 });
  // 저장 전 떠나기: beforeunload 확인(Playwright 1.64.1의 BiDi Firefox는 beforeunload 대화상자를 넘기지 않아 건너뛴다)
  if (isBidiFirefox(browserName)) return;
  let asked = false;
  page.on('dialog', async (d) => {
    if (d.type() === 'beforeunload') asked = true;
    await d.accept();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe(true);
});

test('FE-T46 ⑫ geometryLocked 공연은 도형·좌석 편집과 가격 등급이 꺼지고 속성만 바뀐다', async ({ page }) => {
  const { calls } = await open(page, P1, { load: (_id, reply) => reply(200, { ...fixtureJson('load-response.json'), geometryLocked: true }, { etag: '"1"' }) });
  await expect(page.getByRole('status').filter({ hasText: '판매가 시작돼 도형과 좌석은 바꿀 수 없습니다. 판매 제외·휠체어석·입장 게이트만 바꿀 수 있습니다' })).toBeVisible();
  await expect(page.getByRole('button', { name: '사각형 구역' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '등급 더하기' })).toBeDisabled();
  await expect(page.locator('#tier-S-price')).toBeDisabled();
  await page.getByRole('tab', { name: /좌석 다듬기/ }).click();
  const tree = page.getByRole('tree', { name: '좌석 계층' });
  await tree.getByRole('treeitem').nth(1).click();
  await expect(page.getByRole('status').filter({ hasText: '좌석 36석 선택' })).toBeVisible();
  for (const name of ['줄 맞추기', '간격 고르게', '통로 만들기', '지우기', '좌석 넣기', '번호 다시 매기기']) await expect(page.getByRole('group', { name: '고른 좌석 다듬기' }).getByRole('button', { name, exact: true })).toBeDisabled();
  await expect(page.getByLabel('좌석 등급')).toBeDisabled();
  // 판매 제외는 바꿀 수 있고 저장 본문은 그 칸만 다르다
  await page.getByLabel('판매 제외').check();
  await page.getByRole('button', { name: '좌석맵 저장' }).click();
  await expect(page.getByRole('status').filter({ hasText: /에 저장함$/ })).toBeVisible();
  expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
});

test('FE-T46 ⑧ 가져오기 대화상자: 행 오류 표, SVG_IGNORED 이름은 글자, 10MB·압축 파일은 보내지 않음, JSON은 확인 뒤 명령 하나 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', async ({ page, browserName }) => {
  let answer = 'rows';
  const { calls } = await open(page, P1, { importAnswer: (_c, reply) => reply(200, answer === 'rows' ? fixtureJson('import-rows-result.json') : answer === 'svg' ? fixtureJson('import-svg-result.json') : { ok: true, errors: [], warnings: [], layout: JSON.parse(fixture('export.json')) }) });
  await expect(summarySeats(page)).toHaveText('좌석 83');
  const openDialog = async (format) => {
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    const d = page.getByRole('dialog', { name: '좌석맵 파일 가져오기' });
    await d.getByLabel(format).check();
    return d;
  };
  // 행 오류 CSV: 표(줄·칸·쉬운 문구)이고 반영하지 않는다. 파일 칸 이름은 seatmap.csv, X-Requested-With
  let d = await openDialog('CSV');
  await d.locator('#import-file').setInputFiles({ name: '내 좌석맵(최종).csv', mimeType: 'text/csv', buffer: Buffer.from(fixture('import-rows.csv')) });
  await d.getByRole('button', { name: '가져오기', exact: true }).click();
  const rows = d.getByRole('region', { name: '가져오기 오류 행' }).getByRole('row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('5행');
  await expect(rows.nth(1)).toContainText('좌표가 숫자가 아닙니다');
  const post = calls.find((c) => c.method === 'POST');
  expect(post.headers['x-requested-with']).toBe('peaket-partner');
  if (!isBidiFirefox(browserName)) {
    const text = post.body.toString('utf8');
    expect(text).toContain('filename="seatmap.csv"');
    expect(text.includes('최종')).toBe(false);
  }
  await d.getByRole('button', { name: '닫기' }).click();
  await expect(summarySeats(page)).toHaveText('좌석 83');

  // 10MB를 1바이트 넘는 파일과 압축 파일은 보내지 않는다
  const sent = calls.filter((c) => c.method === 'POST').length;
  d = await openDialog('CSV');
  await d.locator('#import-file').setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x20) });
  await d.getByRole('button', { name: '가져오기', exact: true }).click();
  await expect(d.getByRole('alert')).toContainText('좌석맵 파일은 10MB까지 올릴 수 있습니다');
  await d.locator('#import-file').setInputFiles({ name: 'a.csv', mimeType: 'text/csv', buffer: gzipSync(Buffer.from('section,row')) });
  await d.getByRole('button', { name: '가져오기', exact: true }).click();
  await expect(d.getByRole('alert')).toContainText('압축 파일은 받지 않습니다');
  expect(calls.filter((c) => c.method === 'POST').length).toBe(sent);
  await d.getByRole('button', { name: '닫기' }).click();

  // SVG: 읽지 않은 요소 이름은 글자로만 보이고 문서에 svg·script 요소를 넣지 않는다
  answer = 'svg';
  d = await openDialog('SVG');
  await d.locator('#import-file').setInputFiles({ name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(fixture('import-svg.svg')) });
  await d.getByRole('button', { name: '가져오기', exact: true }).click();
  await expect(d.getByTestId('import-ignored')).toHaveText('읽지 않고 넘긴 요소: script, image');
  expect(await page.locator('main svg foreignObject, main svg script').count()).toBe(0);
  await d.getByRole('button', { name: '닫기' }).click();

  // 정상 JSON(지금 배치가 있음): 바꿀지 묻고, 명령 하나로 반영되고, 되돌릴 수 있다
  answer = 'json';
  d = await openDialog('JSON');
  await d.locator('#import-file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(fixture('export.json')) });
  await d.getByRole('button', { name: '가져오기', exact: true }).click();
  await d.getByRole('button', { name: '에디터에 올리기' }).click();
  await expect(d.getByRole('alert')).toContainText('지금 좌석맵을 가져온 파일로 바꿉니다');
  await d.getByRole('button', { name: '바꾸기' }).click();
  await expect(page.getByRole('status').filter({ hasText: '변경 1건 · 저장 전' })).toBeVisible();
  await expect(summarySeats(page)).toHaveText('좌석 83');
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(page.getByRole('status').filter({ hasText: '변경 없음' })).toBeVisible();
});

test('가져온 SVG 결과는 캔버스에 데이터로만 그리고 문서에 svg·foreignObject 요소를 넣지 않는다 [ASVS v5.0.0-1.3.4]', async ({ page }) => {
  const layout = { canvas: { width: 2000, height: 1500 }, stage: [], sections: [{ sectionId: '1', name: '<svg onload=alert(1)><foreignObject>', shape: { kind: 'POLYGON', points: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] }, seats: [{ seatId: '1-1-1', row: '1', number: 1, x: 100, y: 100 }] }] };
  await open(page, P2, { importAnswer: (_c, reply) => reply(200, { ok: true, errors: [], warnings: [{ code: 'SVG_IGNORED', ignored: ['foreignObject', 'script'] }], layout }) });
  await page.getByRole('button', { name: /파일 가져오기/ }).click();
  const d = page.getByRole('dialog', { name: '좌석맵 파일 가져오기' });
  await d.getByLabel('SVG').check();
  await d.locator('#import-file').setInputFiles({ name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(fixture('import-svg.svg')) });
  await d.getByRole('button', { name: '가져오기', exact: true }).click();
  await d.getByRole('button', { name: '에디터에 올리기' }).click();
  await expect(summarySeats(page)).toHaveText('좌석 1');
  await expect(page.getByRole('tree', { name: '좌석 계층' }).getByText('<svg onload=alert(1)><foreignObject>', { exact: true })).toBeVisible();
  expect(await page.locator('foreignObject').count()).toBe(0);
  expect(await page.locator('svg[onload]').count()).toBe(0);
});

test('FE-T46 ⑨ 가격 등급 차례가 저장 본문 차례와 같고 17번째를 더할 수 없으며 좌석이 쓰는 등급은 지우지 못한다', async ({ page }) => {
  const { calls } = await open(page);
  await expect(summarySeats(page)).toHaveText('좌석 83');
  // 좌석이 쓰는 등급(S·R·A)은 지울 수 없다
  for (const n of ['S석', 'R석', 'A석']) await expect(page.getByRole('button', { name: `${n} 지우기` })).toBeDisabled();
  // A석을 맨 위로: 저장 본문(내보낸 JSON과 같은 모양)의 차례가 화면 차례와 같다
  await page.getByRole('button', { name: 'A석 위로' }).click();
  await page.getByRole('button', { name: 'A석 위로' }).click();
  const { doc } = await exported(page);
  expect(doc.priceTiers.map((t) => t.tierId)).toEqual(['A', 'S', 'R']);
  // 16개까지 더하고 17번째는 더할 수 없다
  const add = page.getByRole('button', { name: '등급 더하기' });
  for (let i = 3; i < 15; i++) await add.click();
  await expect(page.getByText('15/16개', { exact: false })).toBeVisible();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByText('16/16개', { exact: false })).toBeVisible();
  await expect(add).toBeDisabled();
  // 새 등급은 가격이 비어 저장하지 않는다
  await page.getByRole('button', { name: '좌석맵 저장' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '가격을 채우지 않은 등급이 있습니다' })).toBeVisible();
  expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
});

test('FE-T46 ② ③ 사각형을 끌어 그리고 숫자 칸·화살표 10cm·Shift 1m·좌우 대칭 복제를 한다', async ({ page }) => {
  await open(page, P2);
  await page.getByRole('button', { name: /빈 캔버스에서 그리기/ }).click();
  await page.getByRole('button', { name: '사각형 구역' }).click();
  const v = await view(page);
  const [x0, y0] = v.at(1000, 2000);
  const [x1, y1] = v.at(2500, 3000);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2);
  await page.mouse.move(x1, y1);
  await page.mouse.up();
  await expect(page.getByRole('tree', { name: '좌석 계층' }).getByRole('treeitem')).toHaveCount(1);
  // 격자 1m에 맞은 사각형(숫자 칸이 손잡이 값과 같다)
  await expect(page.locator('#sp-x')).toHaveValue('1000');
  await expect(page.locator('#sp-w')).toHaveValue('1500');
  await put(page.locator('#sp-w'), '1234');
  await put(page.locator('#sp-rot'), '30');
  // 화살표 10cm, Shift+화살표 1m(캔버스를 눌러 초점을 칸에서 뺀다)
  await page.getByRole('heading', { name: '좌석 계층' }).click();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#sp-x')).toHaveValue('1010');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('#sp-y')).toHaveValue('2100');
  await page.getByRole('button', { name: '좌우 대칭 복제' }).click();
  await expect(page.getByRole('tree', { name: '좌석 계층' }).getByRole('treeitem')).toHaveCount(2);
  const { doc } = await exported(page);
  const [a, b] = doc.sections;
  expect(a.shape.points[0]).toEqual([1010, 2100]);
  expect(a.shape.points.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= 8000 && y <= 6000)).toBe(true);
  // 무대가 없으면 캔버스 가운데(x = 4000)의 거울 꼴
  expect(b.shape.points.map(([x, y]) => [8000 - x, y]).reverse()).toEqual(a.shape.points);
});

test('FE-T46 ④ ⑤ ⑥ 좌석 600 채우기·지우고 채우기 확인, 상자 고르기, 편집 10번 뒤 되돌리기 10번', async ({ page }) => {
  await open(page);
  await expect(summarySeats(page)).toHaveText('좌석 83');
  await page.getByRole('tab', { name: /좌석 채우기/ }).click();
  await page.getByRole('tree', { name: '좌석 계층' }).getByRole('treeitem').nth(1).click();
  await put(page.locator('#fill-targetCount'), '600');
  await page.getByRole('button', { name: '채우기 미리보기' }).click();
  await expect(page.getByRole('status').filter({ hasText: /석이 들어갑니다\(목표보다 \d+석 적습니다\)\. 도형을 넓히거나 좌석 간격을 줄이세요\./ })).toBeVisible();
  await page.getByRole('button', { name: '이 구역에 채우기' }).click();
  const confirm = page.getByRole('alertdialog', { name: '이미 좌석이 있는 구역입니다' });
  await expect(confirm).toContainText('이 구역의 좌석 36석을 지우고 새로 채웁니다');
  await confirm.getByRole('button', { name: '지우고 채우기' }).click();
  await expect(page.getByRole('status').filter({ hasText: '변경 1건 · 저장 전' })).toBeVisible();
  const filled = await summarySeats(page).textContent();
  // ③ 상자 고르기
  await page.getByRole('tab', { name: /좌석 다듬기/ }).click();
  const v = await view(page);
  const [x0, y0] = v.at(2550, 1350);
  const [x1, y1] = v.at(3850, 2150);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('status').filter({ hasText: /^좌석 [\d,]+석 선택$/ })).not.toHaveText('좌석 0석 선택');
  // ⑥ 편집 10번(화살표) 뒤 되돌리기 10번 → 채운 직후 문서
  const before = (await exported(page)).doc;
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('status').filter({ hasText: '변경 11건 · 저장 전' })).toBeVisible();
  for (let i = 0; i < 10; i++) await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(page.getByRole('status').filter({ hasText: '변경 1건 · 저장 전' })).toBeVisible();
  expect((await exported(page)).doc).toEqual(before);
  await expect(summarySeats(page)).toHaveText(filled);
});

test('FE-T38 ④ 미리보기는 전체 배치에서 시작해 구역을 누르면 확대된다', async ({ page }) => {
  await open(page);
  await expect(summarySeats(page)).toHaveText('좌석 83');
  await page.getByRole('tab', { name: '미리보기' }).click();
  await expect(page.getByRole('status').filter({ hasText: '전체 배치' })).toBeVisible();
  const c = await page.getByRole('img', { name: /좌석맵 미리보기/ }).boundingBox();
  // A구역(가로 2600~3800, 세로 1400~2100) 가운데를 누른다. 미리보기 엔진도 캔버스 전체를 가운데에 맞춘다
  const s = Math.min(c.width / 8000, c.height / 6000);
  await page.mouse.click(c.x + (c.width - 8000 * s) / 2 + 3200 * s, c.y + (c.height - 6000 * s) / 2 + 1750 * s);
  await expect(page.getByRole('status').filter({ hasText: '확대한 좌석' })).toBeVisible();
  await page.getByRole('tabpanel', { name: '미리보기' }).getByRole('button', { name: '전체 보기' }).click();
  await expect(page.getByRole('status').filter({ hasText: '전체 배치' })).toBeVisible();
});

// ---------- 리뷰 재현(BAT-150 관점 넷 리뷰, ADR-0264 결정 30~42) ----------

const UUIDS = Array.from({ length: 200 }, (_, i) => `0193a3c4-0000-7000-8000-${String(i + 1).padStart(12, '0')}`);
/** 골든 저장 응답의 '#n' 좌석 ID를 서버가 매긴 꼴의 UUID로 */
const withServerIds = (v) => JSON.parse(JSON.stringify(v).replace(/"#(\d+)"/g, (_, n) => `"${UUIDS[Number(n) - 1]}"`));

test('FE-T46 ⑦ 저장 요청이 오가는 동안 화살표·가격 고치기·Ctrl+Z가 문서를 바꾸지 않고 200 뒤 문서는 서버 응답이다', async ({ page }) => {
  let release;
  const gate = new Promise((r) => (release = r));
  await open(page, P1, {
    save: async (_c, reply) => {
      await gate;
      return reply(200, { ...fixtureJson('save-response.json'), layoutVersion: 2 }, { etag: '"2"' });
    },
  });
  await expect(summarySeats(page)).toHaveText('좌석 83');
  const price = page.locator('#tier-S-price');
  await put(price, '98000');
  await page.getByRole('button', { name: '좌석맵 저장' }).click();
  await expect(page.getByRole('status').filter({ hasText: '저장 중입니다' })).toBeVisible();
  // 저장 중: 속성·가격 칸이 꺼지고, 고른 도형의 화살표·되돌리기가 문서를 바꾸지 않는다
  await expect(price).toBeDisabled();
  await page.getByRole('tree', { name: '좌석 계층' }).getByRole('treeitem').nth(1).click();
  const x0 = await page.locator('#sp-x').inputValue();
  await page.locator('h2#h-tree').click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#sp-x')).toHaveValue(x0);
  await expect(page.getByRole('button', { name: '가져오기', exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('status').filter({ hasText: /에 저장함$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '실행 취소' })).toBeDisabled();
  const { doc } = await exported(page);
  expect(doc).toEqual({ ...fixtureJson('export.json'), layoutVersion: 2 });
});

test('FE-T46 ⑦ 배치본이 없는 공연은 If-Match "0"으로 보내 판 1·서버 좌석 ID로 갈아끼우고 변경 수가 0이 된다', async ({ page, browserName }) => {
  const { calls } = await open(page, P2, {
    importAnswer: (_c, reply) => reply(200, { ok: true, errors: [], warnings: [], layout: JSON.parse(fixture('export.json')) }),
    save: (_c, reply) => reply(200, withServerIds(fixtureJson('save-response.json')), { etag: '"1"' }),
  });
  await page.getByRole('button', { name: /파일 가져오기/ }).click();
  const d = page.getByRole('dialog', { name: '좌석맵 파일 가져오기' });
  await d.locator('#import-file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(fixture('export.json')) });
  await d.getByRole('button', { name: '가져오기', exact: true }).click();
  await d.getByRole('button', { name: '에디터에 올리기' }).click();
  await expect(page.getByRole('status').filter({ hasText: '변경 1건 · 저장 전' })).toBeVisible();
  await page.getByRole('button', { name: '좌석맵 저장' }).click();
  await expect(page.getByRole('status').filter({ hasText: /에 저장함$/ })).toBeVisible();
  const putCall = calls.find((c) => c.method === 'PUT');
  expect(putCall.headers['if-match']).toBe('"0"');
  if (!isBidiFirefox(browserName)) expect(JSON.parse(putCall.body.toString('utf8')).layoutVersion).toBe(0);
  const { doc } = await exported(page);
  expect(doc.layoutVersion).toBe(1);
  expect(doc.sections.flatMap((s) => s.seats.map((x) => x.seatId))).toEqual(UUIDS.slice(0, 83));
  await expect(page.getByRole('button', { name: '실행 취소' })).toBeDisabled();
});

test('FE-T46 ② 곡선 띠를 Shift+↑로 여섯 번 올려도 중심이 캔버스 안이고 다시 연 손잡이 숫자 칸 값이 그대로다', async ({ page }) => {
  await open(page);
  await expect(summarySeats(page)).toHaveText('좌석 83');
  const tree = page.getByRole('tree', { name: '좌석 계층' });
  // ⑩ 다시 연 부채꼴·곡선 띠의 손잡이 값(arc)
  await tree.getByRole('treeitem').nth(3).click();
  await expect(page.locator('#sp-out')).toHaveValue('1000');
  await expect(page.locator('#sp-start')).toHaveValue('180');
  await expect(page.locator('#sp-end')).toHaveValue('270');
  await tree.getByRole('treeitem').nth(4).click();
  await expect(page.locator('#sp-in')).toHaveValue('2500');
  await page.locator('h2#h-tree').click();
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowUp');
  expect(Number(await page.locator('#sp-cy').inputValue())).toBeGreaterThanOrEqual(0);
  const { doc } = await exported(page);
  const arc = doc.sections[3].shape.arc;
  expect(arc.cy).toBeGreaterThanOrEqual(0);
  expect(arc.cx).toBeGreaterThanOrEqual(0);
});

test('FE-T46 ② 다각형 구역을 찍어 만들 때 캔버스 밖(회색 자리)을 눌러도 꼭짓점은 캔버스 안 정수다', async ({ page }) => {
  await open(page, P2);
  await page.getByRole('button', { name: /빈 캔버스에서 그리기/ }).click();
  await page.getByRole('button', { name: '다각형 구역' }).click();
  const v = await view(page);
  const box = await page.getByTestId('seatmap-canvas').boundingBox();
  for (const [x, y] of [[-150, 1000], [2000, 900], [2200, 2500]]) {
    const [sx, sy] = v.at(x, y);
    await page.mouse.click(Math.max(box.x + 2, sx), sy);
    // 빠른 연속 누르기는 브라우저가 두 번 누르기로 보고 다각형을 먼저 끝낸다(현장 사용자는 점마다 뜸을 둔다)
    await page.waitForTimeout(400);
  }
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tree', { name: '좌석 계층' }).getByRole('treeitem')).toHaveCount(1);
  const { doc } = await exported(page);
  const pts = doc.sections[0].shape.points;
  expect(pts.length).toBe(3);
  expect(pts.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= 8000 && y <= 6000)).toBe(true);
  expect(pts[0][0]).toBe(0);
});

test('FE-T46 ④ 채우기 미리보기 뒤 문서가 바뀌면(되돌리기) [이 구역에 채우기]가 옛 결과를 놓지 않는다', async ({ page }) => {
  await open(page);
  await expect(summarySeats(page)).toHaveText('좌석 83');
  const tree = page.getByRole('tree', { name: '좌석 계층' });
  await tree.getByRole('treeitem').nth(1).click();
  await put(page.locator('#sp-w'), '4000');
  await page.getByRole('tab', { name: /좌석 채우기/ }).click();
  await tree.getByRole('treeitem').nth(1).click();
  await put(page.locator('#fill-targetCount'), '600');
  await page.getByRole('button', { name: '채우기 미리보기' }).click();
  await expect(page.getByRole('status').filter({ hasText: /석이 들어갑니다/ })).toBeVisible();
  // 넓힌 것을 되돌린다(가로 1,200cm로)
  await page.getByRole('button', { name: '실행 취소' }).click();
  await page.getByRole('button', { name: '이 구역에 채우기' }).click();
  const confirm = page.getByRole('alertdialog', { name: '이미 좌석이 있는 구역입니다' });
  await confirm.getByRole('button', { name: '지우고 채우기' }).click();
  const { doc } = await exported(page);
  const s1 = doc.sections[0];
  expect(s1.shape.points.map((p) => p[0])).toEqual([2600, 3800, 3800, 2600]);
  expect(s1.seats.every((x) => x.x >= 2600 && x.x <= 3800 && x.y >= 1400 && x.y <= 2100)).toBe(true);
});

test('FE-T46 ⑤ 좌석을 끌다 캔버스 밖에서 놓은 뒤 다시 들어와도 좌석이 따라오지 않는다', async ({ page }) => {
  await open(page);
  await expect(summarySeats(page)).toHaveText('좌석 83');
  await page.getByRole('tab', { name: /좌석 다듬기/ }).click();
  const v = await view(page);
  const [sx, sy] = v.at(3763, 1536);
  await page.mouse.click(sx, sy);
  await expect(page.getByRole('status').filter({ hasText: '좌석 1석 선택' })).toBeVisible();
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const tree = await page.getByRole('tree', { name: '좌석 계층' }).boundingBox();
  await page.mouse.move(tree.x + 20, tree.y + 20, { steps: 5 });
  await page.mouse.up();
  // 캔버스 안 먼 곳으로 들어와 누르고 놓는다(화면 밖 좌표를 피해 뷰포트 안 점을 쓴다)
  const [fx, fy] = v.at(6500, 3000);
  await page.mouse.move(fx, fy, { steps: 5 });
  await page.mouse.down();
  await page.mouse.up();
  const { doc } = await exported(page);
  const seat = doc.sections[0].seats[0];
  expect(Math.hypot(seat.x - 6500, seat.y - 5000)).toBeGreaterThan(500);
});

test('FE-T46 ⑦ 저장 전 변경이 있으면 앱 안 링크(빵부스러기)를 눌러도 떠날지 묻는다', async ({ page }) => {
  await open(page);
  await expect(summarySeats(page)).toHaveText('좌석 83');
  await put(page.locator('#tier-S-price'), '98000');
  const asked = [];
  page.on('dialog', async (d) => {
    asked.push([d.type(), d.message()]);
    if (asked.length === 1) await d.dismiss();
    else await d.accept();
  });
  const link = page.getByRole('navigation', { name: '위치' }).getByRole('link', { name: '공연 관리' });
  await link.click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toEqual(['confirm', '저장하지 않은 변경이 있습니다. 이 화면을 떠날까요?']);
  await page.waitForTimeout(300);
  expect(new URL(page.url()).pathname).toBe(`/events/${P1}/seatmap`);
  await link.click();
  await page.waitForURL(/\/events(\?|$)/);
});

test('FE-T46 ⑫ 저장이 409(잠김)로 끝나면 화면을 잠그고 배너에 [JSON으로 내보내기]·[다시 불러오기]와 속성만 고치라는 안내를 둔다', async ({ page }) => {
  const queue = [];
  await open(page, P1, { save: (c, reply) => queue.shift()(c, reply) });
  await expect(summarySeats(page)).toHaveText('좌석 83');
  await put(page.locator('#tier-S-price'), '98000');
  queue.push((_c, reply) => reply(409, { type: 'https://peaket.example/problems/sale-setting-locked', status: 409 }));
  await page.getByRole('button', { name: '좌석맵 저장' }).click();
  const banner = page.getByRole('alert').filter({ hasText: '다시 불러온 뒤 판매 제외·휠체어석·입장 게이트만 고쳐 저장하세요' });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'JSON으로 내보내기' })).toBeVisible();
  await expect(banner.getByRole('button', { name: '다시 불러오기' })).toBeVisible();
  await expect(page.locator('#tier-S-price')).toBeDisabled();
});

test('FE-T46 ⑫ 잠긴 배치본에서는 도형 끌기·화살표·Delete가 문서를 바꾸지 않고 저장 본문은 판매 제외 칸만 다르다', async ({ page, browserName }) => {
  const { calls } = await open(page, P1, { load: (_id, reply) => reply(200, { ...fixtureJson('load-response.json'), geometryLocked: true }, { etag: '"1"' }) });
  await expect(summarySeats(page)).toHaveText('좌석 83');
  const tree = page.getByRole('tree', { name: '좌석 계층' });
  await tree.getByRole('treeitem').nth(1).click();
  const v = await view(page);
  const [cx, cy] = v.at(3200, 1750);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 40, { steps: 5 });
  await page.mouse.up();
  await page.locator('h2#h-tree').click();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('tab', { name: /좌석 다듬기/ }).click();
  await tree.getByRole('treeitem').nth(1).click();
  await page.keyboard.press('Delete');
  await expect(summarySeats(page)).toHaveText('좌석 83');
  await expect(page.getByRole('status').filter({ hasText: '변경 없음' })).toBeVisible();
  await page.getByLabel('판매 제외').check();
  await page.getByRole('button', { name: '좌석맵 저장' }).click();
  await expect(page.getByRole('status').filter({ hasText: /에 저장함$/ })).toBeVisible();
  if (isBidiFirefox(browserName)) return;
  const sent = JSON.parse(calls.find((c) => c.method === 'PUT').body.toString('utf8'));
  const flagged = sent.sections[0].seats.filter((x) => x.unavailable).length;
  expect(flagged).toBe(36);
  const strip = (d) => JSON.parse(JSON.stringify(d, (k, val) => (k === 'unavailable' ? undefined : val)));
  expect(strip(sent)).toEqual(strip(fixtureJson('export.json')));
});

test('FE-T46 ⑧ 구역 ID가 __proto__인 JSON을 가져온 뒤에도 그 구역 좌석을 Delete로 지운다 [ASVS v5.0.0-1.5.2]', async ({ page }) => {
  const layout = { canvas: { width: 2000, height: 1500 }, stage: [], sections: [{ sectionId: '__proto__', name: 'P구역', shape: { kind: 'POLYGON', points: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] }, seats: [{ seatId: '1-1-1', row: '1', number: 1, x: 100, y: 100 }, { seatId: '1-1-2', row: '1', number: 2, x: 200, y: 100 }] }] };
  await open(page, P2, { importAnswer: (_c, reply) => reply(200, { ok: true, errors: [], warnings: [], layout }) });
  await page.getByRole('button', { name: /파일 가져오기/ }).click();
  const d = page.getByRole('dialog', { name: '좌석맵 파일 가져오기' });
  await d.locator('#import-file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(layout)) });
  await d.getByRole('button', { name: '가져오기', exact: true }).click();
  await d.getByRole('button', { name: '에디터에 올리기' }).click();
  await expect(summarySeats(page)).toHaveText('좌석 2');
  await page.getByRole('tab', { name: /좌석 다듬기/ }).click();
  await page.getByRole('tree', { name: '좌석 계층' }).getByRole('treeitem').first().click();
  await expect(page.getByRole('status').filter({ hasText: '좌석 2석 선택' })).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(summarySeats(page)).toHaveText('좌석 0');
});

test('휴대폰 폭에서는 편집 화면(캔버스·Konva)을 싣지 않고 미리보기와 요약 줄만 보인다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  const bodies = [];
  page.on('response', async (r) => {
    if (r.request().resourceType() !== 'script') return;
    try {
      bodies.push((await r.body()).toString('utf8'));
    } catch {
      // 본문을 못 읽는 응답은 건너뛴다
    }
  });
  await fakeApi(page, new URL(test.info().project.use.baseURL).origin);
  await page.goto(`/events/${P1}/seatmap`);
  await expect(page.getByTestId('summary-seats')).toHaveText('좌석 83');
  await expect(page.getByRole('img', { name: /좌석맵 미리보기/ })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(bodies.some((b) => b.includes('konvajs-content'))).toBe(false);
  expect(await page.getByTestId('seatmap-canvas').count()).toBe(0);
  await ctx.close();
});
