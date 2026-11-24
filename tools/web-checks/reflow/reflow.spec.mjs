// FE-T31 재배치·확대·글자 간격 시험(docs/frontend.md §5.11·§5.17 FE-T31 행·'화면 매트릭스와 FE-T31·FE-T18 자동 몫의 세부', WCAG 1.4.10·1.4.4·1.4.12,
// docs/design/d4-handoff-checklist.md #18~#20). 운영 빌드의 주요 흐름을 연다.
// - 320×256(400% 확대): 예외 상자 밖 문서 가로 스크롤(scrollWidth > clientWidth + 1)과 닿기(모든 조작 요소에 닿는다)
// - 640×400(200% 확대): 글자 간격 없이 한 번, 글자 간격을 CSSOM으로 덮어쓴 뒤 한 번 잘림·겹침을 센다(CSP를 끄지 않는다)
// - 빈 결과(도착 경로가 다름·잰 글자 상자 0·조작 요소 0, 좌석 화면은 좌석맵 예외 상자 없음)는 실패다
// - 로그인·입장이 있어야 그리는 화면은 ?state= 미리보기 대신 항목의 탭 저장소 값을 먼저 넣고 연다(계획 §11 2)
// BAT-170 웨이브 7: 시험 담당(l2w7-BAT170-test)이 판정 구현 전에 고쳐 썼다(ADR-0270 결정 3). 실행은 웨이브 끝 무거운 게이트(계획 §7).
import { test, expect } from '@playwright/test';
import { stubFanApi } from '../csp/pages.mjs';
import { openReflowPage as open } from './open.mjs';
import { EXCEPTION_SELECTORS, REFLOW_PAGES, TEXT_SPACING_CSS, ancestorClipFindings, clippedTextFindings, emptyMeasurement, hasPageOverflow, overlapFindings, unreachableFindings } from './rules.mjs';

/** 화면 읽기용 숨김 글·장식은 재지 않는다 */
const IGNORE = '.sr-only,[aria-hidden="true"],[inert],svg,canvas';
/** 조작 요소(링크·버튼·입력 칸·선택 상자·tabindex 0 이상) */
const CONTROLS = 'a[href],button,input:not([type="hidden"]),select,textarea,[tabindex]';

