// SCR-031 감사 화면 부품·배선 시험(F-03-7 T2·T3·T4·T13·T14·T19, ASVS v5.0.0-1.2.1·14.2.1, C-T39).
// 부품은 props만으로 그리는 서버 그리기(renderToString)로 보고, 배선은 원본 글에서 가져오기·주소 규칙을 확인한다.
// 구현 전 트리에는 ui/connected 부품과 ConnectedPage가 없어 시험마다 가져오기부터 실패한다.
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textOf } from '../../dashboard/ui/live/live.test.html.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';
globalThis.__SCANNER_ORIGIN__ = 'https://scanner.test';
globalThis.__CONSOLE_BUILD__ = 'mf';

const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');

const noop = () => undefined;
const AT = '2026-11-23T11:00:00.000Z';
const READ = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function render(mod, name, props) {
  return renderToString(createElement(MemoryRouter, { initialEntries: ['/audit'] }, createElement(mod[name], props)));
}
function buttons(html) {
  return [...html.matchAll(/<button(\s[^>]*)?>([\s\S]*?)<\/button>/g)].map((m) => {
    const attrs = Object.fromEntries([...(m[1] ?? '').matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? '']));
    return { ...attrs, text: textOf(m[2]) };
  });
}

const chain = (over = {}) => ({
  kind: 'verified',
  lastNo: 1284,
  lastPublishedAt: '2026-11-23T04:40:00.000Z',
  anchor: 'none',
  message: '감사 체인 검증됨',
  ...over,
});

const timeline = [
  { atMs: Date.parse('2026-11-23T11:00:00.000Z'), kind: 'REQUEST', label: '판매 일시정지 접수', detail: '결제사 승인 지연' },
  { atMs: Date.parse('2026-11-23T11:00:03.000Z'), kind: 'ACK', label: '받는 쪽 3/3 적용' },
  { atMs: Date.parse('2026-11-23T11:04:00.000Z'), kind: 'CHECKPOINT', label: '체크포인트 #1285' },
];

test('F-03-7 T2 ASVS-1.2.1-1 체인 띠는 검증됨·게시 지연·확정 대기·체인 변조 글을 텍스트로만 그리고, 사유의 HTML은 글자로 남는다', async () => {
  const { ChainBanner } = await import('./connected/ChainBanner.tsx');
  const ok = textOf(render({ ChainBanner }, 'ChainBanner', { chain: chain() }));
  assert.ok(ok.includes('감사 체인 검증됨'));
  const lateHtml = render({ ChainBanner }, 'ChainBanner', { chain: chain({ anchor: 'late', message: '공개 앵커 게시가 6시간 넘게 밀렸습니다 <img src=x onerror=alert(1)>' }) });
  const late = textOf(lateHtml);
  assert.ok(late.includes('공개 앵커 게시가 6시간 넘게 밀렸습니다 <img src=x onerror=alert(1)>'), '글자 그대로 남는다');
  assert.ok(lateHtml.includes('&lt;img'), '태그는 이스케이프된다');
  assert.equal(lateHtml.includes('<img src=x'), false, '요소가 생기지 않는다');
  const broken = textOf(render({ ChainBanner }, 'ChainBanner', { chain: chain({ kind: 'broken', message: '감사 체인 검증에 실패했습니다. 보안 사고로 기록합니다.' }) }));
  assert.ok(broken.includes('보안 사고'));
});

test('F-03-7 T3-1 리플레이 플레이어는 사건·재생 위치를 보이고, 휴대폰 배치에는 그리지 않는다', async () => {
  const { ReplayPlayer } = await import('./connected/ReplayPlayer.tsx');
  const html = render({ ReplayPlayer }, 'ReplayPlayer', { timeline, layout: 'desktop', positionMs: Date.parse('2026-11-23T11:00:03.000Z'), playing: false, speed: 1, onToggle: noop, onSeek: noop, onSpeed: noop });
  const text = textOf(html);
  assert.ok(text.includes('판매 일시정지 접수'));
  assert.ok(text.includes('받는 쪽 3/3 적용'));
  assert.ok(text.includes('00:00:03'), `재생 위치 시각이 보인다: ${text.slice(0, 120)}`);
  assert.ok(buttons(html).some((b) => b.text.includes('재생')), '재생 단추');
  const phone = render({ ReplayPlayer }, 'ReplayPlayer', { timeline, layout: 'phone', positionMs: 0, playing: false, speed: 1, onToggle: noop, onSeek: noop, onSpeed: noop });
  assert.equal(textOf(phone), '', '휴대폰에는 플레이어가 없다');
});

