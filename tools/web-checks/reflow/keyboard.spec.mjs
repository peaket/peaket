// FE-T18 자동 몫: 초점 가림(WCAG 2.4.11, docs/frontend.md §5.11 '초점이 가려지지 않게'·§5.17 '화면 매트릭스와 FE-T31·FE-T18 자동 몫의 세부',
// docs/design/d4-handoff-checklist.md #22). 같은 화면에서 Tab으로 초점을 옮길 때마다 초점 요소 상자가 position fixed·sticky인
// 다른 요소의 상자에 완전히 덮이면 실패다. 320×256과 기본 폭에서 돈다.
// BAT-170 웨이브 7: 시험 담당(l2w7-BAT170-test)이 구현(셸 scroll-padding) 전에 썼다(ADR-0270 결정 3). 실행은 웨이브 끝 무거운 게이트(계획 §7).
// BAT-171(계획 §3 T2, 정할 것 3): 시험 담당(l2-bat171-test)이 구현 뒤에 더했다(ADR-0281 결정 3).
// - 고정 띠의 스크롤 여백은 띠가 지금 그려진 실제 높이 이상이고(같으면 통과, 1px 모자라면 실패), 위아래 띠와 여백을 빼고도 보이는 높이가 남는다
// - 보이는 높이 320px 이하면 소비자 웹의 위아래 고정 띠를 흐름에 두고 여백을 0으로, 321px 이상은 고정한다(경계 양쪽, docs/frontend.md §5.11)
// - 화면 열기(탭 저장소 값, 좌석 화면의 응답 대역과 좌석맵 예외 상자 확인)는 reflow.spec과 같은 open.mjs다(빈 결과가 통과로 새지 않게)
import { test, expect } from '@playwright/test';
import { stubFanApi } from '../csp/pages.mjs';
import { openReflowPage } from './open.mjs';
import { REFLOW_PAGES, TEXT_SPACING_CSS, obscuredFocusFindings, stickyInsetFindings } from './rules.mjs';

/** Tab을 이만큼까지 누른다(처음 초점으로 돌아오면 멈춘다) [가정] */
const MAX_TABS = 80;
/** 띠가 있어야 하는 화면: 공연 상세의 섹션 바로가기 띠(위)·하단 예매 띠(아래, lg 미만)(docs/frontend.md §5.11, d5 §5.2) */
const DETAIL = /^(\/en)?\/events\/[^/]+$/;

test.beforeEach(async ({ page }) => {
  await stubFanApi(page);
});

/** 지금 초점 요소 상자와, 그 요소를 품지 않는 fixed·sticky 요소들의 상자(뷰포트 좌표) */
const focusStep = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const box = (e, id) => {
      const r = e.getBoundingClientRect();
      return { id, left: r.left, top: r.top, width: r.width, height: r.height };
    };
    const label = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.split(/\s+/).slice(0, 2).join('.')}` : ''}`;
    const fixed = [];
    for (const f of document.querySelectorAll('body *')) {
      if (f === el || f.contains(el) || el.contains(f)) continue;
      const cs = getComputedStyle(f);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const b = box(f, label(f));
      if (b.width > 0 && b.height > 0) fixed.push(b);
    }
    return { target: box(el, `${label(el)} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`), fixed };
  });

/**
 * 화면 위·아래 끝에 붙은 고정 띠(position sticky·fixed이고 top 또는 bottom이 0, 문서 폭의 절반 이상, 조작 요소를 품는다)의 그려진 높이와
 * 문서의 계산된 scroll-padding-top·bottom. 잰 띠에는 data-fet18-band를 달아 둔다(폭·높이를 바꾼 뒤 같은 띠를 다시 본다).
 * 옆 패널(top이 0이 아님)·세로로 긴 옆 메뉴(폭이 좁음)·알림 자리(조작 요소 없음)는 띠가 아니다
 */
