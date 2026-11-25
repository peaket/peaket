// SCR-030 명령 화면의 새 부품(ui/connected/*.tsx)을 서버 그리기로 본다(F-03-4 T1·T2·T8·T9·T10·T12, C-T4·C-T6 ②·C-T7 ②·C-T46 ③, ASVS v5.0.0-1.2.1, 시험 먼저 ADR 0372번).
// 정본: docs/design/d5-screen-blueprint.md §7.3(CMP-036 상태 표 글, disabled '판매 일시정지는 commander만 실행할 수 있습니다'·aria-disabled·aria-describedby,
// 명령 3 작성 글 '되돌리기(판매 재개)는 2인 승인입니다', 위험 확인 대화상자 제목·사유 칸 아래 글, 사후 검토 배너 '판매 일시정지를 1인 실행으로 걸었습니다. {날짜} KST까지 사후 검토 보고서를 써야 합니다'),
// docs/features/control-tower.md §3 명령 1·3·6(대체 결제사 전환)·§4 dry-run 두 갈래·§12 휴대폰, docs/security/asvs/control-tower.md 1.2.1(글자로만 그린다),
// 계획 docs/review/plans/F-03-4.md §4 ui/connected/(모두 props만으로 그린다)·6-1·6-2.
// 부품마다 따로 가져와 하나가 없어도 다른 시험은 돈다. 구현 전 트리에는 ui/connected/ 폴더가 없어 시험마다 가져오기부터 실패한다.
// 상태 값은 진짜 모델(dryRunView·commandCardState)로 만든다(내부 업무 로직을 가짜로 바꾸지 않는다).
import { register } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elements, textOf } from '../../../dashboard/ui/live/live.test.html.mjs';
import { E, commandState, dryRunAdmissionUp, dryRunKillSwitch, dryRunPgFallback } from '../../model/commands.test.fakes.mjs';

