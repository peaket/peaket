// 공지 화면 부품의 서버 그리기(F-03-5 T1·T2·T4·T5·T6·T10·T11·T13·T14,
// C-T29, ASVS v5.0.0-1.2.1·8.1.1·8.1.2, OPS-420, 시험 먼저 ADR 0372번).
// 정본: docs/design/d5-screen-blueprint.md §3.9·§7.16, docs/features/control-tower.md §12·§14 C-T29,
// 계획 docs/review/plans/F-03-5.md §4 ui/connected/. 부품은 props만으로 그린다.
// 구현 전 트리에는 ui/connected/ 폴더와 PhoneScopeCard가 없어 시험마다 가져오기부터 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elements, textOf } from '../../../dashboard/ui/live/live.test.html.mjs';

register('../../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';
globalThis.__CONSOLE_BUILD__ = 'mf';

const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');

const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const NOW = Date.parse('2026-11-25T03:00:00.000Z');
const TEXTS = { ko: '안내 문구', en: 'Notice', ja: '案内', zh: '通知' };

async function render(file, name, props) {
  const mod = await import(`./${file}`);
  assert.equal(typeof mod[name], 'function', `${file}에 ${name}이 없다`);
  return renderToString(createElement(MemoryRouter, { initialEntries: ['/notices'] }, createElement(mod[name], props)));
}
async function view(over = {}) {
  const { homeLayoutView } = await import('../../model/home-layout.ts');
  return homeLayoutView(
    {
      version: 7,
      updatedBy: '민호(operator)',
      updatedAt: '2026-11-20T03:00:00.000Z',
      banners: [
        {
          bannerId: 'bn-1',
          productionId: E,
          imageId: 'img-1',
          alt: '공연 배너',
          title: '공연 제목',
          subtitle: '11/30(일) 피켓 아레나',
          displayFrom: '2026-11-01T00:00:00.000Z',
          displayUntil: '2026-12-01T00:00:00.000Z',
        },
      ],
      themes: [{ themeId: 'th-1', name: '올해의 재즈', productionIds: [E], displayFrom: '2026-11-01T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z' }],
      ...over,
    },
    { nowMs: NOW, approvedProductionIds: [E] },
  );
}
function buttons(html) {
  return [...html.matchAll(/<button(\s[^>]*)?>([\s\S]*?)<\/button>/g)].map((m) => ({
    ...Object.fromEntries([...(m[1] ?? '').matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? ''])),
    text: textOf(m[2]),
  }));
}
const noop = () => undefined;

test('F-03-5 T10 [ASVS v5.0.0-8.1.1] 탭은 역할이 볼 수 있는 것만 role=tab으로 그리고 viewer는 홈 구성만 본다', async () => {
  const html = await render('NoticeTabs.tsx', 'NoticeTabs', { tabs: ['home'], active: 'home', onChange: noop });
  const text = textOf(html);
  assert.match(html, /role="tablist"/);
  assert.equal(elements(html, 'button').filter((b) => b.role === 'tab').length, 1);
  assert.ok(text.includes('홈 구성'));
  assert.equal(text.includes('대기실 공지 템플릿'), false);
  const all = await render('NoticeTabs.tsx', 'NoticeTabs', { tabs: ['templates', 'partner', 'home'], active: 'templates', onChange: noop });
  assert.equal(buttons(all).filter((b) => b.role === 'tab').length, 3);
});

test('F-03-5 T4 [ASVS v5.0.0-1.2.1] 배너·공지·템플릿 글의 HTML과 스크립트는 글자로만 그려진다', async () => {
  const IMG = '<img src=x onerror=alert(1)>';
  const SCRIPT = '</script><script>alert(2)</script>';
  const v = await view({
    banners: [
      {
        bannerId: 'bn-x',
        productionId: E,
        imageId: 'img-x',
        alt: IMG,
        title: IMG,
        subtitle: SCRIPT,
        displayFrom: '2026-11-01T00:00:00.000Z',
        displayUntil: '2026-12-01T00:00:00.000Z',
      },
    ],
    themes: [{ themeId: 'th-x', name: SCRIPT, productionIds: [E], displayFrom: '2026-11-01T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z' }],
  });
  const panel = await render('HomeLayoutPanel.tsx', 'HomeLayoutPanel', {
    role: 'operator',
    layout: 'desktop',
    columns: 3,
    view: v,
    reason: '사유',
    onReason: noop,
    onChange: noop,
    onPublish: noop,
    onUpload: noop,
    onReload: noop,
    busy: false,
  });
  const partner = await render('PartnerNoticePanel.tsx', 'PartnerNoticePanel', {
    role: 'operator',
    layout: 'desktop',
    draft: { targetKind: 'EVENT', eventId: E, phase: 'ONGOING', title: IMG, body: SCRIPT, channels: ['CONSOLE_POPUP'] },
    onChange: noop,
    onSend: noop,
    history: [{ noticeId: 'pn-1', targetKind: 'ALL', eventId: null, phase: 'ONGOING', title: IMG, body: SCRIPT, channels: ['EMAIL'], sentAt: '2026-11-20T03:00:00.000Z', recipientCount: 3 }],
    busy: false,
  });
  const editor = await render('TemplateEditor.tsx', 'TemplateEditor', {
    role: 'operator',
    layout: 'desktop',
    draft: { templateId: 'entry-delay', title: IMG, texts: { ...TEXTS, ko: SCRIPT } },
    onChange: noop,
    onSave: noop,
    onClose: noop,
    busy: false,
  });
  for (const html of [panel, partner, editor]) {
    assert.equal(elements(html, 'img').length, 0, 'img 요소가 생겼다');
    assert.equal(elements(html, 'script').length, 0, 'script 요소가 생겼다');
    assert.doesNotMatch(html, /<[a-z][^<>]*\sonerror=/i);
  }
});