const measureBands = (page) =>
  page.evaluate(() => {
    const controls = 'a[href],button,input:not([type="hidden"]),select,textarea,[tabindex]';
    const cw = document.documentElement.clientWidth;
    const label = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${e.getAttribute('aria-label') ? `[${e.getAttribute('aria-label')}]` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.split(/\s+/).slice(0, 3).join('.')}` : ''}`;
    const bands = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (!(r.height > 0) || r.width < cw / 2 || !el.querySelector(controls)) continue;
      const edge = cs.top === '0px' ? 'top' : cs.bottom === '0px' ? 'bottom' : null;
      if (!edge) continue;
      el.setAttribute('data-fet18-band', edge);
      bands.push({ id: label(el), edge, height: r.height });
    }
    const html = getComputedStyle(document.documentElement);
    const px = (v) => (v.endsWith('px') ? Number.parseFloat(v) : 0);
    return {
      bands,
      padding: { top: px(html.scrollPaddingTop), bottom: px(html.scrollPaddingBottom) },
      raw: { top: html.scrollPaddingTop, bottom: html.scrollPaddingBottom },
      viewportHeight: window.innerHeight,
    };
  });

/** 앞서 띠로 잰 요소(data-fet18-band)가 지금 흐름에 있는지: 위치·보임·안의 조작 요소 수 */
const markedBands = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-fet18-band]')].map((el) => {
      const cs = getComputedStyle(el);
      return {
        edge: el.getAttribute('data-fet18-band'),
        position: cs.position,
        visible: typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0,
        controls: el.querySelectorAll('a[href],button,input:not([type="hidden"]),select,textarea,[tabindex]').length,
      };
    }),
  );

/** 띠 높이가 ResizeObserver로 여백에 닿을 때까지 기다린 뒤 판정한다(마지막 잰 값을 메시지에 싣는다) */
async function expectInsetsCover(page, where) {
  let last;
  await expect
    .poll(
      async () => {
        last = await measureBands(page);
        return stickyInsetFindings(last);
      },
      { timeout: 5_000, message: `${where}: 고정 띠의 스크롤 여백이 띠의 실제 높이보다 작거나 남는 높이가 없다` },
    )
    .toEqual([]);
  return last;
}