register('../../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';
globalThis.__SCANNER_ORIGIN__ = 'https://scanner.test';
globalThis.__CONSOLE_BUILD__ = 'mf';

const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');

const noop = () => undefined;
const SEEN = Date.parse('2026-11-23T11:00:02.000Z');

async function render(file, name, props) {
  const mod = await import(`./${file}`);
  assert.equal(typeof mod[name], 'function', `${file}에 ${name}이 없다`);
  return renderToString(createElement(MemoryRouter, { initialEntries: [`/commands?event=${E}`] }, createElement(mod[name], props)));
}
const view = async (raw) => (await import('../../model/dry-run.ts')).dryRunView(raw);
const cardState = async (detail, at) => (await import('../../model/card-state.ts')).commandCardState(detail, at);

/** <button> 요소마다 속성과 보이는 글 */
function buttons(html) {
  return [...html.matchAll(/<button(\s[^>]*)?>([\s\S]*?)<\/button>/g)].map((m) => {
    const attrs = Object.fromEntries([...(m[1] ?? '').matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? '']));
    return { ...attrs, text: textOf(m[2]) };
  });
}
/** 값이 글에 있는가(1,200·1200 어느 쪽 표기든) */
const hasNumber = (text, n) => text.includes(String(n)) || text.includes(n.toLocaleString('ko-KR'));
/** id가 같은 요소의 글 */
function textById(html, id) {
  const m = new RegExp(`<([a-z0-9]+)[^>]*\\sid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return m ? textOf(m[2]) : undefined;
}

// ---------- T1 dry-run 보기 ----------

test('F-03-4 T1 C-T6 ②-4 dry-run 판은 예측 줄마다 값·식·넣은 값·가정을, 센 값은 원천·센 시각과 함께 보인다', async () => {
  const html = await render('DryRunPanel.tsx', 'DryRunPanel', { view: await view(dryRunAdmissionUp()) });
  const text = textOf(html);
  for (const f of ['targetNew − slotsUsed − soonAdmitted − inFlight', 'vacancy ÷ admitRatio ÷ servingRateCap', 'targetNew ÷ avgDwellSeconds', 'steadyAdmissionRate ÷ admitRatio']) assert.ok(text.includes(f), `식 ${f}가 없다`);
  for (const n of [940, 5200, 3900, 260, 100, 26, 52]) assert.ok(hasNumber(text, n), `값 ${n}이 없다`);
  assert.ok(text.includes('정상 상태다(머무는 시간·입장 비율이 지금과 같다)'), '가정이 없다');
  for (const s of ['admission-ctrl', 'queue-redis', 'purchase-db']) assert.ok(text.includes(s), `원천 ${s}가 없다`);
  // 센 시각(2026-11-23T11:15Z = KST 20:15)
  assert.ok(text.includes('20:15'), `센 시각이 없다: ${text.slice(0, 400)}`);
});

test('F-03-4 T1 C-T6 ②-5 세지 못한 값은 "세지 못함"과 까닭으로 그리고 0이나 빈 숫자로 그리지 않는다', async () => {
  const only = { ...dryRunKillSwitch(), counted: [], predicted: [], limits: {} };
  const html = await render('DryRunPanel.tsx', 'DryRunPanel', { view: await view(only) });
  const text = textOf(html);
  assert.ok(text.includes('세지 못함'), `'세지 못함'이 없다: ${text}`);
  assert.ok(text.includes('source-not-wired'), '까닭이 없다');
  assert.doesNotMatch(text, /(^|[^\d.,:])0([^\d.,:]|$)/, `세지 못한 값을 0으로 그렸다: ${text}`);
});

test('F-03-4 T1 C-T6 ②-6 명령 6 결제 갈래 dry-run은 회차의 새 동시 입장 목표 상한 예측 식과 가정, 지금 값의 세지 못한 까닭을 보인다', async () => {
  const html = await render('DryRunPanel.tsx', 'DryRunPanel', { view: await view(dryRunPgFallback()) });
  const text = textOf(html);
  assert.ok(text.includes('min(admissionTargetMax, pgTps × avgDwellSeconds ÷ paymentRatio × safetyFactor)'));
  assert.ok(hasNumber(text, 5400));
  assert.ok(text.includes('평균 체류 180초(docs/architecture.md §9.1)'));
  assert.ok(text.includes('세지 못함'));
  assert.ok(text.includes(`input-unavailable:currentPgTps:${E}`));
});

test('F-03-4 T1 C-T6 ②-7 dry-run 오류(422 한계 밖 글)는 알림 칸으로 보인다', async () => {
  const msg = '이 값은 안전 한계 밖입니다(admissionTargetMax)';
  const html = await render('DryRunPanel.tsx', 'DryRunPanel', { view: null, error: msg });
  assert.ok(textOf(html).includes(msg));
  assert.match(html, /role="alert"/);
});

// ---------- T2 글자로만 그리기 ----------

test('F-03-4 T2 [ASVS v5.0.0-1.2.1] 사유·식·가정·세지 못한 까닭·lastError·ack 못 한 대상 이름의 HTML·스크립트는 글자로 그려지고 요소가 생기지 않는다', async () => {
  const IMG = '<img src=x onerror=alert(1)>';
  const SCRIPT = '</script><script>alert(2)</script>';
  const raw = dryRunAdmissionUp({
    predicted: [{ key: 'vacancy', value: 940, formula: `${IMG} − slotsUsed`, inputs: { targetNew: 5200 }, assumptions: [SCRIPT] }],
    unavailable: [{ key: 'inFlight', source: 'queue-redis', reason: IMG }],
  });
  const panel = await render('DryRunPanel.tsx', 'DryRunPanel', { view: await view(raw) });
  const detail = commandState({
    state: 'DISPATCHED',
    reason: `${IMG} 사유 ${SCRIPT}`,
    lastError: IMG,
    delivery: { kind: 'ACK', ackedCount: 1, targetCount: 2, unackedTargets: [IMG] },
  });
  const card = await render('CommandCard.tsx', 'CommandCard', {
    detail,
    state: await cardState(detail, { nowMs: SEEN + 3_001, dispatchSeenAtMs: SEEN }),
    role: 'commander',
    onApprove: noop,
    onReject: noop,
    onRetry: noop,
    onRevert: noop,
  });
  for (const html of [panel, card]) {
    assert.equal(elements(html, 'img').length, 0, 'img 요소가 생겼다');
    assert.equal(elements(html, 'script').length, 0, 'script 요소가 생겼다');
    // 글자 안의 'onerror='는 괜찮고, 요소 속성으로 생기면 안 된다
    assert.doesNotMatch(html, /<[a-z][^<>]*\sonerror=/i);
  }
  assert.ok(textOf(panel).includes(IMG));
  assert.ok(textOf(panel).includes(SCRIPT));
  assert.ok(textOf(card).includes(IMG));
  // 명령 화면 원본에 dangerouslySetInnerHTML이 없다
  const dir = new URL('./', import.meta.url);
  const files = [new URL('../ConnectedPage.tsx', import.meta.url), ...readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => new URL(f, dir))];
  assert.ok(files.length >= 7, `부품 파일이 모자란다: ${files.length}`);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /dangerouslySetInnerHTML/, f.pathname);
});

// ---------- T8 화면 막힘 ----------

test('F-03-4 T8 C-T46 ③-6 operator에게 명령 3 [판매를 전면 중단합니다]는 aria-disabled(초점은 받음)이고 aria-describedby로 이유 글이 늘 보인다', async () => {
  const reason = '판매 일시정지는 commander만 실행할 수 있습니다';
  const draft = { kind: 'KILL_SWITCH', scope: 'EVENT', eventId: E, reason: '' };
  const html = await render('CommandForm.tsx', 'CommandForm', { draft, onChange: noop, availability: { canRequest: false, reason } });
  const stop = buttons(html).find((b) => b.text.includes('판매를 전면 중단합니다'));
  assert.ok(stop, `[판매를 전면 중단합니다] 단추가 없다: ${textOf(html).slice(0, 300)}`);
  assert.equal(stop['aria-disabled'], 'true');
  assert.equal(Object.hasOwn(stop, 'disabled'), false, 'disabled면 초점을 받지 못한다(d5 CMP-036 disabled)');
  assert.ok(stop['aria-describedby'], 'aria-describedby가 없다');
  const described = stop['aria-describedby'].split(/\s+/).map((id) => textById(html, id) ?? '').join(' ');
  assert.ok(described.includes(reason), `이유 글이 이어지지 않았다: ${described}`);
  assert.ok(textOf(html).includes('되돌리기(판매 재개)는 2인 승인입니다'));
  // commander면 살아 있다
  const ok = await render('CommandForm.tsx', 'CommandForm', { draft, onChange: noop, availability: { canRequest: true } });
  const live = buttons(ok).find((b) => b.text.includes('판매를 전면 중단합니다'));
  assert.ok(live);
  assert.notEqual(live['aria-disabled'], 'true');
  assert.equal(Object.hasOwn(live, 'disabled'), false);
  assert.equal(textOf(ok).includes(reason), false);
});

test('F-03-4 T8 C-T46 ③-7 카탈로그는 명령 1·3·6(대체 결제사 전환) 카드만 두고 나머지는 한 줄 안내이며, operator에게는 명령 3 막힘 까닭이 보인다', async () => {
  const html = await render('CommandCatalog.tsx', 'CommandCatalog', { role: 'operator', layout: 'desktop', onPick: noop });
  const text = textOf(html);
  for (const name of ['동시 입장 목표', '판매 일시정지', '대체 결제사 전환']) assert.ok(text.includes(name), `카드 ${name}가 없다`);
  assert.ok(text.includes('이 콘솔에서는 아직 낼 수 없습니다'), '나머지 명령 안내가 없다');
  for (const other of ['입장 일시정지', '대역 차단', '봇 판정 강도', '로그 레벨', '자동화 정지']) assert.equal(buttons(html).some((x) => x.text.includes(other)), false, `카드가 없어야 할 명령 ${other}`);
  assert.ok(text.includes('판매 일시정지는 commander만 실행할 수 있습니다'));
});

test('F-03-4 T8 C-T46 ③-8 휴대폰 배치의 카탈로그는 명령 1·3·6 작성 단추가 없고 태블릿·데스크톱 안내를 보인다', async () => {
  const html = await render('CommandCatalog.tsx', 'CommandCatalog', { role: 'commander', layout: 'phone', onPick: noop });
  const text = textOf(html);
  assert.ok(text.includes('명령 요청과 실행은 태블릿이나 데스크톱에서 합니다'));
  for (const b of buttons(html)) assert.doesNotMatch(b.text, /동시 입장 목표|판매 일시정지|대체 결제사 전환|판매를 전면 중단합니다/, `휴대폰에 작성 단추: ${b.text}`);
});

// ---------- T9 승인 대기 ----------

test('F-03-4 T9 C-T4 ①-2 승인 대기 카드는 남은 시간(9:41)을 보이고, 요청자 본인에게는 [승인] 대신 "요청자 본인은 승인할 수 없습니다"다', async () => {
  const exp = Date.parse('2026-11-23T11:10:00.000Z');
  const mine = commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', approvalExpiresAt: new Date(exp).toISOString(), canApprove: false, delivery: null, dryRun: dryRunPgFallback() });
  const at = { nowMs: exp - 581_000 };
  const html = await render('CommandCard.tsx', 'CommandCard', { detail: mine, state: await cardState(mine, at), role: 'commander', onApprove: noop, onReject: noop, onRetry: noop, onRevert: noop });
  const text = textOf(html);
  assert.ok(text.includes('9:41'), `남은 시간이 없다: ${text.slice(0, 300)}`);
  assert.ok(text.includes('요청자 본인은 승인할 수 없습니다'));
  assert.equal(
    buttons(html).some((b) => b.text.trim() === '승인'),
    false,
    '요청자 본인에게 [승인]',
  );
  const other = { ...mine, canApprove: true };
  const html2 = await render('CommandCard.tsx', 'CommandCard', { detail: other, state: await cardState(other, at), role: 'operator', onApprove: noop, onReject: noop, onRetry: noop, onRevert: noop });
  assert.ok(buttons(html2).some((b) => b.text.includes('승인') && !b.text.includes('요청자')), '[승인]이 없다');
  assert.equal(textOf(html2).includes('요청자 본인은 승인할 수 없습니다'), false);
  // 승인자도 dry-run 기록을 빼거나 더하지 않고 본다(d2 §3.5)
  assert.ok(textOf(html2).includes('min(admissionTargetMax, pgTps × avgDwellSeconds ÷ paymentRatio × safetyFactor)'));
});

test('F-03-4 T9 C-T4 ①-3 거부·기한 지남(REJECTED) 카드는 d5 rejected 글이다', async () => {
  const d = commandState({ type: 'DEGRADED_MODE', state: 'REJECTED', delivery: null });
  const html = await render('CommandCard.tsx', 'CommandCard', { detail: d, state: await cardState(d, { nowMs: SEEN }), role: 'operator', onApprove: noop, onReject: noop, onRetry: noop, onRevert: noop });
  assert.ok(textOf(html).includes('거부되었거나 승인 대기 10분이 지나 취소되었습니다'));
});

// ---------- T10 전파 ----------

test('F-03-4 T10 C-T7 ②-6 전파 지연 카드는 "전파가 늦어지고 있습니다"·ack 4/5·ack 못 한 대상 이름이고, 3초 전에는 지연 글이 없다', async () => {
  const d = commandState({ state: 'DISPATCHED', delivery: { kind: 'ACK', ackedCount: 4, targetCount: 5, unackedTargets: ['purchase-svc-3'] } });
  const props = async (nowMs) => ({ detail: d, state: await cardState(d, { nowMs, dispatchSeenAtMs: SEEN }), role: 'operator', onApprove: noop, onReject: noop, onRetry: noop, onRevert: noop });
  const late = textOf(await render('CommandCard.tsx', 'CommandCard', await props(SEEN + 3_001)));
  assert.ok(late.includes('전파가 늦어지고 있습니다'));
  assert.match(late, /ack 4\/5/);
  assert.ok(late.includes('purchase-svc-3'));
  const early = textOf(await render('CommandCard.tsx', 'CommandCard', await props(SEEN + 3_000)));
  assert.equal(early.includes('전파가 늦어지고 있습니다'), false);
  assert.match(early, /ack 4\/5/);
});

test('F-03-4 T10 C-T7 ②-7 실패 카드는 "전파에 실패했습니다"와 [다시 시도]가 바로 있고 런북 CLI 한 줄(F-03-7 C-T7 ③)도 보인다. viewer에게는 [다시 시도]가 없다', async () => {
  const d = commandState({ state: 'FAILED', lastError: 'purchase-svc-3 ack 시간 초과', delivery: { kind: 'ACK', ackedCount: 2, targetCount: 3, unackedTargets: ['purchase-svc-3'] } });
  const st = await cardState(d, { nowMs: SEEN + 10_001, dispatchSeenAtMs: SEEN });
  const html = await render('CommandCard.tsx', 'CommandCard', { detail: d, state: st, role: 'operator', onApprove: noop, onReject: noop, onRetry: noop, onRevert: noop });
  assert.ok(textOf(html).includes('전파에 실패했습니다'));
  assert.ok(buttons(html).some((b) => b.text.includes('다시 시도')));
  assert.ok(textOf(html).includes('peaket-runbook draft'), '런북 CLI 한 줄(C-T7 ③)');
  assert.ok(textOf(html).includes(d.commandId), '런북 한 줄에 명령 ID가 들어간다');
  const viewer = await render('CommandCard.tsx', 'CommandCard', { detail: d, state: st, role: 'viewer', onApprove: noop, onReject: noop, onRetry: noop, onRevert: noop });
  assert.equal(
    buttons(viewer).some((b) => b.text.includes('다시 시도')),
    false,
  );
});

test('F-03-4 T10 C-T7 ②-8 적용 확인(ack 5/5)·재개 승인 대기·되돌림·자동 만료 카드 글은 d5 상태 표다', async () => {
  const at = { nowMs: SEEN + 60_000 };
  const card = async (d) => textOf(await render('CommandCard.tsx', 'CommandCard', { detail: d, state: await cardState(d, at), role: 'operator', onApprove: noop, onReject: noop, onRetry: noop, onRevert: noop }));
  assert.match(await card(commandState({ state: 'ACKED', delivery: { kind: 'ACK', ackedCount: 5, targetCount: 5, unackedTargets: [] } })), /ack 5\/5/);
  const rp = await card(commandState({ state: 'REVERT_PENDING', approvalExpiresAt: new Date(SEEN + 60_000 + 581_000).toISOString(), canApprove: true }));
  assert.ok(rp.includes('재개 승인을 기다립니다'));
  assert.ok(rp.includes('9:41'));
  assert.ok((await card(commandState({ state: 'REVERTED' }))).includes('되돌림'));
  assert.ok((await card(commandState({ type: 'ADMISSION_PAUSE', state: 'AUTO_EXPIRED' }))).includes('자동 만료'));
});

// ---------- T12 명령 3 확인·되돌리기 ----------

test('F-03-4 T12 ①-4 명령 3 위험 확인 대화상자는 d5 제목·범위 글·사유 칸 아래 글을 보이고, 사유가 비면 실행 단추가 막혀 있다', async () => {
  const one = await render('KillSwitchConfirm.tsx', 'KillSwitchConfirm', { scope: 'EVENT', eventId: E, onConfirm: noop, onClose: noop });
  const all = await render('KillSwitchConfirm.tsx', 'KillSwitchConfirm', { scope: 'PLATFORM', onConfirm: noop, onClose: noop });
  for (const html of [one, all]) {
    const text = textOf(html);
    assert.ok(text.includes('판매 일시정지(킬스위치)를 실행합니다'));
    assert.ok(text.includes('사유는 감사 로그와 사후 검토 보고서에 그대로 남습니다'));
    assert.match(html, /role="(?:alert)?dialog"/);
    assert.match(html, /aria-modal="true"/);
    const go = buttons(html).filter((b) => /실행|계속|인증/.test(b.text) && !b.text.includes('취소'));
    assert.ok(go.length > 0, '실행 단추가 없다');
    for (const b of go) assert.ok(Object.hasOwn(b, 'disabled') || b['aria-disabled'] === 'true', `사유 없이 실행 단추가 살아 있다: ${b.text}`);
  }
  assert.ok(textOf(one).includes('이 회차'));
  assert.equal(textOf(one).includes('전체 회차'), false);
  assert.ok(textOf(all).includes('전체'));
  assert.equal(textOf(all).includes('이 회차'), false);
});

test('F-03-4 T12 ②-1 명령 3 ACKED 카드는 사후 검토 기한 배너(서버 postReviewDueAt, KST)를 보인다', async () => {
  const d = commandState({ state: 'ACKED', postReviewDueAt: '2026-11-25T11:04:00.000Z' });
  const html = await render('CommandCard.tsx', 'CommandCard', { detail: d, state: await cardState(d, { nowMs: SEEN }), role: 'commander', onApprove: noop, onReject: noop, onRetry: noop, onRevert: noop });
  const text = textOf(html);
  assert.ok(text.includes('판매 일시정지를 1인 실행으로 걸었습니다'), text.slice(0, 300));
  assert.ok(text.includes('11/25(수) 20:04 KST까지 사후 검토 보고서를 써야 합니다'), text.slice(0, 400));
});

test('F-03-4 T12 C-T46 ④-3 되돌리기 단추: 명령 1은 operator에게, 명령 3·6은 commander에게만 있다', async () => {
  const at = { nowMs: SEEN };
  const has = async (d, role) =>
    buttons(await render('CommandCard.tsx', 'CommandCard', { detail: d, state: await cardState(d, at), role, onApprove: noop, onReject: noop, onRetry: noop, onRevert: noop })).some((b) => /되돌리|재개|해제/.test(b.text));
  const target = commandState({ type: 'ADMISSION_TARGET', state: 'ACKED', params: { eventId: E, target: 5200 }, dryRun: dryRunAdmissionUp() });
  const kill = commandState({ state: 'ACKED' });
  const pg = commandState({ type: 'DEGRADED_MODE', state: 'ACKED', params: { mode: 'PAYMENT_PG_FALLBACK', scope: 'EVENT', eventIds: [E] }, dryRun: dryRunPgFallback() });
  assert.equal(await has(target, 'operator'), true);
  assert.equal(await has(kill, 'operator'), false);
  assert.equal(await has(kill, 'commander'), true);
  assert.equal(await has(pg, 'operator'), false);
  assert.equal(await has(pg, 'commander'), true);
  assert.equal(await has(target, 'viewer'), false);
});

test('F-03-4 T12 C-T46 ④-4 되돌리기 대화상자는 사유 칸이 있고 사유가 비면 확인 단추가 막혀 있으며, 판매 재개는 2인 승인임을 알린다', async () => {
  for (const d of [commandState({ state: 'ACKED' }), commandState({ type: 'ADMISSION_TARGET', state: 'ACKED' })]) {
    const html = await render('RevertDialog.tsx', 'RevertDialog', { detail: d, onConfirm: noop, onClose: noop });
    assert.ok(elements(html, 'textarea').length + elements(html, 'input').length > 0, '사유 칸이 없다');
    const go = buttons(html).filter((b) => !/취소|닫기/.test(b.text));
    assert.ok(go.length > 0);
    for (const b of go) assert.ok(Object.hasOwn(b, 'disabled') || b['aria-disabled'] === 'true', `사유 없이 확인 단추가 살아 있다: ${b.text}`);
    if (d.type === 'KILL_SWITCH') assert.ok(textOf(html).includes('2인 승인'));
  }
});
