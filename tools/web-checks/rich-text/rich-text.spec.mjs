// FE-T41 서식 글 편집기 PoC(BUILD_ORDER HOT-322, docs/frontend.md FE-T41, docs/design/d2 CMP-070, asvs/catalog-review 1.3.1).
// 후보마다 본다: ① 묶음 B CSP·Trusted Types 보고 모드 위반 0 ② Word·웹 페이지 글(표·그림·스타일·스크립트)을 붙여넣고 저장한 구조 문서에
// 허용 노드 다섯 밖 노드·속성 0 ③ 다시 그린 화면의 글이 편집기 화면과 같다 ④ 늦게 싣는 덩어리(gzip) 80KB [가정] 이하
// ⑤ 키보드(굵게 단축키)와 역할(textbox·toolbar). 잰 값은 reports/rich-text.json에 남고 rich-text/RESULT.md가 정리한다.
// 판정(2026-11-05, ADR-0204): 구조 문서 기준(②③⑤)은 두 후보 모두 본다. 고른 Lexical은 편집기 위반 0과 덩어리 90KB(FE-T41로 확정)를 지켜야 한다.
// Tiptap은 ProseMirror 안의 DOMParser가 Trusted Types 위반을 내고(정책을 넘길 수 없다) 덩어리가 커서 고르지 않았다. 값만 남긴다.
// Next.js가 늦게 싣는 덩어리를 <script src>로 넣는 Trusted Types 위반은 편집기와 상관없어 따로 센다(관제·파트너 콘솔 보안 헤더 OPS-340에 넘김).
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** 늦게 싣는 덩어리 예산(gzip). docs/frontend.md §5.6 표의 80KB [가정]을 FE-T41이 잰 Lexical 88.5kB로 90KB로 확정했다(ADR-0204) */
const BUDGET_KB = 90;
const CHOSEN = 'lexical';
const OUT = 'reports/rich-text.json';
/** Next.js가 늦게 싣는 덩어리를 <script src>로 넣는 것(편집기와 상관없는 프레임워크 몫, 따로 센다) */
const isFramework = (v) => v.directive === 'require-trusted-types-for' && /^HTMLScriptElement src\|\/_next\/static\/chunks\//.test(v.sample);

/** Word에서 복사한 글을 흉내 낸 HTML(Office 꼬리표·스타일·표·그림·스크립트·이벤트 속성) */
const WORD_HTML = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{color:red}</style></head><body>
<h1 class="MsoTitle" style="color:#f00">공연 소개</h1>
<p class="MsoNormal" style="font-family:Batang"><b style="mso-bidi-font-weight:normal">굵은 글</b> 보통 글<br>다음 줄 <span style="color:blue" onclick="alert(1)">색 글</span></p>
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

/** 줄·공백을 하나로(편집기 화면과 다시 그린 화면의 글을 견준다) */
const norm = (s) => s.replace(/[​﻿]/g, '').replace(/\s+/g, ' ').trim();

function record(key, value) {
  mkdirSync('reports', { recursive: true });
  const all = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  all[key] = value;
  writeFileSync(OUT, JSON.stringify(all, null, 2));
}