for (const p of REFLOW_PAGES) {
  for (const size of ['320', '기본 폭']) {
    test(`FE-T18 ${p.app} ${p.locale} ${p.path} ${size}: Tab으로 옮긴 초점이 고정 머리·하단 바에 다 가려지지 않는다`, async ({ page }) => {
      expect(await openReflowPage(page, p), '도착 경로가 다르다(빈 결과)').toBe(p.path);
      await page.evaluate(() => window.scrollTo(0, 0));
      const steps = [];
      let first;
      for (let i = 0; i < MAX_TABS; i++) {
        await page.keyboard.press('Tab');
        const id = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          if (!el.dataset.fet18) el.dataset.fet18 = String(Math.random()).slice(2);
          return el.dataset.fet18;
        });
        if (id === null) continue;
        if (id === first) break;
        first ??= id;
        const s = await focusStep(page);
        if (s) steps.push(s);
      }
      expect(steps.length, 'Tab으로 초점을 받은 요소가 없다(빈 결과)').toBeGreaterThan(0);
      expect(obscuredFocusFindings(steps), '고정 요소에 다 가려진 초점').toEqual([]);
    });
  }

  // T2: 기본 폭(데스크톱)에서 띠마다 여백 ≥ 그려진 높이. 공연 상세는 섹션 바로가기 띠가 위에 붙어야 한다(띠 0개는 빈 결과)
  test(`FE-T18 ${p.app} ${p.locale} ${p.path} 기본 폭: 고정 띠의 스크롤 여백이 띠의 실제 높이 이상이다`, async ({ page }) => {
    const finalPath = await openReflowPage(page, p);
    expect(finalPath, '도착 경로가 다르다(빈 결과)').toBe(p.path);
    const m = await expectInsetsCover(page, `${p.app}${p.path} 기본 폭`);
    if (DETAIL.test(p.path)) expect(m.bands.filter((b) => b.edge === 'top'), `${p.path} 위에 붙는 띠(섹션 바로가기)가 없다(빈 결과)`).not.toEqual([]);
  });

  // 정할 것 3(docs/frontend.md §5.11 '낮은 화면에서는 고정을 푼다'): 경계 321px(고정)·320px(풀림) 양쪽. 소비자 웹만이다.
  // 폭·높이를 바꾸며 같은 화면을 다시 잰다: 640×400 → 320×321(안내 글 줄바꿈으로 아래 띠가 높아진다) → 320×320 → 320×321
  if (p.app !== 'web') continue;
  test(`FE-T18 ${p.app} ${p.locale} ${p.path} 320: 보이는 높이 321px은 띠를 붙이고 여백이 띠의 실제 높이 이상이며, 320px은 띠를 흐름에 두고 여백이 0이다`, async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 400 });
    const finalPath = await openReflowPage(page, p);
    expect(finalPath, '도착 경로가 다르다(빈 결과)').toBe(p.path);
    await expectInsetsCover(page, `${p.path} 640×400`);

    // 321px: 고정(경계 바로 위). 폭이 좁아져 띠가 높아지면 여백도 다시 따라와야 한다
    await page.setViewportSize({ width: 320, height: 321 });
    const stuck = await expectInsetsCover(page, `${p.path} 320×321`);
    if (DETAIL.test(p.path)) {
      expect(stuck.bands.filter((b) => b.edge === 'top'), `${p.path} 321px에서 위에 붙는 띠(섹션 바로가기)가 없다(빈 결과)`).not.toEqual([]);
      expect(stuck.bands.filter((b) => b.edge === 'bottom'), `${p.path} 321px에서 아래에 붙는 띠(하단 예매)가 없다(빈 결과)`).not.toEqual([]);
    }
    const marked = (await markedBands(page)).length;

    // 320px: 풀림(경계). 앞서 붙어 있던 띠는 흐름에 있고 보이며 버튼·링크를 그대로 품는다. 붙은 띠는 없고 여백은 0이다
    await page.setViewportSize({ width: 320, height: 320 });
    let released;
    await expect
      .poll(
        async () => {
          released = await measureBands(page);
          const bands = await markedBands(page);
          return { bands: released.bands, raw: released.raw, stillFixed: bands.filter((b) => b.position === 'sticky' || b.position === 'fixed').map((b) => b.edge) };
        },
        { timeout: 5_000, message: `${p.path} 320×320에서 고정 띠가 흐름에 있지 않거나 스크롤 여백이 0이 아니다` },
      )
      .toEqual({ bands: [], raw: { top: '0px', bottom: '0px' }, stillFixed: [] });
    const flowed = await markedBands(page);
    expect(flowed.length, '앞서 잰 띠가 사라졌다').toBe(marked);
    for (const b of flowed) {
      expect(b.visible, `${b.edge} 띠가 흐름에서 보이지 않는다`).toBe(true);
      expect(b.controls, `${b.edge} 띠 안의 버튼·링크가 없다`).toBeGreaterThan(0);
    }

    // 다시 321px: 다시 붙고 여백이 띠를 덮는다
    await page.setViewportSize({ width: 320, height: 321 });
    const again = await expectInsetsCover(page, `${p.path} 320×321(다시)`);
    expect(again.bands.length, `${p.path} 321px로 돌아온 뒤 띠 수가 다르다`).toBe(stuck.bands.length);
  });

  // BAT-171 리뷰 R171-3 재현(Role: review-fix, 시험 담당 l2-bat171-test). 기준 docs/frontend.md §5.11 '초점이 가려지지 않게',
  // docs/design/d5-screen-blueprint.md §5.2 '낮은 화면': 320px 이하에서 흐름에 둔 하단 띠는 본문 main의 끝, 셸 바닥글 앞이다(DOM 순서도 같다)
  if (!DETAIL.test(p.path)) continue;
  test(`FE-T18 ${p.app} ${p.locale} ${p.path} 320: 보이는 높이 320px에서 흐름에 둔 하단 띠는 main의 끝, 바닥글 앞에 있다`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 321 });
    expect(await openReflowPage(page, p), '도착 경로가 다르다(빈 결과)').toBe(p.path);
    // 321px에서 아래에 붙은 띠를 표시해 둔다(그 띠를 320px에서 찾는다)
    const stuck = await expectInsetsCover(page, `${p.path} 320×321`);
    expect(stuck.bands.filter((b) => b.edge === 'bottom'), `${p.path} 321px에서 아래에 붙는 띠(하단 예매)가 없다(빈 결과)`).not.toEqual([]);
    await page.setViewportSize({ width: 320, height: 320 });
    await expect.poll(async () => (await markedBands(page)).filter((b) => b.edge === 'bottom').map((b) => b.position), { timeout: 5_000, message: '320px에서 하단 띠가 흐름에 있지 않다' }).not.toContain('sticky');
    const place = await page.evaluate(() => {
      const bar = document.querySelector('[data-fet18-band="bottom"]');
      const main = document.querySelector('main');
      const footer = [...document.querySelectorAll('footer, [role="contentinfo"]')].find((f) => !f.closest('main')) ?? null;
      const shown = (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0) && el.getBoundingClientRect().height > 0;
      if (!bar || !main) return { bar: !!bar, main: !!main };
      const docTop = (el) => el.getBoundingClientRect().top + window.scrollY;
      const docBottom = (el) => el.getBoundingClientRect().bottom + window.scrollY;
      // main 안에서 띠 뒤(DOM 순서)에 오는 보이는 내용(띠 안쪽은 뺀다)
      const after = [...main.querySelectorAll('*')].filter((el) => !bar.contains(el) && !el.contains(bar) && bar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && shown(el) && (el.textContent ?? '').trim() !== '');
      return {
        bar: true,
        main: true,
        inMain: main.contains(bar),
        footer: !!footer,
        beforeFooterInDom: !!footer && !!(bar.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING),
        aboveFooter: !!footer && docBottom(bar) <= docTop(footer) + 1,
        after: after.slice(0, 5).map((el) => `${el.tagName.toLowerCase()} ${(el.textContent ?? '').trim().slice(0, 30)}`),
      };
    });
    expect(place, `${p.path} 320×320 하단 띠 자리`).toEqual({ bar: true, main: true, inMain: true, footer: true, beforeFooterInDom: true, aboveFooter: true, after: [] });
  });
}