/** GAT-340: CS 처리함·회차 취소 판정의 실제 화면(ConnectedPage)이 표·카드·2열 상자를 그리도록 최소 응답을 준다. 쓰기 동작은 부르지 않는다 */
const OPS_CASE_ID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const OPS_CANCEL_ID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e02';
async function stubOpsApi(page) {
  const cors = {
    'access-control-allow-origin': 'http://127.0.0.1:4103',
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, PATCH, POST, OPTIONS',
    'access-control-allow-headers': 'accept, content-type, if-match, idempotency-key, x-reauth-token',
  };
  await page.route('**/v1/ops/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const p = new URL(req.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { ...cors, 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    if (p === '/v1/ops/auth/sessions/me') return json({ adminAccountId: OPS_CASE_ID, role: 'commander', designations: [] });
    if (p === '/v1/ops/cases') return json({ items: [caseOf(OPS_CASE_ID)], nextCursor: null });
    if (p === `/v1/ops/cases/${OPS_CASE_ID}`) return json(caseOf(OPS_CASE_ID));
    if (p === '/v1/ops/event-cancellations') return json({ items: [{ requestId: OPS_CANCEL_ID, title: 'LUMEN 콘서트 2026 서울', status: 'REQUESTED', requestedAt: '2026-11-20T11:00:00.000Z' }] });
    if (p === `/v1/ops/event-cancellations/${OPS_CANCEL_ID}`) {
      return json({
        requestId: OPS_CANCEL_ID,
        eventId: OPS_CASE_ID,
        title: 'LUMEN 콘서트 2026 서울',
        kind: 'CANCEL',
        status: 'REQUESTED',
        fault: null,
        fanNoticeReason: null,
        partnerReason: '공연장 사정으로 취소합니다.',
        faultOpinion: 'ORGANIZER',
        evidenceRef: null,
        newStartsAt: null,
        requestedAt: '2026-11-20T11:00:00.000Z',
        judgedBy: null,
        judgedById: null,
        dryRun: null,
        progress: null,
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/problem+json', headers: cors, body: JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }) });
  });
}

const caseOf = (caseId) => ({
  caseId,
  kind: 'INQUIRY',
  targetRef: 'INQ-2026-11-0001',
  category: '일반 문의',
  status: 'OPEN',
  progressDueAt: '2026-11-24T09:00:00.000Z',
  resultDueAt: '2026-11-26T09:00:00.000Z',
  dueState: 'DUE_SOON',
  assignee: null,
  version: 1,
  createdAt: '2026-11-20T11:00:00.000Z',
  resolvedAt: null,
  resultNote: null,
});


test.beforeEach(async ({ page }) => {
  await stubFanApi(page);
  await stubOpsApi(page);
});

// 화면 열기(탭 저장소 값, 좌석 화면의 응답 대역과 좌석맵 예외 상자 확인)는 open.mjs가 한다(BAT-171 시험 이의 1: 좌석 화면이 '불러오지 못함'에 머물렀다)

/** 글자를 바로 담은 상자의 방향별 overflow·크기와 조작 요소 수(예외 상자 밖) */
const measureText = (page) =>
  page.evaluate(
    ({ exceptions, ignore, controls }) => {
      // 화면에서만 숨긴 글(docs/frontend.md §5.17 '판정'): 클래스 이름(.sr-only)만이 아니라 계산된 모양으로 본다. 반응형 숨김(max-lg:sr-only 등)도
      // 같은 모양이다(절대·고정 위치의 1×1 이하 상자이고 넘침을 숨기거나 잘라 낸다). BAT-171 시험 이의 4
      const screenOnly = (el) => {
        for (let a = el; a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
          const r = a.getBoundingClientRect();
          const cut = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowY === 'hidden' || cs.overflowY === 'clip' || cs.clipPath !== 'none' || (!!cs.clip && cs.clip !== 'auto');
          if (r.width <= 1 && r.height <= 1 && cut) return true;
        }
        return false;
      };
      const outside = (el) => !exceptions.some((sel) => el.closest(sel)) && !el.closest(ignore) && !screenOnly(el);
      const items = [];
      const clipped = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!outside(el)) continue;
        const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);
        if (!hasText) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        items.push({
          tag: el.tagName,
          cls: typeof el.className === 'string' ? el.className : '',
          text: true,
          overflowX: cs.overflowX,
          overflowY: cs.overflowY,
          textOverflow: cs.textOverflow,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
        // 넘침을 숨긴 조상이 자른 글(BAT-171 검증 V171-09e): 이 상자가 바로 담은 글 줄의 사각형과, 넘침을 숨긴 조상들의 안쪽(패딩) 상자
        const range = document.createRange();
        let text;
        for (const n of el.childNodes) {
          if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? '').trim()) continue;
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) {
            if (!(r.width > 0 && r.height > 0)) continue;
            text = text ? { left: Math.min(text.left, r.left), top: Math.min(text.top, r.top), right: Math.max(text.right, r.right), bottom: Math.max(text.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          }
        }
        const clips = [];
        for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
          if (exceptions.some((sel) => a.matches(sel))) break;
          const acs = getComputedStyle(a);
          const cut = (v) => v === 'hidden' || v === 'clip';
          if (!cut(acs.overflowX) && !cut(acs.overflowY)) continue;
          const ar = a.getBoundingClientRect();
          const left = ar.left + a.clientLeft;
          const top = ar.top + a.clientTop;
          clips.push({
            id: `${a.tagName.toLowerCase()}${typeof a.className === 'string' && a.className ? `.${a.className.split(/\s+/).slice(0, 3).join('.')}` : ''}`,
            overflowX: acs.overflowX,
            overflowY: acs.overflowY,
            textOverflow: acs.textOverflow,
            lineClamp: acs.webkitLineClamp || acs.getPropertyValue('-webkit-line-clamp') || 'none',
            left,
            top,
            right: left + a.clientWidth,
            bottom: top + a.clientHeight,
          });
        }
        if (text && clips.length > 0) clipped.push({ id: `${el.tagName.toLowerCase()} ${(el.textContent ?? '').trim().slice(0, 40)}`, text, clips });
      }
      const controlCount = [...document.querySelectorAll(controls)].filter(outside).length;
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, items, clipped, controlCount };
    },
    { exceptions: EXCEPTION_SELECTORS, ignore: IGNORE, controls: CONTROLS },
  );

