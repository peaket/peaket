// F-03-4 실제 서버 화면 시험 T13~T16(계획 §8). 단언 값은 정본(control-tower §3·§4·§6·§12, d5 §7.3, openapi 설명)에서 온다.
// 무대: console-commands/stage.mjs — 받는 쪽 넷(bundle) 한 프로세스, identity-svc·ops-svc 실제 프로세스, 운영 빌드 콘솔 미리보기.
// 두 콘솔은 브라우저 문맥 둘(쿠키 둘)이다. 재인증은 비밀번호·TOTP를 화면에 넣고 패스키는 Chromium 가상 인증기가 답한다.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { installPasskey, signIn, trackSecurity } from './accounts.mjs';
import { restartOps, stageStatus, storesOf } from './stage-client.mjs';
import {
  card,
  confirmKillSwitch,
  fillReason,
  formSection,
  openCommands,
  pickCommand,
  postJson,
  reauthenticate,
  selectCommand,
  submitForm,
  waitServerState,
} from './ui.mjs';

let status;
let commander;
let operator;
let commanderContext;
let operatorContext;
let commanderPage;
let operatorPage;
let commanderSecurity;
let operatorSecurity;

const eventOf = () => randomUUID().toLowerCase();
const reasonOf = (tag) => `F-03-4 ${tag} ${randomUUID()}`;

test.beforeAll(async ({ browser }) => {
  status = await stageStatus();
  commander = status.accounts.commander;
  operator = status.accounts.operator;
  commanderContext = await browser.newContext();
  commanderPage = await commanderContext.newPage();
  commanderSecurity = await trackSecurity(commanderPage);
  await signIn(commanderPage, commander, status.previewUrl);
  await installPasskey(commanderPage, commander);
  operatorContext = await browser.newContext();
  operatorPage = await operatorContext.newPage();
  operatorSecurity = await trackSecurity(operatorPage);
  await signIn(operatorPage, operator, status.previewUrl);
  await installPasskey(operatorPage, operator);
});

test.afterAll(async () => {
  await commanderContext?.close();
  await operatorContext?.close();
});

/** 2인 문맥에서 그 사유의 명령 상세 카드를 연다 */
async function select(page, reason) {
  await selectCommand(page, reason);
}

test('F-03-4 T13 C-T46 ①-1 실제 서버로 commander가 재인증해 명령 3(이 회차)을 내면 승인 대기 없이 서버 3초·카드 2초 안에 ACKED이고 받는 쪽 넷이 판매 일시정지다', async () => {
  const eventId = eventOf();
  const reason = reasonOf('T13 킬스위치');
  await openCommands(commanderPage, eventId);
  await pickCommand(commanderPage, '명령 3');
  await fillReason(commanderPage, reason);

  const posted = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/commands') && r.request().method() === 'POST', { timeout: 120_000 });
  await submitForm(commanderPage, '! 판매를 전면 중단합니다');
  await confirmKillSwitch(commanderPage, reason);
  await reauthenticate(commanderPage, commander);
  const response = await posted;
  const created = await response.json();
  expect(response.status(), JSON.stringify(created)).toBe(201);
  // 명령 3은 commander 1인 실행이라 승인 대기(PENDING_APPROVAL) 없이 바로 DISPATCHED다(ADR-0095)
  expect(created.state).toBe('DISPATCHED');
  const t0 = Date.now();

  const acked = await waitServerState(commanderPage, created.commandId, ['ACKED', 'FAILED'], 15_000);
  expect(acked.state, JSON.stringify(acked.body)).toBe('ACKED');
  expect(acked.at - t0, `서버 ACKED까지 ${acked.at - t0}ms(정본 p99 3초)`).toBeLessThanOrEqual(3_000);

  // 서버 ACKED를 본 뒤 2초 안에 카드가 '적용 확인'이 된다
  const cardDue = acked.at + 2_000;
  await expect(card(commanderPage)).toContainText('적용 확인', { timeout: Math.max(500, cardDue - Date.now() + 250) });
  expect(Date.now(), '카드가 서버 ACKED 뒤 2초를 넘겼다').toBeLessThanOrEqual(cardDue + 500);
  await expect(card(commanderPage)).toContainText('판매 일시정지를 1인 실행으로 걸었습니다');
  await expect(card(commanderPage)).toContainText('까지 사후 검토 보고서를 써야 합니다');

  const stores = await storesOf(eventId, created.commandId);
  expect(stores.purchase, JSON.stringify(stores)).toMatch(/^t\|/);
  for (const [name, hash] of [
    ['좌석 Redis s:{event:E}:ctl', stores.seat],
    ['queue-svc q:{event:E}:notice', stores.queueNotice],
    ['admission-ctrl q:{event:E}:ctl', stores.admission],
  ]) {
    expect(hash.paused, `${name} paused`).toBe('1');
    expect(hash.pausedCmd, `${name} pausedCmd`).toBe(created.commandId);
  }
  const rev = stores.seat.pausedRev;
  expect(stores.queueNotice.pausedRev).toBe(rev);
  expect(stores.admission.pausedRev).toBe(rev);

  const security = await commanderSecurity();
  expect(security.violations, `CSP·Trusted Types 위반: ${JSON.stringify(security.violations)}`).toEqual([]);
});