async function open(page, editor) {
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
  const res = await page.goto(`/poc/rich-text?editor=${editor}`);
  const headers = res.headers();
  const html = await res.text();
  const inHtml = new Set([...html.matchAll(/\/_next\/static\/[^"'\s)]+\.js/g)].map((m) => m[0]));
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.waitForLoadState('networkidle');
  return { headers, scripts: scripts.map((s) => ({ ...s, phase: inHtml.has(s.path) ? 'initial' : 'lazy' })) };
}

for (const editor of ['lexical', 'tiptap']) {
  test(`FE-T41 ${editor}: 묶음 B CSP·Trusted Types 보고 모드에서 Word 글을 붙여넣고 저장하면 허용 노드만 남고, 다시 그린 글이 같으며, 위반 0`, async ({ page, browserName }) => {
    const { headers, scripts } = await open(page, editor);
    expect(headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
    expect(headers['content-security-policy-report-only']).toContain("require-trusted-types-for 'script'");

    // 역할: 편집 칸 textbox(여러 줄), 도구 막대 toolbar
    const box = page.getByRole('textbox', { name: '공연 설명' });
    await expect(box).toHaveAttribute('aria-multiline', 'true');
    await expect(page.getByRole('toolbar', { name: '서식' })).toBeVisible();

    // 붙여넣기(Word HTML + 글자판). Firefox는 ClipboardEvent를 만들 때 넘긴 clipboardData를 빈 것으로 바꾸므로,
    // 만든 이벤트에 clipboardData를 직접 달아 세 엔진에 같은 값을 넘긴다
    await box.click();
    await page.evaluate((html) => {
      const el = document.querySelector('[data-testid="editor"]');
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', '공연 소개');
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      el.dispatchEvent(ev);
    }, WORD_HTML);
    await expect(box).toContainText('그림 뒤 글');
    const editorText = norm(await box.innerText());

    await page.getByTestId('save').click();
    const doc = JSON.parse(await page.getByTestId('doc').innerText());
    expect(JSON.parse(await page.getByTestId('errors').innerText())).toEqual([]);
    expect(badNodes(doc)).toEqual([]);
    // 다시 그린 화면의 글이 편집기 화면과 같다(표·인용·링크는 글자로 남는다)
    expect(norm(await page.getByTestId('rendered').innerText())).toBe(editorText);
    // 구조도 남는가: 블록 차례(제목·문단·목록 둘·표 칸·그림 뒤 글·작은 제목·인용·링크 글)와 굵게. 고른 후보만 판정하고 둘 다 남긴다
    // (Tiptap은 제목 단계를 2·3으로 두면 붙여넣은 h1을 문단으로 바꾼다, RESULT.md)
    const shape = doc.blocks.map((b) => (b.t === 'h' ? `h${b.level}` : b.t));
    if (editor === CHOSEN) {
      expect(shape).toEqual(['h2', 'p', 'ul', 'ol', 'p', 'p', 'h3', 'p', 'p']);
      expect(doc.blocks[1].c[0]).toEqual({ t: 'text', v: '굵은 글', b: true });
      expect(doc.blocks[2].items.length).toBe(3);
    }
    // 스크립트·이벤트 속성·주소는 어디에도 남지 않는다
    const raw = JSON.stringify(doc);
    expect(raw).not.toMatch(/alert|javascript:|evil\.example|onerror|onclick|style/);

    // 키보드: 새 문단에서 굵게 단축키
    await box.press('ControlOrMeta+End');
    await box.press('Enter');
    // 굵게 단축키를 먼저 누르고 친다(단축키를 보는 것이라 입력기가 없는 로마자로. 고른 뒤 누르기는 시험 도구의 화살표 키가 ProseMirror에서 일부 빠진다)
    await page.keyboard.press('ControlOrMeta+b');
    await page.keyboard.type('hotkey bold');
    await page.getByTestId('save').click();
    const after = JSON.parse(await page.getByTestId('doc').innerText());
    // 맨 끝 블록이 아닐 수 있다(Tiptap 3은 끝에 빈 문단을 둔다)
    const hit = after.blocks.flatMap((b) => b.c ?? []).find((n) => n.t === 'text' && n.v.includes('hotkey'));
    expect([hit?.v, hit?.b], JSON.stringify(after.blocks.slice(-3))).toEqual(['hotkey bold', true]);

    const violations = await page.evaluate(() => window.__csp);
    const lazy = scripts.filter((s) => s.phase === 'lazy');
    const lazyKb = Math.round((lazy.reduce((a, s) => a + s.gz, 0) / 1024) * 10) / 10;
    const initialKb = Math.round((scripts.filter((s) => s.phase === 'initial').reduce((a, s) => a + s.gz, 0) / 1024) * 10) / 10;
    const editorViolations = violations.filter((v) => !isFramework(v));
    record(`${editor}/${browserName}`, { lazyKb, initialKb, lazyFiles: lazy.length, shape, frameworkViolations: violations.length - editorViolations.length, editorViolations });
    console.log(`${editor}/${browserName}: 늦게 싣는 덩어리 ${lazyKb}kB(파일 ${lazy.length}개), 처음 JS ${initialKb}kB, 편집기 위반 ${JSON.stringify(editorViolations)}`);
    // 늦게 받은 덩어리가 없으면(가르기가 틀렸으면) 예산 검사가 뜻이 없다
    expect(lazy.length, '늦게 받은 덩어리가 없다').toBeGreaterThan(0);
    if (editor === CHOSEN) {
      expect(editorViolations).toEqual([]);
      expect(lazyKb, `${editor}: 늦게 싣는 덩어리 ${lazyKb}kB > ${BUDGET_KB}kB`).toBeLessThanOrEqual(BUDGET_KB);
    }
  });
}
