// F-03-4 실제 서버 화면 시험의 화면 조작 도우미. 글·단언 값은 정본(control-tower §3·§4·§6·§12, d5 §7.3)에서 온다.
import { expect } from '@playwright/test';
import { freshCode } from './accounts.mjs';

export const BASE = process.env.PEAKET_CONSOLE_COMMANDS_BASE ?? 'http://localhost:4280';
export const card = (page) => page.locator('article[aria-label^="명령 "]');
export const catalog = (page) => page.locator('section[aria-labelledby="h-catalog"]');
export const commandList = (page) => page.locator('section[aria-labelledby="h-cmd"]');
export const formSection = (page) => page.locator('section[aria-labelledby="h-form"]');
export const reauthDialog = (page) => page.locator('section[aria-labelledby="reauth-h"]');

export async function openCommands(page, eventId) {
  await page.goto(`${BASE}/commands?event=${eventId}`);
  await expect(catalog(page)).toBeVisible({ timeout: 30_000 });
  await expect(commandList(page)).toBeVisible();
}

/** 카탈로그에서 명령을 고른다. 카탈로그 단추 글('명령 1'·'명령 3'·'명령 6')로 찾는다 */
export async function pickCommand(page, no) {
  await catalog(page).locator('button', { hasText: no }).first().click();
  await expect(formSection(page)).toBeVisible();
}

export async function fillReason(page, reason) {
  await formSection(page).locator('#cmd-form-reason').fill(reason);
}

/** 작성 폼의 실행 단추(명령 3은 위험 확인 대화상자를 연다) */
export async function submitForm(page, label) {
  await formSection(page).getByRole('button', { name: label, exact: true }).click();
}

/** 위험 확인 대화상자(명령 3)의 사유를 채우고 실행을 누른다 */
export async function confirmKillSwitch(page, reason) {
  const dialog = page.locator('section[aria-labelledby="kill-h"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('#kill-reason').fill(reason);
  await dialog.getByRole('button', { name: '다시 인증하고 실행', exact: true }).click();
}

/** 재인증 대화상자를 채워 OPS_COMMAND 토큰을 받는다(패스키는 Chromium 가상 인증기가 답한다) */
export async function reauthenticate(page, account) {
  const dialog = reauthDialog(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText('admin');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 앞 시도의 오류 글이 남아 있으면 submit이 지울 때까지 기다린다(다음 시도의 성공을 오류로 읽지 않게)
    if (attempt > 0) await dialog.locator('[role="alert"]').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    await dialog.locator('input[type="password"]').fill(account.password);
    const code = await freshCode(account);
    await dialog.locator('input[autocomplete="one-time-code"]').fill(code);
    await dialog.getByRole('button', { name: '확인하고 계속', exact: true }).click();
    const hidden = dialog.waitFor({ state: 'hidden', timeout: 40_000 }).then(() => true, () => false);
    const failed = dialog.locator('[role="alert"]').waitFor({ state: 'visible', timeout: 40_000 }).then(() => false, () => true);
    if (await Promise.race([hidden, failed])) return;
    // 오류 응답이 끝나 단추가 다시 눌릴 때까지 기다린 뒤 글을 읽는다
    await expect(dialog.getByRole('button', { name: '확인하고 계속', exact: true })).toBeEnabled({ timeout: 10_000 });
    const message = await dialog.locator('[role="alert"]').innerText().catch(() => '');
    // 비밀번호·인증 앱 코드 오류는 다음 30초 칸에서 한 번만 다시 한다
    if (attempt < 2 && message.includes('인증 앱 코드')) continue;
    // 같은 계정의 재인증이 30초 안에 겹치면 서버가 admin-login-busy(429)로 막는다. 잠시 뒤 한 번 더 한다
    if (attempt < 2 && /다시 인증하지 못했습니다|잠시 뒤 다시/.test(message)) {
      await page.waitForTimeout(31_000);
      continue;
    }
    throw new Error(`재인증하지 못했다: ${message}`);
  }
  throw new Error('재인증하지 못했다');
}

/** 목록 검색으로 사유가 같은 명령을 골라 상세 카드를 연다 */
export async function selectCommand(page, reason) {
  await commandList(page).locator('input[aria-label="검색"]').fill(reason);
  const row = commandList(page).locator('li button', { hasText: reason });
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await row.click();
  await expect(card(page)).toContainText(reason, { timeout: 20_000 });
}

export async function waitCardText(page, text, timeout = 15_000) {
  await expect(card(page)).toContainText(text, { timeout });
}

export async function postJson(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const r = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { path, body },
  );
}

export async function getJson(page, path) {
  return page.evaluate(async (path) => {
    const r = await fetch(path, { credentials: 'include' });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, path);
}

/** 서버(REST)가 그 상태가 될 때까지 센다. 화면과 별개로 '서버 ACKED' 시각을 재는 데 쓴다 */
export async function waitServerState(page, commandId, wanted, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await getJson(page, `/v1/ops/commands/${commandId}`);
    if (r.status === 200 && wanted.includes(r.body?.state)) return { at: Date.now(), state: r.body.state, body: r.body };
    if (Date.now() > end) throw new Error(`명령 ${commandId}가 ${timeoutMs}ms 안에 ${wanted.join('/')}가 되지 않았다(지금 ${r.status} ${r.body?.state})`);
    await new Promise((res) => setTimeout(res, 100));
  }
}