/** 닿기: 예외 상자 밖에서 보이는 조작 요소마다 가운데로 굴린 뒤 상자와 가운데 점의 맨 위 요소를 잰다 */
const measureReach = (page) =>
  page.evaluate(
    async ({ exceptions, ignore, controls }) => {
      // 화면에서만 숨긴 글(docs/frontend.md §5.17 '판정'): 클래스 이름(.sr-only)만이 아니라 계산된 모양으로 본다. 반응형 숨김(max-lg:sr-only 등)도
      // 같은 모양이다(절대·고정 위치의 1×1 이하 상자이고 넘침을 숨기거나 잘라 낸다). BAT-171 시험 이의 4
      const screenOnly = (el) => {
        for (let a = el; a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
          const r = a.getBoundingClientRect();
          const cut = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowY === 'hidden' || cs.overflowY === 'clip' || cs.clipPath !== 'none' || (!!cs.clip && cs.clip !== 'auto');
          if (r.width <= 1 && r.height <= 1 && cut) return true;
        }
        return false;
      };
      const outside = (el) => !exceptions.some((sel) => el.closest(sel)) && !el.closest(ignore) && !screenOnly(el);
      const visible = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0;
      };
      const tabbable = (el) => !el.hasAttribute('tabindex') || Number(el.getAttribute('tabindex')) >= 0;
      const out = [];
      const all = [...document.querySelectorAll(controls)].filter((el) => outside(el) && tabbable(el) && visible(el));
      for (const [i, el] of all.entries()) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out.push({
          id: `${i}:${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`,
          left: r.left + window.scrollX,
          right: r.right + window.scrollX,
          width: r.width,
          height: r.height,
          hit: !!top && (top === el || el.contains(top)),
        });
      }
      return { items: out, clientWidth: document.documentElement.clientWidth };
    },
    { exceptions: EXCEPTION_SELECTORS, ignore: IGNORE, controls: CONTROLS },
  );

/**
 * 겹침 재기(계획 §13 V13-2, docs/frontend.md §5.17 '판정'): 예외 상자 밖에서 보이는 글자 노드마다 줄 사각형(Range.getClientRects, 문서 좌표).
 * 맨 위 스크롤에서 잰다(고정·sticky 글이 스크롤하며 포개지는 것은 초점 가림이 본다)
 */
const measureTextRects = (page) =>
  page.evaluate(
    ({ exceptions, ignore }) => {
      window.scrollTo(0, 0);
      // 화면에서만 숨긴 글(docs/frontend.md §5.17 '판정'): 클래스 이름(.sr-only)만이 아니라 계산된 모양으로 본다. 반응형 숨김(max-lg:sr-only 등)도
      // 같은 모양이다(절대·고정 위치의 1×1 이하 상자이고 넘침을 숨기거나 잘라 낸다). BAT-171 시험 이의 4
      const screenOnly = (el) => {
        for (let a = el; a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
          const r = a.getBoundingClientRect();
          const cut = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowY === 'hidden' || cs.overflowY === 'clip' || cs.clipPath !== 'none' || (!!cs.clip && cs.clip !== 'auto');
          if (r.width <= 1 && r.height <= 1 && cut) return true;
        }
        return false;
      };
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let i = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || !(n.textContent ?? '').trim()) continue;
        if (exceptions.some((sel) => el.closest(sel)) || el.closest(ignore) || screenOnly(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || (typeof el.checkVisibility === 'function' && !el.checkVisibility())) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const node = i++;
        for (const r of range.getClientRects()) {
          if (r.width > 0 && r.height > 0) out.push({ node, left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height });
        }
      }
      return out;
    },
    { exceptions: EXCEPTION_SELECTORS, ignore: IGNORE },
  );

