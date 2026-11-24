// F-03-4 브라우저 확인(계획 §9, OPS-390). 실제 무대(console-commands/stage.mjs)를 그대로 쓰고, 시스템 Chrome을 Playwright로 몬다.
// 확인: 역할·실제 API, 실제 누름·초점·키보드, aria-disabled 안내, 대화상자 뒤 비밀·토큰 잔존, 명령 3 dry-run 0.5초·ACKED·CSP,
// 명령 6 요청·승인·반려·요청자 차단·승인 기한, 명령 1 dry-run '세지 못함', 320·768 가로 스크롤.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { installPasskey, signIn, trackSecurity } from './accounts.mjs';
import { stageStatus } from './stage-client.mjs';
import {
  card,
  confirmKillSwitch,
  fillReason,
  formSection,
  openCommands,
  pickCommand,
  reauthenticate,
  selectCommand,
  submitForm,
  waitServerState,
} from './ui.mjs';

const SHOTS = process.env.PEAKET_BROWSER_CHECK_DIR ?? join(tmpdir(), 'peaket-f034-browser-check');
let status;
let commander;
let operator;
let commanderContext;
let operatorContext;
let commanderPage;
let operatorPage;
let commanderSecurity;
let operatorSecurity;
let commanderErrors;
let operatorErrors;
let commanderRequests;
let operatorRequests;

const eventOf = () => randomUUID().toLowerCase();
const reasonOf = (tag) => `F-03-4 브라우저 확인 ${tag} ${randomUUID()}`;
const shot = async (page, name) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name), fullPage: true });
  return name;
};

function watch(page, errors, requests) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on('requestfailed', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/v1/')) return;
    if (u.pathname.endsWith('/live') || r.failure()?.errorText.includes('ERR_ABORTED')) return;
    errors.push(`requestfailed: ${r.method()} ${u.pathname} ${r.failure()?.errorText}`);
  });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/v1/')) requests.push(`${r.method()} ${u.pathname}`);
  });
}

async function activeInfo(page) {
  return page.evaluate(() => {
    const e = document.activeElement;
    if (!(e instanceof HTMLElement)) return { tag: '', text: '' };
    return {
      tag: e.tagName,
      id: e.id,
      text: (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim().slice(0, 120),
      ariaDisabled: e.getAttribute('aria-disabled'),
      describedBy: e.getAttribute('aria-describedby'),
    };
  });
}

/** Tab을 차례로 눌러 조건에 맞는 초점을 찾는다 */
async function tabUntil(page, predicate, max = 40) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const seen = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const info = await activeInfo(page);
    seen.push(info.text || info.tag);
    if (predicate(info)) return { info, seen };
  }
  return { info: null, seen };
}

test.beforeAll(async ({ browser }) => {
  status = await stageStatus();
  commander = status.accounts.commander;
  operator = status.accounts.operator;
  commanderContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  commanderPage = await commanderContext.newPage();
  commanderSecurity = await trackSecurity(commanderPage);
  commanderErrors = [];
  commanderRequests = [];
  watch(commanderPage, commanderErrors, commanderRequests);
  await signIn(commanderPage, commander, status.previewUrl);
  await installPasskey(commanderPage, commander);

  operatorContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  operatorPage = await operatorContext.newPage();
  operatorSecurity = await trackSecurity(operatorPage);
  operatorErrors = [];
  operatorRequests = [];
  watch(operatorPage, operatorErrors, operatorRequests);
  await signIn(operatorPage, operator, status.previewUrl);
  await installPasskey(operatorPage, operator);
});

test.afterAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, 'console-errors.json'), JSON.stringify({ commander: commanderErrors, operator: operatorErrors }, null, 2));
  await commanderContext?.close();
  await operatorContext?.close();
});