// BAT-171 리뷰 R171-2 재현(Role: review-fix, 시험 담당 l2-bat171-test). 기준 docs/frontend.md §5.11 '초점이 가려지지 않게'(높이는 띠가 지금 그려진 실제 높이,
// 박아 둔 여백이 띠보다 작으면 결함). 화면 목록 밖이지만 하단 띠를 가진 소비자 웹 화면(굿즈 상세·가입 동의·예매 취소, 화면 목록의 예시 주소)을 321px 높이의
// 좁은 폭에서 연다. 글자 간격(WCAG 1.4.12)을 더하면 띠가 높아지고 여백도 따라와야 한다. 결제 화면은 운영 빌드에서 홀드를 만들 길이 없어 rules.test의 소스 검사가 본다
const BAR_PAGES = [
  { app: 'web', locale: 'ko', path: '/shop/gds-lumen-lightstick' },
  { app: 'web', locale: 'ko', path: '/signup/consent' },
  { app: 'web', locale: 'ko', path: '/my/tickets/tkt-lumen-r1-0313/cancel' },
];
for (const p of BAR_PAGES) {
  test(`FE-T18 ${p.app} ${p.locale} ${p.path} 320: 하단 띠의 스크롤 여백이 띠의 실제 높이 이상이다(높이 321px, 글자 간격 전후)`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 321 });
    expect(await openReflowPage(page, p), '도착 경로가 다르다(빈 결과)').toBe(p.path);
    const plain = await expectInsetsCover(page, `${p.path} 320×321`);
    expect(plain.bands.filter((b) => b.edge === 'bottom'), `${p.path} 아래에 붙는 띠가 없다(빈 결과)`).not.toEqual([]);
    await page.evaluate((css) => {
      const sheet = new CSSStyleSheet();
      for (const rule of css.split('}').map((r) => r.trim()).filter(Boolean)) sheet.insertRule(`${rule}}`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }, TEXT_SPACING_CSS);
    expect(await page.evaluate(() => getComputedStyle(document.body).letterSpacing), '글자 간격이 걸리지 않았다').not.toBe('normal');
    const spaced = await expectInsetsCover(page, `${p.path} 320×321 글자 간격`);
    expect(spaced.bands.filter((b) => b.edge === 'bottom'), `${p.path} 글자 간격 뒤 아래에 붙는 띠가 없다(빈 결과)`).not.toEqual([]);
  });
}