/** WCAG 1.4.12 글자 간격을 CSSOM으로 더한다(CSP를 끄지 않는다) */
const applyTextSpacing = (page) =>
  page.evaluate((css) => {
    const sheet = new CSSStyleSheet();
    for (const rule of css.split('}').map((r) => r.trim()).filter(Boolean)) sheet.insertRule(`${rule}}`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, TEXT_SPACING_CSS);

test('FE-T31 화면 목록 320: 소비자 웹·파트너·관제마다 한 화면 이상', () => {
  for (const app of ['web', 'partner', 'console']) expect(REFLOW_PAGES.filter((p) => p.app === app).length, app).toBeGreaterThan(0);
});

/** GAT-340(F-05-8) CS 화면 넷: 태블릿 768에서 2열이고 문서 가로 스크롤이 없다(휴대폰 1열은 320 시험이 본다) */
test('FE-T31 console CS 768: CS 처리함·승인 업무·회차 취소 판정·팬 조회가 2열이고 문서 가로 스크롤 0', async ({ page }) => {
  const paths = ['/cs/inbox', '/cs/approvals', '/cancellations/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e02', '/customers'];
  for (const path of paths) {
    const finalPath = await open(page, { app: 'console', locale: 'ko', path });
    expect(finalPath, `${path} 도착 경로`).toBe(path);
    const text = await measureText(page);
    expect(hasPageOverflow(text), `${path} 문서 가로 스크롤 ${text.scrollWidth} > ${text.clientWidth}`).toBe(false);
    const cols = await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-cs-two-col]')) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (!(r.width > 0 && r.height > 0) || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const tracks = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
        return { tracks, value: cs.gridTemplateColumns };
      }
      return null;
    });
    expect(cols, `${path} 2열 상자가 보이지 않는다`).not.toBeNull();
    expect(cols.tracks, `${path} 열 수: ${cols.value}`).toBe(2);
  }
});

for (const p of REFLOW_PAGES) {
  const name = `${p.app} ${p.locale} ${p.path}`;

  test(`FE-T31 ${name} 320: 예외 밖 문서 가로 스크롤 0, 모든 조작 요소에 닿는다`, async ({ page }) => {
    const finalPath = await open(page, p);
    const text = await measureText(page);
    const empty = emptyMeasurement({ requestedPath: p.path, finalPath, textCount: text.items.length, controlCount: text.controlCount });
    expect(empty, `${name} 빈 결과`).toBeNull();
    expect(hasPageOverflow(text), `${name} 문서 가로 스크롤 ${text.scrollWidth} > ${text.clientWidth}`).toBe(false);
    const reach = await measureReach(page);
    expect(reach.items.length, `${name} 잰 조작 요소`).toBeGreaterThan(0);
    expect(unreachableFindings(reach.items, reach.clientWidth), `${name} 닿지 않는 조작 요소`).toEqual([]);
  });

  test(`FE-T31 ${name} 640: 글자 잘림·겹침 0`, async ({ page }) => {
    const finalPath = await open(page, p);
    const text = await measureText(page);
    expect(emptyMeasurement({ requestedPath: p.path, finalPath, textCount: text.items.length, controlCount: text.controlCount }), `${name} 빈 결과`).toBeNull();
    expect(clippedTextFindings(text.items), `${name} 글자 잘림`).toEqual([]);
    expect(ancestorClipFindings(text.clipped), `${name} 넘침을 숨긴 조상이 자른 글`).toEqual([]);
    const rects = await measureTextRects(page);
    expect(rects.length, `${name} 잰 글자 노드가 없다(빈 결과)`).toBeGreaterThan(0);
    expect(overlapFindings(rects), `${name} 글자 겹침`).toEqual([]);
  });

  test(`FE-T31 ${name} 640 글자 간격: 글자 잘림·겹침 0`, async ({ page }) => {
    const finalPath = await open(page, p);
    await applyTextSpacing(page);
    // 덮어쓴 규칙이 실제로 걸렸는지(걸리지 않으면 간격 없는 화면을 두 번 잰 것이 된다)
    expect(await page.evaluate(() => getComputedStyle(document.body).letterSpacing), `${name} 글자 간격이 걸리지 않았다`).not.toBe('normal');
    const text = await measureText(page);
    expect(emptyMeasurement({ requestedPath: p.path, finalPath, textCount: text.items.length, controlCount: text.controlCount }), `${name} 빈 결과`).toBeNull();
    expect(clippedTextFindings(text.items), `${name} 글자 잘림(글자 간격)`).toEqual([]);
    expect(ancestorClipFindings(text.clipped), `${name} 넘침을 숨긴 조상이 자른 글(글자 간격)`).toEqual([]);
    const rects = await measureTextRects(page);
    expect(rects.length, `${name} 잰 글자 노드가 없다(빈 결과)`).toBeGreaterThan(0);
    expect(overlapFindings(rects), `${name} 글자 겹침(글자 간격)`).toEqual([]);
  });
}
