// @peaket/ds 부품 동작을 실제 브라우저(Chromium·WebKit·Firefox)에서 본다(FE-T18, docs/design/d2 §3.4·§3.6, BUILD_ORDER BAS-180).
// Storybook 정적 빌드의 이야기를 연다. 부품 속을 SEED 동작 부품으로 바꿔도(ADR-0192) 같은 동작을 지키는지 보는 시험이다.
import { test, expect } from '@playwright/test';
import { openStory } from './stories.mjs';

test.describe('FE-T18 CMP-001 이유 있는 비활성 버튼(d2 §3.6)', () => {
  test('초점은 받고, 누르기·Enter·Space·폼 제출은 막으며, 늘 보이는 이유 글을 aria-describedby로 잇고 SEED 비활성 표시(data-disabled)를 단다', async ({ page }) => {
    await openStory(page, 'cmp-001-button--reason-guard');
    const button = page.getByRole('button', { name: '결제하기' });
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).not.toHaveAttribute('disabled');
    await expect(button).toHaveAttribute('data-disabled', '');
    await expect(button).toHaveAccessibleDescription('필수 동의 두 개에 체크하면 결제할 수 있습니다');
    await expect(page.getByText('필수 동의 두 개에 체크하면 결제할 수 있습니다')).toBeVisible();
    // Playwright는 aria-disabled 요소를 누를 수 없는 것으로 보고 기다리므로, 확인 절차를 건너뛰고 실제로 누른다
    await button.click({ force: true });
    await button.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('clicks')).toHaveText('0');
    await expect(page.getByTestId('submits')).toHaveText('0');
  });

  test('이유 글을 화면의 다른 곳에 둔 버튼 여럿이 같은 글을 설명으로 읽는다', async ({ page }) => {
    await openStory(page, 'cmp-001-button--disabled-reason-elsewhere');
    for (const name of ['판매 일시정지', '대기열 다시 열기']) {
      const b = page.getByRole('button', { name });
      await expect(b).toHaveAttribute('aria-disabled', 'true');
      await expect(b).toHaveAccessibleDescription('판매 일시정지는 commander만 실행할 수 있습니다');
    }
  });

  test('loading 버튼은 aria-busy이고 누르기를 막는다(이유 있는 비활성이 아니라 aria-disabled는 없다)', async ({ page }) => {
    await openStory(page, 'cmp-001-button--loading');
    const b = page.getByRole('button', { name: '결제하는 중' });
    await expect(b).toHaveAttribute('aria-busy', 'true');
    await expect(b).not.toHaveAttribute('aria-disabled', 'true');
  });
});