// BAT-178 T1·T2(계획 docs/review/plans/BAT-178.md §4·§5, Role: test). 기준 docs/frontend.md §5.11 '경로 바뀜·랜드마크',
// docs/design/d2-design-system.md CMP-065, NFR-020. 본문 바로가기(CMP-065)는 키보드로 초점을 받으면 화면에 보여야 하고(WCAG 2.4.7),
// 누르면 #main으로 초점이 옮겨져야 한다(WCAG 2.4.1). 지금 셸 셋은 sr-only의 clip: rect(0 0 0 0)이 초점 때 풀리지 않아 T1이 실패한다.
// 화면 목록은 계획 §4: web은 WebShell, partner는 PartnerShell(/events)·AuthFrame(/login), console은 ConsoleShell(/dashboard).
const SKIP_LINK_PAGES = [
  { app: 'web', locale: 'ko', path: '/' },
  { app: 'web', locale: 'ko', path: '/my/tickets' },
  { app: 'partner', locale: 'ko', path: '/events' },
  { app: 'partner', locale: 'ko', path: '/login' },
  { app: 'console', locale: 'ko', path: '/dashboard' },
];

/** 글 '본문 바로가기'를 담은 a[href="#main"](CMP-065) 하나 */
const skipLink = (page) => page.locator('a[href="#main"]', { hasText: '본문 바로가기' }).first();

/**
 * 본문 바로가기의 지금 모양: 계산된 clip·clip-path, 그려진 상자(뷰포트 좌표), 상자 가운데 점의 맨 위 요소.
 * clip은 키트 .sr-only(clip: rect(...))와 Tailwind not-sr-only가 엇갈리는 곳이고, 가운데 점 적중은 덮인 요소를 잡는다
 */
const skipLinkState = (page) =>
  page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href="#main"]')].filter((a) => (a.textContent ?? '').trim() === '본문 바로가기');
    if (links.length === 0) return { count: 0 };
    const link = links[0];
    const cs = getComputedStyle(link);
    const r = link.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const label = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.split(/\s+/).slice(0, 2).join('.')}` : ''}`;
    return {
      count: links.length,
      clip: cs.clip,
      clipPath: cs.clipPath,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      hit: !!hit && (hit === link || link.contains(hit)),
      hitLabel: hit ? label(hit) : null,
    };
  });