test('F-03-4 T14 C-T46 ③-1·④-5 실제 서버로 operator의 명령 3과 재인증 없는 commander의 명령 3은 403이고, 판매 재개는 REVERT_PENDING 뒤 operator 재인증 승인으로 두 콘솔 모두 REVERTED다', async () => {
  const eventId = eventOf();
  const reason = reasonOf('T14 킬스위치');

  // operator 콘솔: 명령 3 단추가 막혀 있고 이유 글이 늘 보인다(d5 §7.3 CMP-036 disabled)
  await openCommands(operatorPage, eventId);
  await pickCommand(operatorPage, '명령 3');
  const blocked = formSection(operatorPage).getByRole('button', { name: '! 판매를 전면 중단합니다', exact: true });
  await expect(blocked).toHaveAttribute('aria-disabled', 'true');
  const describedBy = await blocked.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  await expect(operatorPage.locator(`#${describedBy}`)).toHaveText('판매 일시정지는 commander만 실행할 수 있습니다');
  let operatorPosts = 0;
  const countPost = (r) => {
    if (r.url().endsWith('/v1/ops/commands') && r.method() === 'POST') operatorPosts += 1;
  };
  operatorPage.on('request', countPost);
  // d5는 aria-disabled(초점은 받는다)라 실제 누름을 받는다. Playwright는 aria-disabled를 기본으로 막으므로 force로 누른다
  await blocked.click({ force: true });
  await operatorPage.waitForTimeout(700);
  operatorPage.off('request', countPost);
  expect(operatorPosts, '막힌 단추를 눌렀는데 요청이 나갔다').toBe(0);

  // operator 쿠키·신원으로 같은 본문을 직접 보내면 403(서버가 막는다)
  const operatorDirect = await postJson(operatorPage, '/v1/ops/commands', {
    type: 'KILL_SWITCH',
    reason: 'operator 직접 접수(시험)',
    params: { scope: 'EVENT', eventIds: [eventId] },
  });
  expect(operatorDirect.status).toBe(403);
  expect(String(operatorDirect.body?.type)).toContain('command-role-forbidden');

  // commander가 실제로 명령 3을 낸다
  await openCommands(commanderPage, eventId);
  await pickCommand(commanderPage, '명령 3');
  await fillReason(commanderPage, reason);
  const posted = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/commands') && r.request().method() === 'POST', { timeout: 120_000 });
  await submitForm(commanderPage, '! 판매를 전면 중단합니다');
  await confirmKillSwitch(commanderPage, reason);
  await reauthenticate(commanderPage, commander);
  const created = await (await posted).json();
  await waitServerState(commanderPage, created.commandId, ['ACKED'], 15_000);

  // 재인증 없는 commander도 403(위험 명령의 접수는 재인증 토큰이 필요하다, control-tower §3)
  const commanderDirect = await postJson(commanderPage, '/v1/ops/commands', {
    type: 'KILL_SWITCH',
    reason: 'commander 재인증 없이 접수(시험)',
    params: { scope: 'EVENT', eventIds: [eventId] },
  });
  expect(commanderDirect.status).toBe(403);
  expect(String(commanderDirect.body?.type)).toContain('reauth-required');

  // commander가 판매 재개를 요청한다(재인증, 사유 필수) → 202 REVERT_PENDING
  await select(commanderPage, reason);
  await expect(card(commanderPage)).toContainText('적용 확인');
  const revertPosted = commanderPage.waitForResponse((r) => r.url().endsWith('/reversions') && r.request().method() === 'POST', { timeout: 120_000 });
  await commanderPage.getByRole('button', { name: '판매 재개 요청', exact: true }).click();
  await commanderPage.locator('#revert-reason').fill('결제사 승인 응답이 정상으로 돌아왔습니다(시험)');
  await commanderPage.getByRole('button', { name: '다시 인증하고 요청', exact: true }).click();
  await reauthenticate(commanderPage, commander);
  const revertedPending = await (await revertPosted).json();
  expect(revertedPending.state).toBe('REVERT_PENDING');
  await expect(card(commanderPage)).toContainText('재개 승인을 기다립니다');
  // 요청자 본인에게는 승인 단추가 없다(openapi canApprove=false)
  await expect(card(commanderPage).getByRole('button', { name: '재개 승인', exact: true })).toHaveCount(0);
  await expect(card(commanderPage)).toContainText('요청자 본인은 승인할 수 없습니다');

  // operator 콘솔에서 재인증해 승인한다 → 두 콘솔 모두 REVERTED
  await openCommands(operatorPage, eventId);
  await select(operatorPage, reason);
  await expect(card(operatorPage)).toContainText('재개 승인을 기다립니다');
  const approvalPosted = operatorPage.waitForResponse((r) => r.url().endsWith('/approvals') && r.request().method() === 'POST', { timeout: 120_000 });
  await card(operatorPage).getByRole('button', { name: '재개 승인', exact: true }).click();
  await reauthenticate(operatorPage, operator);
  expect((await approvalPosted).status()).toBe(200);
  await expect(card(commanderPage)).toContainText('되돌림 · 이전 상태로 돌아갔습니다', { timeout: 20_000 });
  await expect(card(operatorPage)).toContainText('되돌림 · 이전 상태로 돌아갔습니다', { timeout: 20_000 });

  const stores = await storesOf(eventId, created.commandId);
  expect(stores.purchase, JSON.stringify(stores)).toMatch(/^f\|/);
  for (const [name, hash] of [
    ['좌석 Redis s:{event:E}:ctl', stores.seat],
    ['queue-svc q:{event:E}:notice', stores.queueNotice],
    ['admission-ctrl q:{event:E}:ctl', stores.admission],
  ]) {
    expect(hash.paused, `${name} paused`).toBe('0');
  }
});