test.describe('FE-T18 CMP-019 Dialog(d2 §3.4)', () => {
  test('열면 대화상자 안으로 초점이 가고, Tab·Shift+Tab이 안에서 돌며, 바깥 내용은 보조기기에서 숨는다', async ({ page }) => {
    await openStory(page, 'cmp-019-dialog--interactive');
    const opener = page.getByRole('button', { name: '대화상자 열기' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '좌석을 놓을까요?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleDescription('놓으면 다른 분이 고를 수 있습니다.');
    // 초점이 대화상자 안에 있다
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    // Tab을 여러 번 눌러도 밖으로 나가지 않는다(앞뒤 모두)
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    // 바깥 내용(연 버튼·바깥 버튼)은 접근성 트리에서 빠진다(aria-modal을 덜 지원하는 낭독기 대비, SEED hideOthers)
    await expect(page.getByRole('button', { name: '바깥 버튼' })).toHaveCount(0);
    await expect(page.locator('#outside')).toBeAttached();
    expect(await page.locator('#outside').evaluate((el) => el.closest('[aria-hidden="true"], [inert]') !== null)).toBe(true);
  });

  test('Esc로 닫히고 연 버튼으로 초점이 돌아오며, 바깥 숨김이 풀린다', async ({ page }) => {
    await openStory(page, 'cmp-019-dialog--interactive');
    const opener = page.getByRole('button', { name: '대화상자 열기' });
    // 키보드로 연다(WebKit은 마우스로 누른 버튼에 초점을 주지 않아, 되돌릴 초점이 처음부터 없다)
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('log')).toHaveText('닫힘');
    await expect(opener).toBeFocused();
    await expect(page.getByRole('button', { name: '바깥 버튼' })).toHaveCount(1);
  });

  test('바깥(어두운 막)을 누르면 닫힌다', async ({ page }) => {
    await openStory(page, 'cmp-019-dialog--interactive');
    await page.getByRole('button', { name: '대화상자 열기' }).click();
    const box = await page.getByRole('dialog').boundingBox();
    // 대화상자 위쪽 바깥(막)을 누른다
    await page.mouse.click(box.x + box.width / 2, Math.max(2, box.y - 20));
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('열린 동안 바탕이 스크롤되지 않는다', async ({ page }) => {
    await openStory(page, 'cmp-019-dialog--interactive');
    await page.getByRole('button', { name: '대화상자 열기' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const overflow = await page.evaluate(() => getComputedStyle(document.documentElement).overflow + ' ' + getComputedStyle(document.body).overflow);
    expect(overflow).toContain('hidden');
  });

  test('dismissible이 거짓인 alertdialog는 Esc·바깥 누르기로 onClose를 부르지 않는다', async ({ page }) => {
    await openStory(page, 'cmp-019-dialog--alert-guard');
    const dialog = page.getByRole('alertdialog', { name: '결제 시간이 1분 남았습니다' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.click(4, 4);
    await expect(page.getByTestId('closes')).toHaveText('0');
    await expect(dialog).toBeVisible();
  });

  test('initialFocus로 준 요소에 열 때 초점이 가고, 닫으면 연 버튼으로 돌아온다', async ({ page }) => {
    await openStory(page, 'cmp-019-dialog--initial-focus');
    const opener = page.getByRole('button', { name: '환불 확인 열기' });
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '환불 요청' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});

test.describe('FE-T18 CMP-020 DangerConfirm ops(d2 §3.5)', () => {
  test('사유와 확인 문구가 맞기 전에는 결과 버튼이 이유 있는 비활성이고, 맞으면 풀린다', async ({ page }) => {
    await openStory(page, 'cmp-019-dialog--danger-ops');
    const dialog = page.getByRole('alertdialog', { name: '판매를 일시정지할까요?' });
    const confirm = dialog.getByRole('button', { name: '판매 일시정지' });
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await dialog.getByLabel('실행 사유').fill('결제사 장애로 일시정지');
    await dialog.getByRole('textbox').last().fill('LUMEN 1025');
    await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
  });
});

test.describe('FE-T18 CMP-030 Tabs', () => {
  test('화살표로 다음 탭으로 가고(막힌 탭은 건너뛰고 끝에서 처음으로), 고른 탭만 Tab 차례에 든다', async ({ page }) => {
    await openStory(page, 'cmp-030-tabs--default');
    const first = page.getByRole('tab', { name: '공연 정보' });
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '출연진' })).toBeFocused();
    await expect(page.getByRole('tab', { name: '출연진' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveText('cast 내용');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(first).toBeFocused();
    await expect(page.locator('[role=tab][tabindex="0"]')).toHaveCount(1);
  });
});

test.describe('FE-T18 CMP-018 Toast', () => {
  test('띄운 알림은 알림 영역(role=status, aria-live=polite) 안에 나타난다', async ({ page }) => {
    await openStory(page, 'cmp-018-toast--live');
    await page.getByRole('button', { name: '찜하기' }).click();
    const region = page.getByRole('status');
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(region).toContainText('찜 목록에 담았습니다');
  });
});

test.describe('FE-T18 입력 부품의 이름·설명(d2 §3.1)', () => {
  test('TextField 오류는 aria-invalid와 오류 글·도움말 설명을 잇는다', async ({ page }) => {
    await openStory(page, 'cmp-004-textfield--invalid');
    const input = page.getByRole('textbox', { name: '이름' });
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAccessibleDescription(/이름이 너무 짧습니다/);
  });

  test('Checkbox는 라벨을 눌러도, Space로도 바뀐다', async ({ page }) => {
    await openStory(page, 'cmp-009-checkbox--unchecked');
    const cb = page.getByRole('checkbox', { name: '알림 받기' });
    await page.getByText('알림 받기').click();
    await expect(cb).toBeChecked();
    await cb.focus();
    await page.keyboard.press('Space');
    await expect(cb).not.toBeChecked();
  });

  test('Toggle은 switch 역할이고 Space로 바뀐다', async ({ page }) => {
    await openStory(page, 'cmp-011-toggle--off');
    const sw = page.getByRole('switch', { name: '판매 시작 알림' });
    await sw.focus();
    await page.keyboard.press('Space');
    await expect(sw).toBeChecked();
  });

  test('RadioGroup은 묶음 이름이 있고 화살표로 고른다(막힌 선택지는 건너뛴다)', async ({ page }) => {
    await openStory(page, 'cmp-010-radiogroup--vertical');
    const group = page.getByRole('group', { name: '결제 수단' });
    await expect(group).toBeVisible();
    await page.getByRole('radio', { name: '신용·체크카드' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /계좌 이체/ })).toBeChecked();
  });
});

// BAT-170 웨이브 7 T6: 시험 담당(l2w7-BAT170-test)이 썼다(ADR-0270 결정 3). 기준 docs/design/d4-handoff-checklist.md #25,
// docs/frontend.md §5.17 '화면 매트릭스와 FE-T31·FE-T18 자동 몫의 세부'의 붙여넣기(3.3.8): `123456`과 `123 456`을 한 번에 붙여넣어 값이 `123456`.
/**
 * 붙여넣기를 흉내 낸다: paste 사건(DataTransfer에 글)을 보내고, 부품이 막지 않았으면 브라우저 기본 동작처럼 글을 한 번에 넣는다.
 * 부품이 paste 처리기로 값을 정하든 입력 사건으로 거르든 같은 결과를 본다.
 */
async function paste(page, locator, text) {
  await locator.focus();
  const prevented = await locator.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    return !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  if (!prevented) await page.keyboard.insertText(text);
}

test.describe('FE-T18 접근 가능한 인증(3.3.8) 붙여넣기', () => {
  for (const text of ['123456', '123 456']) {
    test(`FE-T18 CMP-007 인증 앱 코드 여섯 자리를 한 번에 붙여넣으면 값이 여섯 숫자다(띄어 쓴 7글자 포함): '${text}'`, async ({ page }) => {
      await openStory(page, 'cmp-007-otpfield--paste');
      const input = page.getByRole('textbox', { name: '인증 앱 코드 6자리' });
      await expect(input).toHaveAttribute('autocomplete', 'one-time-code');
      await paste(page, input, text);
      await expect(input).toHaveValue('123456');
      // 부르는 쪽(onChange)이 받은 값도 같다
      await expect(page.getByTestId('otp-value')).toHaveText('123456');
    });
  }

  test('FE-T18 비밀번호 칸은 붙여넣기를 막지 않고 autocomplete가 current-password다', async ({ page }) => {
    await openStory(page, 'cmp-006-passwordfield--paste');
    const input = page.getByLabel('비밀번호', { exact: true });
    await expect(input).toHaveAttribute('autocomplete', 'current-password');
    const secret = 'Peaket-paste 2026!';
    await paste(page, input, secret);
    await expect(input).toHaveValue(secret);
    await expect(page.getByTestId('pw-length')).toHaveText(String(secret.length));
  });
});

// SR-T10 한글 조합 중 Enter(docs/features/search.md §3.4, :301 SR-T10, docs/frontend.md:1639. BAT-165 웨이브 7 T-20).
// isComposing이 참이거나 keyCode가 229인 keydown Enter를 합성해 보내고, 조합 없는 Enter(대조군)는 처리되는지 먼저 본다.
/** 입력 칸에 keydown Enter를 합성한다(keyCode는 사건 초기값으로 줄 수 없어 속성을 덮는다) */
async function enter(input, o) {
  await input.evaluate((el, opt) => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: opt.isComposing });
    if (opt.keyCode !== undefined) Object.defineProperty(ev, 'keyCode', { get: () => opt.keyCode });
    el.dispatchEvent(ev);
  }, o);
}

test.describe('SR-T10 검색창 한글 조합 중 키', () => {
  test('SR-T10 isComposing이 참이거나 keyCode 229인 Enter는 SearchField·WebSearchBox에서 검색을 보내지 않는다', async ({ page }) => {
    // SearchField: 창이 열리고 첫 후보를 고른 상태에서 Enter는 그 후보를 고른다
    await openStory(page, 'cmp-004-searchfield--ime-guard');
    const field = page.getByRole('combobox');
    await field.focus();
    await enter(field, { isComposing: true });
    await enter(field, { isComposing: false, keyCode: 229 });
    await expect(page.getByTestId('selects')).toHaveText('0');
    await expect(page.getByTestId('submits')).toHaveText('0');
    // 대조군: 조합 없는 Enter는 고른다
    await enter(field, { isComposing: false, keyCode: 13 });
    await expect(page.getByTestId('selects')).toHaveText('1');

    // WebSearchBox: Enter는 검색 화면으로 이동한다
    await openStory(page, 'cmp-004-websearchbox--ime-guard');
    const box = page.getByRole('combobox');
    await box.focus();
    await enter(box, { isComposing: true });
    await enter(box, { isComposing: false, keyCode: 229 });
    await expect(page.getByTestId('navigations')).toHaveText('0');
    await enter(box, { isComposing: false, keyCode: 13 });
    await expect(page.getByTestId('navigations')).toHaveText('1');
    await expect(page.getByTestId('last-href')).toHaveText(`/search?q=${encodeURIComponent('루멘')}`);
  });
});

// BC165-1(브라우저 확인 docs/review/browser-check/HOT-270-280.md): 입력이 있을 때 지우기 단추는 화면의 [검색어 지우기] 하나다(d5 §5.3 ①).
// type="search"의 브라우저 기본 지우기 단추(::-webkit-search-cancel-button)가 함께 보이면 둘이 된다.
test.describe('BC165-1 검색 입력칸의 지우기 단추', () => {
  test('검색 입력칸에 글자가 있어도 브라우저 기본 지우기 단추는 보이지 않고 화면의 지우기 단추 하나만 있다(SearchField·WebSearchBox, BC165-1)', async ({ page, browserName }) => {
    for (const id of ['cmp-004-searchfield--ime-guard', 'cmp-004-websearchbox--ime-guard']) {
      await openStory(page, id);
      const input = page.getByRole('combobox');
      // 대조군: 입력에 글자가 있다(기본 지우기 단추가 나올 조건)
      await expect(input).toHaveValue('루멘');
      await expect(input).toHaveAttribute('type', 'search');
      // 화면의 지우기 단추는 하나다
      await expect(page.getByRole('button', { name: '검색어 지우기', exact: true })).toHaveCount(1);
      // 브라우저 기본 지우기 단추(WebKit 계열의 의사 요소)는 숨는다. Firefox에는 그 의사 요소가 없다.
      // 의사 요소의 계산된 스타일은 엔진마다 믿을 수 없다(WebKit은 비워 주고, Chromium은 입력칸 자신의 display를 준다). 그래서 이 입력칸에 맞는
      // '::-webkit-search-cancel-button' 규칙이 숨기는지(display: none 또는 appearance: none) 스타일 시트에서 본다
      if (browserName !== 'firefox') {
        const shown = await input.evaluate((el) => {
          const display = getComputedStyle(el, '::-webkit-search-cancel-button').display;
          const hidingRules = [];
          const walk = (rules) => {
            for (const r of rules) {
              if (r.cssRules && !r.selectorText) walk(r.cssRules);
              if (!r.selectorText || !r.selectorText.includes('::-webkit-search-cancel-button')) continue;
              for (const sel of r.selectorText.split(',')) {
                if (!sel.includes('::-webkit-search-cancel-button')) continue;
                const host = sel.replace(/::-webkit-search-cancel-button/g, '').trim() || '*';
                let matches = false;
                try {
                  matches = el.matches(host);
                } catch {
                  matches = false;
                }
                const hides = r.style.display === 'none' || r.style.getPropertyValue('-webkit-appearance') === 'none' || r.style.getPropertyValue('appearance') === 'none';
                if (matches && hides) hidingRules.push(sel.trim());
              }
            }
          };
          for (const sheet of document.styleSheets) {
            try {
              walk(sheet.cssRules);
            } catch {
              // 다른 출처 스타일 시트는 읽지 못한다
            }
          }
          return { display, hidden: display === 'none' || hidingRules.length > 0 };
        });
        expect({ id, display: shown.display, hidden: shown.hidden }).toEqual({ id, display: shown.display, hidden: true });
      }
    }
  });
});