for (const p of SKIP_LINK_PAGES) {
  test(`FE-T18 T1 ${p.app} ${p.locale} ${p.path} 기본 폭: 본문 바로가기가 초점을 받으면 잘리지 않고 화면에 보인다`, async ({ page }) => {
    expect(await openReflowPage(page, p), '도착 경로가 다르다(빈 결과)').toBe(p.path);
    // 평소: 1×1로 잘려 화면을 가리지 않는다(.sr-only·.pk-skip-link:not(:focus)의 clip 규칙)
    const hidden = await skipLinkState(page);
    expect(hidden.count, '글 본문 바로가기를 담은 a[href="#main"]이 없다(빈 결과)').toBeGreaterThan(0);
    expect(hidden.clip, '초점 전에는 clip으로 잘려 있어야 한다(평소 숨김)').toMatch(/^rect\(/);
    // 초점: 클립이 풀리고, 그려진 상자가 1×1보다 크며, 뷰포트 안이고, 가운데 점이 링크다
    await skipLink(page).focus();
    const shown = await skipLinkState(page);
    expect(shown.clip, '초점을 받아도 clip이 풀리지 않았다(0×0으로 잘림)').toBe('auto');
    expect(['none', ''], `초점을 받아도 clip-path가 남아 있다(${shown.clipPath})`).toContain(shown.clipPath);
    expect(shown.rect.width, '그려진 폭이 1px 이하다').toBeGreaterThan(1);
    expect(shown.rect.height, '그려진 높이가 1px 이하다').toBeGreaterThan(1);
    expect(
      shown.rect.left >= 0 && shown.rect.top >= 0 && shown.rect.left + shown.rect.width <= shown.viewport.width && shown.rect.top + shown.rect.height <= shown.viewport.height,
      `그려진 상자가 뷰포트 밖이다(${JSON.stringify(shown.rect)} / ${JSON.stringify(shown.viewport)})`,
    ).toBe(true);
    expect(shown.hit, `상자 가운데 점이 링크가 아니라 ${shown.hitLabel}이다(가려짐)`).toBe(true);
  });

  test(`FE-T18 T2 ${p.app} ${p.locale} ${p.path} 기본 폭: 본문 바로가기를 누르면 초점이 #main으로 옮겨지고 본문이 보인다`, async ({ page }) => {
    expect(await openReflowPage(page, p), '도착 경로가 다르다(빈 결과)').toBe(p.path);
    const link = skipLink(page);
    await expect(link, '글 본문 바로가기를 담은 a[href="#main"]이 없다(빈 결과)').toHaveCount(1);
    await link.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => location.hash), { timeout: 5_000, message: 'Enter 뒤 location.hash가 #main이 아니다' }).toBe('#main');
    const after = await page.evaluate(() => {
      const main = document.getElementById('main');
      const el = document.activeElement;
      const r = main?.getBoundingClientRect() ?? null;
      // 첫 '보이는' h1: 화면 낭독기용 h1(.sr-only, 1×1)은 본문이 보이는지의 기준이 아니다(web /의 'PEAKET 홈')
      const heading = [...(main?.querySelectorAll('h1') ?? [])].find((x) => {
        const b = x.getBoundingClientRect();
        return b.width > 1 && b.height > 1;
      });
      const h = heading?.getBoundingClientRect() ?? null;
      const inView = (b) => b.bottom > 0 && b.top < window.innerHeight && b.right > 0 && b.left < window.innerWidth;
      return {
        active: el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` : null,
        isMain: !!main && el === main,
        tabIndex: main ? main.tabIndex : null,
        main: r && { top: r.top, bottom: r.bottom },
        mainTopInView: !!r && r.top >= -1 && r.top < window.innerHeight,
        mainBottomInView: !!r && r.bottom > 0,
        h1: h && { top: h.top, bottom: h.bottom },
        h1InView: !!h && inView(h),
      };
    });
    expect(after.isMain, `Enter 뒤 초점이 main이 아니라 ${after.active}에 있다`).toBe(true);
    expect(after.tabIndex, '#main의 tabIndex가 -1이 아니다').toBe(-1);
    expect(after.mainTopInView, `main의 위쪽 끝이 뷰포트 안에 없다(${JSON.stringify(after.main)})`).toBe(true);
    expect(after.mainBottomInView, 'main의 아래쪽 끝이 0보다 위에 있다').toBe(true);
    if (after.h1) expect(after.h1InView, `main의 첫 h1이 뷰포트와 겹치지 않는다(${JSON.stringify(after.h1)})`).toBe(true);
  });
}