test('F-03-4 T15 ① 실제 서버로 명령 6(이 회차, toPg) 요청 → operator 재인증 승인 → 두 콘솔 ACKED, 되돌리기 → REVERTED', async () => {
  const eventId = eventOf();
  const reason = reasonOf('T15 결제사 전환');

  await openCommands(commanderPage, eventId);
  await pickCommand(commanderPage, '명령 6');
  await expect(formSection(commanderPage).getByLabel('이 회차')).toBeChecked();
  await formSection(commanderPage).getByLabel('보낼 결제사').selectOption('TOSS');
  await fillReason(commanderPage, reason);
  const posted = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/commands') && r.request().method() === 'POST', { timeout: 120_000 });
  await submitForm(commanderPage, '전환 요청');
  await reauthenticate(commanderPage, commander);
  const created = await (await posted).json();
  expect(created.state).toBe('PENDING_APPROVAL');
  await expect(card(commanderPage)).toContainText('승인 대기');
  await expect(card(commanderPage).getByRole('button', { name: '승인', exact: true })).toHaveCount(0);
  await expect(card(commanderPage)).toContainText('요청자 본인은 승인할 수 없습니다');

  await openCommands(operatorPage, eventId);
  await select(operatorPage, reason);
  await expect(card(operatorPage)).toContainText('승인 대기');
  const approvalPosted = operatorPage.waitForResponse((r) => r.url().endsWith('/approvals') && r.request().method() === 'POST', { timeout: 120_000 });
  await card(operatorPage).getByRole('button', { name: '승인', exact: true }).click();
  await reauthenticate(operatorPage, operator);
  expect((await approvalPosted).status()).toBe(200);
  await waitServerState(commanderPage, created.commandId, ['ACKED', 'FAILED'], 15_000);
  await expect(card(commanderPage)).toContainText('적용 확인', { timeout: 20_000 });
  await expect(card(operatorPage)).toContainText('적용 확인', { timeout: 20_000 });

  // 되돌리기(Degraded 모두 해제): commander 1인·재인증 → REVERTED
  await select(commanderPage, reason);
  const revertPosted = commanderPage.waitForResponse((r) => r.url().endsWith('/reversions') && r.request().method() === 'POST', { timeout: 120_000 });
  await card(commanderPage).getByRole('button', { name: 'Degraded 모두 해제', exact: true }).click();
  await commanderPage.locator('#revert-reason').fill('결제사 응답이 정상으로 돌아와 전환을 해제합니다(시험)');
  await commanderPage.getByRole('button', { name: '다시 인증하고 해제', exact: true }).click();
  await reauthenticate(commanderPage, commander);
  expect((await revertPosted).status()).toBe(200);
  await expect(card(commanderPage)).toContainText('되돌림 · 이전 상태로 돌아갔습니다', { timeout: 20_000 });
  await expect(card(operatorPage)).toContainText('되돌림 · 이전 상태로 돌아갔습니다', { timeout: 20_000 });

  const stores = await storesOf(eventId, created.commandId);
  expect(stores.payment, JSON.stringify(stores)).toMatch(/^f\|/);
});