test('F-03-7 T4 C-T39-2 검증 묶음 대화상자는 commander·데스크톱에서 사유를 받고, operator는 막힌 이유를 보인다', async () => {
  const { ExportBundleDialog } = await import('./connected/ExportBundleDialog.tsx');
  const cp = { checkpointId: '8d1b2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', fromSeq: 1, toSeq: 100, reason: '일 체크포인트' };
  const allowed = render({ ExportBundleDialog }, 'ExportBundleDialog', { open: true, role: 'commander', layout: 'desktop', checkpoint: cp, busy: false, error: null, onConfirm: noop, onClose: noop });
  assert.ok(textOf(allowed).includes('검증 묶음'));
  assert.ok(buttons(allowed).some((b) => b.text.includes('내보내기') && b.disabled !== 'true'));
  const denied = render({ ExportBundleDialog }, 'ExportBundleDialog', { open: true, role: 'operator', layout: 'desktop', checkpoint: cp, busy: false, error: null, onConfirm: noop, onClose: noop });
  const why = textOf(denied);
  assert.ok(why.includes('commander'), '막힌 이유');
  const exportBtn = buttons(denied).find((b) => b.text.includes('내보내기'));
  assert.ok('disabled' in exportBtn, 'operator에게는 내보내기가 막힌다');
  assert.equal(exportBtn['aria-disabled'], 'true');
  const phone = render({ ExportBundleDialog }, 'ExportBundleDialog', { open: true, role: 'commander', layout: 'phone', checkpoint: cp, busy: false, error: null, onConfirm: noop, onClose: noop });
  assert.ok(textOf(phone).includes('태블릿이나 데스크톱'));
});

test('F-03-7 T13 ASVS-14.2.1-1 감사 화면 주소에는 tab·event·state 말고 사유·검색어·토큰을 싣지 않는다', () => {
  const page = READ('../ui/ConnectedPage.tsx');
  for (const bad of ["set('reason'", "set('q'", "set('query'", "set('token'", "set('subject'", "set('sha'", 'X-Reauth-Token=']) {
    assert.equal(page.includes(bad), false, `주소에 ${bad}를 싣는다`);
  }
});

test('F-03-7 T14 ASVS-1.2.1-2 감사 화면 파일에는 dangerouslySetInnerHTML이 없고, 표는 사유를 텍스트로만 그린다', async () => {
  for (const rel of ['../ui/ConnectedPage.tsx', '../ui/connected/AuditTable.tsx', '../ui/connected/ReplayPlayer.tsx', '../ui/connected/ChainBanner.tsx', '../ui/connected/ExportBundleDialog.tsx']) {
    assert.equal(READ(rel).includes('dangerouslySetInnerHTML'), false, `${rel}에 dangerouslySetInnerHTML이 있다`);
  }
  const { AuditTable } = await import('./connected/AuditTable.tsx');
  const rows = [
    {
      commandId: '6f1c1b5e-1d2a-4f3b-9c4d-5e6f7a8b9c0d',
      at: AT,
      atMs: Date.parse(AT),
      actor: '<img src=x onerror=alert(1)>',
      actorRole: 'commander',
      type: 'KILL_SWITCH',
      typeLabel: '판매 일시정지',
      reason: '</script><script>alert(1)</script>',
      approver: '—',
      dryRun: { approval: 'none', reauth: true, counted: 1, predicted: 0, unavailable: 1 },
      result: '적용 확인',
      state: 'ACKED',
    },
  ];
  const html = render({ AuditTable }, 'AuditTable', { rows, selectedId: null, onSelect: noop });
  const text = textOf(html);
  assert.ok(text.includes('<img src=x onerror=alert(1)>'));
  assert.ok(text.includes('</script><script>alert(1)</script>'));
  assert.equal(html.includes('<img src=x'), false, '태그가 생기지 않는다');
});

test('F-03-7 T19-1 실제 경로는 연결 화면을, 미리보기 ?state=는 보드를 그린다', () => {
  const page = READ('../ui/Page.tsx');
  assert.ok(page.includes("from './ConnectedPage'"), 'ConnectedPage를 가져온다');
  assert.match(page, /__PREVIEW__ && .*state.*\? <BoardPage \/> : <ConnectedPage \/>/s);
});

test('F-03-7 T19-2 감사 연결 화면은 명령 원장·체크포인트·검증 묶음 API를 실제로 가져온다', () => {
  const page = READ('../ui/ConnectedPage.tsx');
  for (const name of ['listOpsCommands', 'listOpsAuditCheckpoints', 'getOpsAuditCheckpointVerification', 'createOpsAuditVerificationBundle', 'getOpsCommand']) {
    assert.ok(page.includes(name), `${name}을 가져오지 않는다`);
  }
  assert.ok(page.includes('getMyOpsAuthSession'), '역할을 서버 세션에서 읽는다');
});
