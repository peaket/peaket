// FE-T41 공연 설명 편집기를 실제 위저드(/events/new)에서 본다(BUILD_ORDER HOT-185, ADR-0204, ADR-0247, docs/design/d2 CMP-070, asvs/catalog-review 1.3.1).
// ① 묶음 B CSP·Trusted Types 보고 모드에서 편집기가 낸 위반 0 ② Word·웹 페이지 글(표·그림·스타일·스크립트)을 붙여넣고 임시저장한 구조 문서에
// 허용 노드 다섯 밖 노드·속성 0 ③ 저장한 글이 편집기 화면과 같고, 새로고침하면 그대로 돌아온다 ④ 늦게 싣는 덩어리(gzip) 90KB 이하(ADR-0204)
// ⑤ 키보드(굵게 단축키, 도구 막대 방향키)와 역할(textbox·toolbar). 잰 값은 reports/rich-text.json에 남는다.
// Next.js가 늦게 싣는 덩어리를 <script src>로 넣는 Trusted Types 위반은 편집기와 상관없어 따로 센다(관제·파트너 콘솔 보안 헤더 OPS-340에 넘김).
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** 늦게 싣는 덩어리 예산(gzip). docs/frontend.md §5.6 표, FE-T41로 확정(ADR-0204) */
const BUDGET_KB = 90;
const OUT = 'reports/rich-text.json';
const DRAFT_KEY = 'peaket.partner.wizard-draft.v1';
/** Next.js가 늦게 싣는 덩어리를 <script src>로 넣는 것(편집기와 상관없는 프레임워크 몫, 따로 센다) */
const isFramework = (v) => v.directive === 'require-trusted-types-for' && /^HTMLScriptElement src\|\/_next\/static\/chunks\//.test(v.sample);