test('F-03-4 T15 ② 실제 서버로 명령 1 dry-run 응답과 화면이 같고, 보내면 ACKED → 되돌리기 REVERTED', async () => {
  const eventId = eventOf();
  const reason = reasonOf('T15 목표 조정');

  await openCommands(commanderPage, eventId);
  await pickCommand(commanderPage, '명령 1');
  await formSection(commanderPage).getByLabel('새 동시 입장 목표(명)').fill('3000');
  const dryRunPosted = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/command-dry-runs') && r.request().method() === 'POST', { timeout: 60_000 });
  await fillReason(commanderPage, reason);
  const dryResponse = await dryRunPosted;
  const dry = await dryResponse.json();
  expect(dryResponse.status(), JSON.stringify(dry)).toBe(200);
  // 작성 폼 안의 판만 본다(열린 명령 카드의 '접수 때 본 실행 전 모의'에도 같은 판이 있다)
  const panel = formSection(commanderPage).locator('section[aria-label="실행 전 모의 결과"]');
  await expect(panel).toBeVisible();
  // 서버 값은 openapi 그대로 NONE·ONE·TWO다. 화면은 d5 §7.3의 글이다
  const approvalKey = { NONE: 'none', ONE: 'one', TWO: 'two' }[dry.approvalMode] ?? 'two';
  const approvalText = { none: '승인 없이 바로 실행합니다(commander 1인)', one: '1인 실행입니다', two: '2인 승인입니다(요청자가 아닌 운영자가 승인해야 실행됩니다)' }[approvalKey];
  expect(approvalText, `approvalMode ${dry.approvalMode}`).toBeTruthy();
  await expect(panel).toContainText(approvalText);
  if (dry.reauthRequired) await expect(panel).toContainText('보내기 전에 다시 인증합니다');
  else await expect(panel).not.toContainText('보내기 전에 다시 인증합니다');

  // 서버가 준 예측 줄을 화면이 값·식·넣은 값·가정과 함께 그대로 그린다. 센 값과 세지 못한 값도 서버 응답 그대로다.
  if (dry.predicted.length > 0) {
    await expect(panel).toContainText('예측 값(식으로 계산한 값)');
    for (const p of dry.predicted) {
      await expect(panel).toContainText(p.key);
      await expect(panel).toContainText(p.value.toLocaleString('ko-KR'));
      await expect(panel).toContainText(`식: ${p.formula}`);
      for (const [k, v] of Object.entries(p.inputs)) await expect(panel).toContainText(`${k} ${v.toLocaleString('ko-KR')}`);
      for (const a of p.assumptions) await expect(panel).toContainText(a);
    }
  } else {
    // 무대의 ops-svc에는 BAT-365 센 값 원천이 아직 연결되지 않아 예측을 만들 수 없다(계획 '시험 결과'의 남은 위험).
    // 화면은 0이나 빈 숫자를 지어내지 않고 서버의 '세지 못함'만 그린다.
    await expect(panel).not.toContainText('예측 값(식으로 계산한 값)');
    expect(dry.unavailable.length).toBeGreaterThan(0);
    await expect(panel).toContainText('세지 못한 값');
    for (const u of dry.unavailable) await expect(panel).toContainText(`${u.key}: 세지 못함 · ${u.reason}`);
  }
  if (dry.counted.length > 0) {
    for (const c of dry.counted) await expect(panel).toContainText(`${c.key}: ${c.value.toLocaleString('ko-KR')}`);
  }
  for (const [k, v] of Object.entries(dry.limits)) await expect(panel).toContainText(`${k} ${v.toLocaleString('ko-KR')}`);

  const posted = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/commands') && r.request().method() === 'POST', { timeout: 60_000 });
  await submitForm(commanderPage, '보내기');
  const created = await (await posted).json();
  await waitServerState(commanderPage, created.commandId, ['ACKED', 'FAILED'], 15_000);
  await expect(card(commanderPage)).toContainText('적용 확인', { timeout: 20_000 });

  // 명령 1 되돌리기는 1인·재인증 없음(직전 값 복원 = 자동 조절로 돌아가기)
  const revertPosted = commanderPage.waitForResponse((r) => r.url().endsWith('/reversions') && r.request().method() === 'POST', { timeout: 60_000 });
  await card(commanderPage).getByRole('button', { name: '자동 조절로 되돌리기', exact: true }).click();
  await commanderPage.locator('#revert-reason').fill('자동 조절로 돌아갑니다(시험)');
  await commanderPage.getByRole('button', { name: '되돌리기', exact: true }).click();
  expect((await revertPosted).status()).toBe(200);
  await expect(card(commanderPage)).toContainText('되돌림 · 이전 상태로 돌아갔습니다', { timeout: 20_000 });
});