test('OPS-390 B1 역할·실제 API·초점·키보드·대화상자 상태', async () => {
  const eventId = eventOf();
  await openCommands(commanderPage, eventId);

  // 역할은 sessions/me(서버)에서 온다. 운영 빌드는 MSW·가짜 API를 싣지 않는다
  const me = await commanderPage.evaluate(async () => {
    const r = await fetch('/v1/ops/auth/sessions/me', { credentials: 'include' });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  expect(me.status).toBe(200);
  expect(me.body?.role).toBe('commander');
  expect(await commanderPage.evaluate(() => navigator.serviceWorker?.getRegistrations?.().then((x) => x.length) ?? Promise.resolve(0))).toBe(0);
  expect(commanderRequests.some((r) => r.includes('/v1/ops/auth/sessions/me'))).toBe(true);
  expect(commanderRequests.some((r) => r.includes('/v1/ops/commands'))).toBe(true);
  expect(commanderRequests.some((r) => /mock|msw/i.test(r))).toBe(false);

  // Tab으로 카탈로그 명령 3에 닿고 Enter로 작성 폼을 연다
  const onCatalog = await tabUntil(commanderPage, (i) => i.text.includes('판매 일시정지'));
  expect(onCatalog.info, `Tab으로 카탈로그에 닿지 못했다: ${onCatalog.seen.join(' → ')}`).toBeTruthy();
  await commanderPage.keyboard.press('Enter');
  await expect(formSection(commanderPage)).toBeVisible();
  const onReason = await tabUntil(commanderPage, (i) => i.id === 'cmd-form-reason');
  expect(onReason.info, `Tab으로 사유 칸에 닿지 못했다: ${onReason.seen.join(' → ')}`).toBeTruthy();
  await shot(commanderPage, '01-command-form-keyboard.png');

  // operator 화면의 명령 3은 aria-disabled이고 초점은 받으며, 이유 글이 aria-describedby로 이어지고 눌러도 요청이 0이다
  await openCommands(operatorPage, eventId);
  await pickCommand(operatorPage, '명령 3');
  const blocked = formSection(operatorPage).getByRole('button', { name: '! 판매를 전면 중단합니다', exact: true });
  await expect(blocked).toHaveAttribute('aria-disabled', 'true');
  await blocked.focus();
  const focused = await activeInfo(operatorPage);
  expect(focused.text).toContain('판매를 전면 중단합니다');
  expect(focused.ariaDisabled).toBe('true');
  expect(focused.describedBy).toBeTruthy();
  await expect(operatorPage.locator(`#${focused.describedBy}`)).toHaveText('판매 일시정지는 commander만 실행할 수 있습니다');
  let operatorPosts = 0;
  const count = (r) => {
    if (r.url().endsWith('/v1/ops/commands') && r.method() === 'POST') operatorPosts += 1;
  };
  operatorPage.on('request', count);
  await operatorPage.keyboard.press('Enter');
  await operatorPage.waitForTimeout(500);
  operatorPage.off('request', count);
  expect(operatorPosts, '막힌 단추에 Enter를 눌렀는데 요청이 나갔다').toBe(0);

  // 대화상자를 닫으면 비밀번호·코드가 화면 상태에서 지워지고, 성공한 토큰은 저장소에 남지 않는다
  await openCommands(commanderPage, eventId);
  await pickCommand(commanderPage, '명령 3');
  const reason = reasonOf('대화상자');
  await fillReason(commanderPage, reason);
  await submitForm(commanderPage, '! 판매를 전면 중단합니다');
  await confirmKillSwitch(commanderPage, reason);
  const reauth = commanderPage.locator('section[aria-labelledby="reauth-h"]');
  await expect(reauth).toBeVisible();
  await reauth.locator('input[type="password"]').fill(commander.password);
  await reauth.locator('input[autocomplete="one-time-code"]').fill('123456');
  await reauth.getByRole('button', { name: '취소', exact: true }).click();
  await expect(reauth).toBeHidden();
  await expect(commanderPage.locator('section[aria-labelledby="kill-h"]')).toBeVisible();
  await commanderPage.locator('section[aria-labelledby="kill-h"]').getByRole('button', { name: '다시 인증하고 실행', exact: true }).click();
  await expect(reauth).toBeVisible();
  await expect(reauth.locator('input[type="password"]')).toHaveValue('');
  await expect(reauth.locator('input[autocomplete="one-time-code"]')).toHaveValue('');
  const storageHasSecret = await commanderPage.evaluate((password) => {
    const all = [document.cookie, JSON.stringify(localStorage), JSON.stringify(sessionStorage)].join('\n');
    return all.includes(password) || /eyJ[A-Za-z0-9_-]{10,}\./.test(all);
  }, commander.password);
  expect(storageHasSecret, '쿠키·저장소에 비밀번호나 JWT가 남았다').toBe(false);
  await reauth.getByRole('button', { name: '취소', exact: true }).click();
  await commanderPage.locator('section[aria-labelledby="kill-h"]').getByRole('button', { name: '취소', exact: true }).click();
});

test('OPS-390 B2 명령 3 dry-run 0.5초·재인증·ACKED·CSP', async () => {
  const eventId = eventOf();
  const reason = reasonOf('명령 3');
  await openCommands(commanderPage, eventId);
  await pickCommand(commanderPage, '명령 3');
  const dryPosted = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/command-dry-runs') && r.request().method() === 'POST', { timeout: 30_000 });
  const typedAt = Date.now();
  await fillReason(commanderPage, reason);
  const dryRes = await dryPosted;
  const dryElapsed = Date.now() - typedAt;
  expect(dryElapsed, `dry-run이 ${dryElapsed}ms 뒤에 왔다(0.5초 멈춤)`).toBeGreaterThanOrEqual(350);
  expect(dryElapsed, `dry-run이 ${dryElapsed}ms 뒤에 왔다(0.5초 멈춤)`).toBeLessThanOrEqual(2_000);
  const dry = await dryRes.json();
  expect(dryRes.status()).toBe(200);
  const panel = formSection(commanderPage).locator('section[aria-label="실행 전 모의 결과"]');
  await expect(panel).toContainText('보내기 전에 다시 인증합니다');
  await expect(panel).toContainText(dry.reauthRequired ? '보내기 전에 다시 인증합니다' : '승인 없이 바로 실행합니다');

  const posted = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/commands') && r.request().method() === 'POST', { timeout: 120_000 });
  await submitForm(commanderPage, '! 판매를 전면 중단합니다');
  await confirmKillSwitch(commanderPage, reason);
  await reauthenticate(commanderPage, commander);
  const created = await (await posted).json();
  expect(created.state).toBe('DISPATCHED');
  const acked = await waitServerState(commanderPage, created.commandId, ['ACKED', 'FAILED'], 15_000);
  expect(acked.state).toBe('ACKED');
  await expect(card(commanderPage)).toContainText('적용 확인', { timeout: 20_000 });
  await expect(card(commanderPage)).toContainText('판매 일시정지를 1인 실행으로 걸었습니다');
  await expect(card(commanderPage)).toContainText('까지 사후 검토 보고서를 써야 합니다');
  await shot(commanderPage, '02-command3-acked.png');

  const security = await commanderSecurity();
  expect(security.violations, `CSP·Trusted Types 위반: ${JSON.stringify(security.violations)}`).toEqual([]);
  const allowed = new Set(['peaket', 'peaket-webpack-host', 'peaket-webpack-queue', 'peaket-webpack-purchase', 'peaket-remote', 'default']);
  expect(security.names.filter((n) => !allowed.has(n)), `목록 밖 Trusted Types 정책: ${security.names.join(',')}`).toEqual([]);
});

test('OPS-390 B3 명령 6 요청·승인·반려·요청자 차단·승인 기한', async () => {
  const eventId = eventOf();

  // ① 요청 → PENDING_APPROVAL, 승인 기한 카운트다운, 요청자 본인 차단
  const rejectReason = reasonOf('명령 6 반려');
  await openCommands(commanderPage, eventId);
  await pickCommand(commanderPage, '명령 6');
  await formSection(commanderPage).getByLabel('보낼 결제사').selectOption('TOSS');
  await fillReason(commanderPage, rejectReason);
  const posted1 = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/commands') && r.request().method() === 'POST', { timeout: 120_000 });
  await submitForm(commanderPage, '전환 요청');
  await reauthenticate(commanderPage, commander);
  const first = await (await posted1).json();
  expect(first.state).toBe('PENDING_APPROVAL');
  await expect(card(commanderPage)).toContainText('승인 대기');
  await expect(card(commanderPage)).toContainText(/남은 시간 \d+:\d{2}/);
  await expect(card(commanderPage).getByRole('button', { name: '승인', exact: true })).toHaveCount(0);
  await expect(card(commanderPage)).toContainText('요청자 본인은 승인할 수 없습니다');
  await shot(commanderPage, '03-command6-pending-requester.png');

  // 휴대폰(320px)에서도 작성 카드는 없고 승인 단추는 있다(계획 §9·§10)
  await operatorPage.setViewportSize({ width: 320, height: 640 });
  await openCommands(operatorPage, eventId);
  await selectCommand(operatorPage, rejectReason);
  const phoneApprove = card(operatorPage).getByRole('button', { name: '승인', exact: true });
  await phoneApprove.scrollIntoViewIfNeeded();
  await expect(phoneApprove).toBeVisible();
  await expect(formSection(operatorPage)).toHaveCount(0);
  const phoneWidth = await operatorPage.evaluate(() => ({ inner: window.innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(phoneWidth.doc, `320px 승인 카드 문서 너비 ${phoneWidth.doc} > ${phoneWidth.inner}`).toBeLessThanOrEqual(phoneWidth.inner + 1);
  expect(phoneWidth.body, `320px 승인 카드 본문 너비 ${phoneWidth.body} > ${phoneWidth.inner}`).toBeLessThanOrEqual(phoneWidth.inner + 1);
  await shot(operatorPage, '03b-320-approve.png');
  await operatorPage.setViewportSize({ width: 1440, height: 900 });

  // operator가 반려한다(반려는 재인증 없음)
  await openCommands(operatorPage, eventId);
  await selectCommand(operatorPage, rejectReason);
  await expect(card(operatorPage)).toContainText('승인 대기');
  await expect(card(operatorPage)).toContainText(/남은 시간 \d+:\d{2}/);
  await card(operatorPage).getByRole('button', { name: '반려', exact: true }).click();
  await operatorPage.locator('#reject-reason').fill('시험 무대에서 반려 경로를 확인합니다');
  await operatorPage.getByRole('button', { name: '반려 확정', exact: true }).click();
  await expect(card(operatorPage)).toContainText('거부되었거나 승인 대기 10분이 지나 취소되었습니다', { timeout: 20_000 });
  await expect(card(commanderPage)).toContainText('거부되었거나 승인 대기 10분이 지나 취소되었습니다', { timeout: 20_000 });
  await shot(operatorPage, '04-command6-rejected.png');

  // ② 다시 요청 → operator 재인증 승인 → 두 콘솔 ACKED
  const approveReason = reasonOf('명령 6 승인');
  await openCommands(commanderPage, eventId);
  await pickCommand(commanderPage, '명령 6');
  await formSection(commanderPage).getByLabel('보낼 결제사').selectOption('TOSS');
  await fillReason(commanderPage, approveReason);
  const posted2 = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/commands') && r.request().method() === 'POST', { timeout: 120_000 });
  await submitForm(commanderPage, '전환 요청');
  await reauthenticate(commanderPage, commander);
  const second = await (await posted2).json();
  expect(second.state).toBe('PENDING_APPROVAL');
  await openCommands(operatorPage, eventId);
  await selectCommand(operatorPage, approveReason);
  const approved = operatorPage.waitForResponse((r) => r.url().endsWith('/approvals') && r.request().method() === 'POST', { timeout: 120_000 });
  await card(operatorPage).getByRole('button', { name: '승인', exact: true }).click();
  await reauthenticate(operatorPage, operator);
  expect((await approved).status()).toBe(200);
  const acked = await waitServerState(commanderPage, second.commandId, ['ACKED', 'FAILED'], 15_000);
  expect(acked.state).toBe('ACKED');
  await expect(card(commanderPage)).toContainText('적용 확인', { timeout: 20_000 });
  await expect(card(operatorPage)).toContainText('적용 확인', { timeout: 20_000 });
  // 명령 6 되돌리기는 commander·재인증 1인이라 operator 카드에는 단추가 없다
  await expect(card(operatorPage).getByRole('button', { name: 'Degraded 모두 해제', exact: true })).toHaveCount(0);
  await shot(operatorPage, '05-command6-acked-operator.png');
});

test('OPS-390 B4 명령 1 dry-run은 서버 원천이 없어 세지 못함을 그리고 0을 지어내지 않는다', async () => {
  const eventId = eventOf();
  const reason = reasonOf('명령 1');
  await openCommands(commanderPage, eventId);
  await pickCommand(commanderPage, '명령 1');
  await formSection(commanderPage).getByLabel('새 동시 입장 목표(명)').fill('3000');
  const dryPosted = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/command-dry-runs') && r.request().method() === 'POST', { timeout: 30_000 });
  await fillReason(commanderPage, reason);
  const dry = await (await dryPosted).json();
  const panel = formSection(commanderPage).locator('section[aria-label="실행 전 모의 결과"]');
  await expect(panel).toBeVisible();
  // BAT-365 센 값 원천 미연결: predicted 0, unavailable만 온다. 화면은 서버 응답 그대로 '세지 못함'을 그린다
  expect(dry.predicted ?? []).toEqual([]);
  expect(dry.unavailable?.length ?? 0).toBeGreaterThan(0);
  await expect(panel).toContainText('세지 못한 값');
  await expect(panel).not.toContainText('예측 값(식으로 계산한 값)');
  for (const u of dry.unavailable ?? []) await expect(panel).toContainText(`${u.key}: 세지 못함 · ${u.reason}`);
  await shot(commanderPage, '06-command1-dryrun-unavailable.png');

  const posted = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/commands') && r.request().method() === 'POST', { timeout: 60_000 });
  await submitForm(commanderPage, '보내기');
  const created = await (await posted).json();
  await waitServerState(commanderPage, created.commandId, ['ACKED'], 15_000);
  await expect(card(commanderPage)).toContainText('적용 확인', { timeout: 20_000 });
  const revertPosted = commanderPage.waitForResponse((r) => r.url().endsWith('/reversions') && r.request().method() === 'POST', { timeout: 60_000 });
  await card(commanderPage).getByRole('button', { name: '자동 조절로 되돌리기', exact: true }).click();
  await commanderPage.locator('#revert-reason').fill('브라우저 확인: 자동 조절로 돌아갑니다');
  await commanderPage.getByRole('button', { name: '되돌리기', exact: true }).click();
  expect((await revertPosted).status()).toBe(200);
  await expect(card(commanderPage)).toContainText('되돌림 · 이전 상태로 돌아갔습니다', { timeout: 20_000 });
});

test('OPS-390 B5 320px·768px에서 명령 화면이 가로 스크롤 없이 닿는다', async () => {
  const eventId = eventOf();
  const page = commanderPage;
  await page.setViewportSize({ width: 320, height: 640 });
  await openCommands(page, eventId);
  await page.waitForTimeout(700);
  const phone = await page.evaluate(() => ({
    inner: window.innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    wide: [...document.querySelectorAll('body *')].flatMap((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > window.innerWidth + 1
        ? [{ tag: e.tagName, cls: String(e.className ?? '').slice(0, 60), right: Math.round(r.right), width: Math.round(r.width), text: (e.innerText || '').trim().slice(0, 80) }]
        : [];
    }).slice(0, 12),
    overflowing: [...document.querySelectorAll('*')].flatMap((e) => {
      const cs = getComputedStyle(e);
      return e.scrollWidth > e.clientWidth + 1
        ? [{ tag: e.tagName, cls: String(e.className ?? '').slice(0, 60), sw: e.scrollWidth, cw: e.clientWidth, min: cs.minWidth, pos: cs.position, text: (e.innerText || '').trim().slice(0, 60) }]
        : [];
    }).slice(0, 12),
    bodyChildren: [...document.body.children].map((e) => ({ tag: e.tagName, cls: String(e.className ?? '').slice(0, 60), sw: e.scrollWidth, cw: e.clientWidth, right: Math.round(e.getBoundingClientRect().right) })),
  }));
  expect(phone.doc, `320px 문서 너비 ${phone.doc} > ${phone.inner} · 넓은 요소 ${JSON.stringify(phone.wide)} · 넘치는 상자 ${JSON.stringify(phone.overflowing)} · body 자식 ${JSON.stringify(phone.bodyChildren)}`).toBeLessThanOrEqual(phone.inner + 1);
  expect(phone.body, `320px 본문 너비 ${phone.body} > ${phone.inner}`).toBeLessThanOrEqual(phone.inner + 1);
  await expect(page.locator('section[aria-labelledby="h-catalog"]')).toContainText('명령 요청과 실행은 태블릿이나 데스크톱에서 합니다');
  await expect(formSection(page)).toHaveCount(0);
  await shot(page, '07-320-phone.png');

  await page.setViewportSize({ width: 768, height: 1024 });
  await openCommands(page, eventId);
  const tablet = await page.evaluate(() => ({ inner: window.innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(tablet.doc, `768px 문서 너비 ${tablet.doc} > ${tablet.inner}`).toBeLessThanOrEqual(tablet.inner + 1);
  expect(tablet.body, `768px 본문 너비 ${tablet.body} > ${tablet.inner}`).toBeLessThanOrEqual(tablet.inner + 1);
  await pickCommand(page, '명령 3');
  await expect(formSection(page)).toBeVisible();
  await expect(formSection(page).locator('#cmd-form-reason')).toBeVisible();
  const formWidth = await page.evaluate(() => ({ inner: window.innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(formWidth.doc, `768px 폼 문서 너비 ${formWidth.doc} > ${formWidth.inner}`).toBeLessThanOrEqual(formWidth.inner + 1);
  expect(formWidth.body, `768px 폼 본문 너비 ${formWidth.body} > ${formWidth.inner}`).toBeLessThanOrEqual(formWidth.inner + 1);
  await shot(page, '08-768-tablet-form.png');
});