test('F-03-5 T1 C-T29 판매 승인 전 공연이 든 배너는 게시 단추를 막고 까닭을 aria-describedby로 잇는다', async () => {
  const v = await view({
    banners: [
      {
        bannerId: 'bn-bad',
        productionId: '99999999-9999-4999-8999-999999999999',
        imageId: 'img-1',
        alt: '',
        title: '',
        subtitle: '',
        displayFrom: '2026-11-01T00:00:00.000Z',
        displayUntil: '2026-12-01T00:00:00.000Z',
      },
    ],
  });
  const html = await render('HomeLayoutPanel.tsx', 'HomeLayoutPanel', {
    role: 'operator',
    layout: 'desktop',
    columns: 3,
    view: v,
    reason: '사유',
    onReason: noop,
    onChange: noop,
    onPublish: noop,
    onUpload: noop,
    onReload: noop,
    busy: false,
  });
  const publish = buttons(html).find((b) => b.text.includes('홈에 게시하기'));
  assert.ok(publish, '게시 단추가 없다');
  assert.equal(publish['aria-disabled'], 'true');
  assert.equal(publish.disabled, undefined, 'disabled로 숨기지 않는다(d5 CMP-036)');
  assert.ok(publish['aria-describedby'], '까닭을 잇지 않는다');
  assert.match(textOf(html), /판매 승인/);
});

test('F-03-5 T2 C-T29 412는 다른 운영자가 먼저 저장했다는 글과 새로 읽기 단추를 보인다', async () => {
  const v = await view();
  const html = await render('HomeLayoutPanel.tsx', 'HomeLayoutPanel', {
    role: 'operator',
    layout: 'desktop',
    columns: 3,
    view: v,
    reason: '겨울 시즌',
    problem: '다른 운영자가 먼저 저장했습니다. 새로 읽은 뒤 다시 게시해 주세요',
    onReason: noop,
    onChange: noop,
    onPublish: noop,
    onUpload: noop,
    onReload: noop,
    busy: false,
  });
  assert.match(textOf(html), /다른 운영자가 먼저 저장했습니다/);
  assert.ok(buttons(html).some((b) => b.text.includes('새로 읽기')), '새로 읽기 단추가 없다');
});

test('F-03-5 T11 [ASVS v5.0.0-8.1.2] 마지막 저장자·시각은 보이고 updatedBy·updatedAt 입력 칸은 없다', async () => {
  const html = await render('HomeLayoutPanel.tsx', 'HomeLayoutPanel', {
    role: 'operator',
    layout: 'desktop',
    columns: 3,
    view: await view(),
    reason: '사유',
    onReason: noop,
    onChange: noop,
    onPublish: noop,
    onUpload: noop,
    onReload: noop,
    busy: false,
  });
  const text = textOf(html);
  assert.ok(text.includes('민호(operator)'), '마지막 저장자');
  assert.ok(text.includes('11/20') || text.includes('2026-11-20'), '마지막 저장 시각');
  const inputs = elements(html, 'input').map((i) => i.name ?? i.id ?? '');
  assert.equal(inputs.some((n) => /updatedBy|updatedAt/i.test(n)), false);
});

test('F-03-5 T13 OPS-420 홈 구성 격자는 columns 1·2·3에 맞춰진다', async () => {
  const v = await view();
  for (const [columns, want] of [
    [1, 'repeat(1, minmax(0, 1fr))'],
    [2, 'repeat(2, minmax(0, 1fr))'],
    [3, 'repeat(3, minmax(0, 1fr))'],
  ]) {
    const html = await render('HomeLayoutPanel.tsx', 'HomeLayoutPanel', {
      role: 'operator',
      layout: columns === 1 ? 'phone' : columns === 2 ? 'tablet' : 'desktop',
      columns,
      view: v,
      reason: '사유',
      onReason: noop,
      onChange: noop,
      onPublish: noop,
      onUpload: noop,
      onReload: noop,
      busy: false,
    });
    assert.match(html, new RegExp(`grid-template-columns:${want.replace(/[()]/g, '\\$&')}`), `${columns}열`);
  }
});