test('F-03-4 T16 C-T7 ②-9 실제 서버로 닿지 않는 받는 곳 하나에 3초 전파 지연과 그 이름, 10초 실패와 [다시 시도], 주소를 뺀 뒤 다시 시도하면 ACKED다', async () => {
  const good = `127.0.0.1:${status.ports.bundle.admissionControl}`;
  const dead = '127.0.0.1:1';
  const eventId = eventOf();
  const reason = reasonOf('T16 전파 지연');
  try {
    await restartOps({ admissionAddrs: [good, dead] });
    await openCommands(commanderPage, eventId);
    await pickCommand(commanderPage, '명령 1');
    await formSection(commanderPage).getByLabel('새 동시 입장 목표(명)').fill('2500');
    await fillReason(commanderPage, reason);
    const posted = commanderPage.waitForResponse((r) => r.url().endsWith('/v1/ops/commands') && r.request().method() === 'POST', { timeout: 60_000 });
    await submitForm(commanderPage, '보내기');
    const created = await (await posted).json();
    const t0 = Date.now();

    await expect(card(commanderPage)).toContainText('전파가 늦어지고 있습니다', { timeout: 8_000 });
    const delayedAt = Date.now();
    await expect(card(commanderPage)).toContainText(dead);
    expect(delayedAt - t0, `전파 지연 표시까지 ${delayedAt - t0}ms`).toBeGreaterThanOrEqual(2_500);
    expect(delayedAt - t0, `전파 지연 표시까지 ${delayedAt - t0}ms`).toBeLessThanOrEqual(6_000);

    await expect(card(commanderPage)).toContainText('전파에 실패했습니다', { timeout: 15_000 });
    const failedAt = Date.now();
    await expect(card(commanderPage)).toContainText(dead);
    await expect(card(commanderPage).getByRole('button', { name: '다시 시도', exact: true })).toBeVisible();
    expect(failedAt - t0, `실패 표시까지 ${failedAt - t0}ms(정본 ack 시한 10초)`).toBeGreaterThanOrEqual(9_000);
    expect(failedAt - t0, `실패 표시까지 ${failedAt - t0}ms`).toBeLessThanOrEqual(16_000);

    // 닿지 않는 주소를 뺀 무대로 다시 세우고 [다시 시도] → ACKED
    await restartOps({ admissionAddrs: [good] });
    const retried = commanderPage.waitForResponse((r) => r.url().endsWith('/retries') && r.request().method() === 'POST', { timeout: 60_000 });
    await card(commanderPage).getByRole('button', { name: '다시 시도', exact: true }).click();
    const retryResponse = await retried;
    expect(retryResponse.status()).toBe(200);
    const acked = await waitServerState(commanderPage, created.commandId, ['ACKED', 'FAILED'], 15_000);
    expect(acked.state).toBe('ACKED');
    await expect(card(commanderPage)).toContainText('적용 확인', { timeout: 20_000 });
  } finally {
    await restartOps({ admissionAddrs: [good] }).catch(() => undefined);
  }
});