/** Word에서 복사한 글을 흉내 낸 HTML(Office 꼬리표·스타일·표·그림·스크립트·이벤트 속성) */
const WORD_HTML = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{color:red}</style></head><body>
<h1 class="MsoTitle" style="color:#f00">공연 소개</h1>
<p class="MsoNormal" style="font-family:Batang"><b style="mso-bidi-font-weight:normal">굵은 글</b> 보통 글<br>다음 줄 <span style="color:blue" onclick="alert(1)">색 글</span> <i>기울인 글</i></p>
<ul><li>첫 항목</li><li>둘째 항목<ul><li>안쪽 항목</li></ul></li></ul>
<ol><li>하나</li><li>둘</li></ol>
<table><tr><td>표 칸</td></tr></table>
<p><img src="https://evil.example/x.png" onerror="alert(1)">그림 뒤 글</p>
<script>alert(1)</script>
<h3>작은 제목</h3>
<blockquote>인용 글</blockquote>
<p><a href="javascript:alert(1)">링크 글</a></p>
</body></html>`;

const ALLOWED_BLOCK = new Set(['p', 'h', 'ul', 'ol']);
const ALLOWED_INLINE = new Set(['text', 'br']);

function badNodes(doc) {
  const bad = [];
  const inline = (n, at) => {
    if (!ALLOWED_INLINE.has(n.t)) bad.push(`${at}:${n.t}`);
    for (const k of Object.keys(n)) if (!['t', 'v', 'b'].includes(k)) bad.push(`${at}.${k}`);
  };
  for (const k of Object.keys(doc)) if (!['v', 'blocks'].includes(k)) bad.push(k);
  doc.blocks.forEach((b, i) => {
    if (!ALLOWED_BLOCK.has(b.t)) bad.push(`blocks[${i}]:${b.t}`);
    for (const k of Object.keys(b)) if (!['t', 'c', 'level', 'items'].includes(k)) bad.push(`blocks[${i}].${k}`);
    (b.c ?? []).forEach((n, j) => inline(n, `blocks[${i}].c[${j}]`));
    (b.items ?? []).forEach((line, j) => line.forEach((n, k) => inline(n, `blocks[${i}].items[${j}][${k}]`)));
  });
  return bad;
}

/** 줄·공백을 하나로(편집기 화면과 저장한 글을 견준다) */
const norm = (s) => s.replace(/[​﻿]/g, '').replace(/\s+/g, ' ').trim();
const lineText = (c) => c.map((n) => (n.t === 'br' ? ' ' : n.v)).join('');
const docText = (doc) => doc.blocks.flatMap((b) => (b.items ? b.items.map(lineText) : [lineText(b.c)])).join(' ');

function record(key, value) {
  mkdirSync('reports', { recursive: true });
  const all = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  all[key] = value;
  writeFileSync(OUT, JSON.stringify(all, null, 2));
}

async function open(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ directive: e.effectiveDirective, disposition: e.disposition, sample: (e.sample || '').slice(0, 80) }));
  });
  // 받은 JS를 모두 재고, 처음 HTML이 가리킨 스크립트(<script src>·preload)와 견줘 늦게 받은 덩어리를 가린다(시각에 기대지 않는다)
  const scripts = [];
  page.on('response', async (r) => {
    if (r.request().resourceType() !== 'script') return;
    try {
      scripts.push({ path: new URL(r.url()).pathname, gz: gzipSync(await r.body()).length });
    } catch {
      // 본문을 못 읽는 응답(이동 등)은 건너뛴다
    }
  });
  const res = await page.goto('/events/new');
  const headers = res.headers();
  const html = await res.text();
  const inHtml = new Set([...html.matchAll(/\/_next\/static\/[^"'\s)]+\.js/g)].map((m) => m[0]));
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.waitForLoadState('networkidle');
  return { headers, scripts: scripts.map((s) => ({ ...s, phase: inHtml.has(s.path) ? 'initial' : 'lazy' })) };
}

/** 붙여넣기(HTML + 글자판). Firefox는 ClipboardEvent를 만들 때 넘긴 clipboardData를 빈 것으로 바꾸므로, 만든 이벤트에 clipboardData를 직접 달아 세 엔진에 같은 값을 넘긴다 */
async function paste(page, html, plain = '공연 소개') {
  await page.evaluate(
    ([h, t]) => {
      const el = document.querySelector('[data-testid="editor"]');
      const dt = new DataTransfer();
      dt.setData('text/html', h);
      dt.setData('text/plain', t);
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      el.dispatchEvent(ev);
    },
    [html, plain],
  );
}

/** [임시저장]을 누르고 저장된 구조 문서를 읽는다 */
async function savedDoc(page) {
  await page.getByRole('button', { name: '임시저장' }).click();
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k)).draft.description, DRAFT_KEY);
}

test('FE-T41 Lexical: 위저드의 묶음 B CSP·Trusted Types 보고 모드에서 Word 글을 붙여넣고 저장하면 허용 노드만 남고, 글이 같으며, 위반 0', async ({ page, browserName }) => {
  const { headers, scripts } = await open(page);
  expect(headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
  expect(headers['content-security-policy-report-only']).toContain("require-trusted-types-for 'script'");

  // 역할: 편집 칸 textbox(여러 줄), 도구 막대 toolbar
  const box = page.getByRole('textbox', { name: /공연 설명/ });
  await expect(box).toHaveAttribute('aria-multiline', 'true');
  await expect(page.getByRole('toolbar', { name: '공연 설명 서식' })).toBeVisible();

  await box.click();
  await paste(page, WORD_HTML);
  await expect(box).toContainText('그림 뒤 글');
  const editorText = norm(await box.innerText());

  const doc = await savedDoc(page);
  expect(badNodes(doc)).toEqual([]);
  expect(norm(docText(doc))).toBe(editorText);
  // 구조도 남는가: 블록 차례(제목·문단·목록 둘·표 칸·그림 뒤 글·작은 제목·인용·링크 글)와 굵게
  const shape = doc.blocks.map((b) => (b.t === 'h' ? `h${b.level}` : b.t));
  expect(shape).toEqual(['h2', 'p', 'ul', 'ol', 'p', 'p', 'h3', 'p', 'p']);
  expect(doc.blocks[1].c[0]).toEqual({ t: 'text', v: '굵은 글', b: true });
  expect(doc.blocks[2].items.length).toBe(3);
  // 스크립트·이벤트 속성·주소는 어디에도 남지 않는다
  expect(JSON.stringify(doc)).not.toMatch(/alert|javascript:|evil\.example|onerror|onclick|style/);
  // 저장되지 않을 글자 모양은 편집기 화면에도 남지 않는다
  await expect(box.locator('em, i, u')).toHaveCount(0);
  await expect(box.locator('h1')).toHaveCount(0);

  // 키보드: 새 문단에서 굵게 단축키. 입력기가 없는 로마자로 친다
  await box.press('ControlOrMeta+End');
  await box.press('Enter');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByRole('button', { name: '굵게' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('hotkey bold');
  // 기울임 단축키는 먹지 않는다
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('ControlOrMeta+i');
  await page.keyboard.type('no italic');
  await expect(box.locator('em, i')).toHaveCount(0);
  const after = await savedDoc(page);
  const hit = after.blocks.flatMap((b) => b.c ?? []).find((n) => n.t === 'text' && n.v.includes('hotkey'));
  expect([hit?.v, hit?.b], JSON.stringify(after.blocks.slice(-3))).toEqual(['hotkey bold', true]);

  // 도구 막대: 방향키로 옮기고 Enter로 누른다(마지막 문단이 제목이 된다)
  await page.getByRole('button', { name: '굵게' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: '제목', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '제목', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // 리뷰 재현: 초점은 도구 막대에 남고, 다음 Enter는 글을 지우지 않고 제목을 끈다
  await expect(page.getByRole('button', { name: '제목', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '제목', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(box).toContainText('no italic');
  await page.keyboard.press('Enter');
  const headed = await savedDoc(page);
  expect(headed.blocks.at(-1)).toMatchObject({ t: 'h', level: 2 });

  // 위반은 새로고침 전에 읽어 둔다(새로고침하면 목록이 비워진다, 리뷰 재현)
  const beforeReloadViolations = await page.evaluate(() => window.__csp);
  // 새로고침하면 저장한 글이 그대로 돌아온다
  const beforeReload = norm(await box.innerText());
  await page.reload();
  await expect(page.getByTestId('editor')).toContainText('no italic');
  expect(norm(await page.getByTestId('editor').innerText())).toBe(beforeReload);
  await expect(page.getByTestId('editor').locator('h2').last()).toContainText('no italic');

  const violations = [...beforeReloadViolations, ...(await page.evaluate(() => window.__csp))];
  const lazy = scripts.filter((s) => s.phase === 'lazy');
  const lazyKb = Math.round((lazy.reduce((a, s) => a + s.gz, 0) / 1024) * 10) / 10;
  const initialKb = Math.round((scripts.filter((s) => s.phase === 'initial').reduce((a, s) => a + s.gz, 0) / 1024) * 10) / 10;
  const editorViolations = violations.filter((v) => !isFramework(v));
  record(`wizard/${browserName}`, { lazyKb, initialKb, lazyFiles: lazy.length, shape, frameworkViolations: violations.length - editorViolations.length, editorViolations });
  console.log(`wizard/${browserName}: 늦게 싣는 덩어리 ${lazyKb}kB(파일 ${lazy.length}개), 처음 JS ${initialKb}kB, 편집기 위반 ${JSON.stringify(editorViolations)}`);
  // 늦게 받은 덩어리가 없으면(가르기가 틀렸으면) 예산 검사가 뜻이 없다
  expect(lazy.length, '늦게 받은 덩어리가 없다').toBeGreaterThan(0);
  expect(editorViolations).toEqual([]);
  expect(lazyKb, `늦게 싣는 덩어리 ${lazyKb}kB > ${BUDGET_KB}kB`).toBeLessThanOrEqual(BUDGET_KB);
});

test('리뷰 재현: Google 문서의 굵기를 그대로 받는다', async ({ page }) => {
  await open(page);
  await page.getByTestId('editor').click();
  await paste(page, '<b style="font-weight:normal" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700">진짜 굵게</span><span style="font-weight:400"> 보통 글</span></p></b>');
  await expect(page.getByTestId('editor')).toContainText('보통 글');
  const doc = await savedDoc(page);
  expect(doc.blocks[0].c).toEqual([{ t: 'text', v: '진짜 굵게', b: true }, { t: 'text', v: ' 보통 글' }]);
});

test('리뷰 재현: 저장되지 않을 목록 구조는 붙여넣을 때 저장될 모양으로 바꾼다', async ({ page }) => {
  await open(page);
  const box = page.getByTestId('editor');
  await box.click();
  await paste(page, '<ol start="5"><li>다섯</li><li>여섯</li></ol><ul><li>바깥<ul><li>안쪽</li></ul></li><li><h2>제목 항목</h2>본문</li></ul>');
  await expect(box).toContainText('본문');
  expect(await box.locator('ol').getAttribute('start')).toBeNull();
  await expect(box.locator('li li')).toHaveCount(0);
  await expect(box.locator('li h2')).toHaveCount(0);
  const doc = await savedDoc(page);
  expect(doc.blocks.at(-1).items).toEqual([[{ t: 'text', v: '바깥' }], [{ t: 'text', v: '안쪽' }], [{ t: 'text', v: '제목 항목' }, { t: 'br' }, { t: 'text', v: '본문' }]]);
  const first = await box.innerText();
  await page.reload();
  await expect(page.getByTestId('editor')).toContainText('본문');
  expect(norm(await page.getByTestId('editor').innerText())).toBe(norm(first));
});

test('리뷰 재현: 글자가 남지 않는 HTML이면 글자판을 넣는다', async ({ page }) => {
  await open(page);
  await page.getByTestId('editor').click();
  await paste(page, '<p><img src="https://evil.example/x.png"></p>', '글자판 내용');
  await expect(page.getByTestId('editor')).toContainText('글자판 내용');
});

test('리뷰 재현: 끌어다 놓은 HTML도 같은 거름을 지난다', async ({ page }) => {
  await open(page);
  await page.getByTestId('editor').click();
  await page.evaluate(() => {
    window.__csp.length = 0;
    const el = document.querySelector('[data-testid="editor"]');
    const dt = new DataTransfer();
    dt.setData('text/html', '<style>p{color:red}</style><p onclick="alert(1)"><b>끌어 놓은</b> 글</p>');
    dt.setData('text/plain', '끌어 놓은 글');
    const ev = new InputEvent('beforeinput', { inputType: 'insertFromDrop', bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
  });
  await expect(page.getByTestId('editor')).toContainText('끌어 놓은 글');
  expect((await page.evaluate(() => window.__csp)).filter((v) => !isFramework(v))).toEqual([]);
  const doc = await savedDoc(page);
  expect(doc.blocks.flatMap((b) => b.c)).toContainEqual({ t: 'text', v: '끌어 놓은', b: true });
});

test('리뷰 재현: 편집 칸을 누르기 전에 도구를 눌러도 동작한다', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '글머리 목록' }).click();
  await expect(page.getByTestId('editor').locator('ul')).toHaveCount(1);
});

test('리뷰 재현: 다른 탭이 다른 칸만 고치면 이 탭의 편집기는 다시 그리지 않는다', async ({ page, context }) => {
  await open(page);
  const box = page.getByTestId('editor');
  await box.click();
  await page.keyboard.type('first');
  await page.getByRole('button', { name: '임시저장' }).click();
  await box.click();
  const other = await context.newPage();
  await other.goto('/events/new');
  await other.getByText('이 브라우저에 임시저장한 내용을 불러왔습니다').waitFor();
  await other.locator('#w-title').fill('다른 탭 제목');
  await other.getByRole('button', { name: '임시저장' }).click();
  await expect(page.locator('#w-title')).toHaveValue('다른 탭 제목');
  await expect(box).toBeFocused();
  await page.keyboard.type(' second');
  await expect(box).toContainText('first second');
});