test('F-03-5 T14 OPS-420 휴대폰은 편집·게시 단추 대신 범위 밖 안내 카드를 보인다', async () => {
  const v = await view();
  const phone = await render('HomeLayoutPanel.tsx', 'HomeLayoutPanel', {
    role: 'commander',
    layout: 'phone',
    columns: 1,
    view: v,
    reason: '사유',
    onReason: noop,
    onChange: noop,
    onPublish: noop,
    onUpload: noop,
    onReload: noop,
    busy: false,
  });
  const text = textOf(phone);
  assert.ok(text.includes('이 작업은 태블릿이나 데스크톱에서 합니다. 휴대폰에서는 볼 수만 있습니다'), '안내 카드 글이 없다');
  assert.match(phone, /data-phone-scope="true"/);
  assert.equal(buttons(phone).some((b) => b.text.includes('홈에 게시하기')), false);
  assert.equal(buttons(phone).some((b) => b.text.includes('배너 추가')), false);
  assert.equal(elements(phone, 'input').length, 0, '휴대폰에 입력 칸이 남았다');

  const desktop = await render('HomeLayoutPanel.tsx', 'HomeLayoutPanel', {
    role: 'operator',
    layout: 'desktop',
    columns: 3,
    view: v,
    reason: '사유',
    onReason: noop,
    onChange: noop,
    onPublish: noop,
    onUpload: noop,
    onReload: noop,
    busy: false,
  });
  assert.ok(buttons(desktop).some((b) => b.text.includes('홈에 게시하기')), '데스크톱 게시 단추가 없다');
  assert.equal(elements(desktop, 'input').length > 0, true);
});

test('F-03-5 T5 [ASVS v5.0.0-2.1.1] 템플릿 편집기는 빠진 언어와 남은 글자를 보이고 저장을 막는다', async () => {
  const html = await render('TemplateEditor.tsx', 'TemplateEditor', {
    role: 'operator',
    layout: 'desktop',
    draft: { templateId: 'entry-delay', title: '입장 지연 안내', texts: { ...TEXTS, ja: '' } },
    onChange: noop,
    onSave: noop,
    onClose: noop,
    busy: false,
  });
  const text = textOf(html);
  assert.ok(text.includes('ja'), '빠진 언어가 없다');
  assert.match(text, /120/);
  const save = buttons(html).find((b) => b.text.includes('저장'));
  assert.ok(save, '저장 단추가 없다');
  assert.equal(save['aria-disabled'], 'true');
});

test('F-03-5 T6 [ASVS v5.0.0-2.2.3] 홈 구성 표는 게시 중·예정·끝남·노출 안 됨과 까닭을 보인다', async () => {
  const v = await view({
    banners: [
      { bannerId: 'bn-live', productionId: E, imageId: 'i', alt: 'a', title: '게시 중 배너', displayFrom: '2026-11-01T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z' },
      { bannerId: 'bn-soon', productionId: E, imageId: 'i', alt: 'a', title: '예정 배너', displayFrom: '2026-11-26T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z' },
      { bannerId: 'bn-done', productionId: E, imageId: 'i', alt: 'a', title: '끝난 배너', displayFrom: '2026-11-01T00:00:00.000Z', displayUntil: '2026-11-24T00:00:00.000Z' },
      { bannerId: 'bn-no', productionId: '99999999-9999-4999-8999-999999999999', imageId: 'i', alt: 'a', title: '숨긴 배너', displayFrom: '2026-11-01T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z' },
    ],
  });
  const html = await render('HomeLayoutPanel.tsx', 'HomeLayoutPanel', {
    role: 'operator',
    layout: 'desktop',
    columns: 3,
    view: v,
    reason: '사유',
    onReason: noop,
    onChange: noop,
    onPublish: noop,
    onUpload: noop,
    onReload: noop,
    busy: false,
  });
  const text = textOf(html);
  for (const s of ['게시 중', '예정', '끝남', '노출 안 됨', '판매 승인']) assert.ok(text.includes(s), s);
});

test('F-03-5 T10 [ASVS v5.0.0-8.1.1] 템플릿 표의 승인 단추는 commander에게만 살아 있다', async () => {
  const items = [{ templateId: 'entry-delay', title: '입장 지연 안내', texts: TEXTS, status: 'IN_REVIEW', version: 3 }];
  const commander = await render('TemplateTable.tsx', 'TemplateTable', { role: 'commander', items, onEdit: noop, onNew: noop, onApprove: noop, busy: false });
  const operator = await render('TemplateTable.tsx', 'TemplateTable', { role: 'operator', items, onEdit: noop, onNew: noop, onApprove: noop, busy: false });
  const approve = (html) => buttons(html).find((b) => b.text.includes('승인'));
  assert.ok(approve(commander), 'commander 승인 단추가 없다');
  assert.equal(approve(commander)['aria-disabled'], undefined);
  assert.equal(approve(operator)['aria-disabled'], 'true');
  assert.match(textOf(operator), /commander/);
});
