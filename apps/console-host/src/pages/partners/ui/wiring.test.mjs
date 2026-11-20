// SCR-065 파트너사·계약 화면의 배선 시험(BAT-615 LCH-070, J-T29 ⑧).
// 실제 경로가 계약·판매자·결제사 자리와 viewer 차단, CS 읽기 전용을 지키는지 소스로 확인한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('SCR065_계약_탭은_목록·상세·계약_이력_변경_요청을_실제_API로_부른다', () => {
  const src = read('./ConnectedPage.tsx');
  for (const name of ['ensureConsoleApi', 'opsApiAvailable', 'listOpsPromoters', 'getOpsPromoter', 'listOpsPromoterContractTerms', 'createOpsPromoterContractTermChange', 'createOpsPromoter']) {
    assert.match(src, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(src, /import\('@peaket\/api-client\/endpoints\/ops'\)/);
  assert.match(src, /type Tab = 'contract' \| 'seller' \| 'pg'/);
  for (const label of ['계약', '판매자 정보', '결제사 등록', '변경 이력', '계약 조건 변경 요청']) {
    assert.ok(src.includes(label), `${label} 화면 요소가 없다`);
  }
  assert.match(src, /pendingContractApprovalId/);
  assert.match(src, /contractChangePending/);
  assert.match(src, /승인 대기/);
  assert.match(src, /validUntil/);
  assert.match(src, /formatBp\(/);
});

test('SCR065_판매자_정보_탭은_있는_칸만_보여_주고_없는_칸은_받지_않음으로_둔다', () => {
  const src = read('./ConnectedPage.tsx');
  assert.match(src, /tab === 'seller'/);
  assert.match(src, /detail\.seller/);
  for (const field of ['legalName', 'representative', 'businessRegNo', 'mailOrderReportNo', 'address', 'phone', 'email']) {
    assert.ok(src.includes(field), `판매자 정보 ${field} 칸이 없다`);
  }
  assert.match(src, /받지 않음/);
  assert.match(src, /detail\.verifiedAt/);
});

test('SCR065_결제사_등록_탭은_연동_전_자리이며_가짜_상태를_채우지_않는다', () => {
  const src = read('./ConnectedPage.tsx');
  assert.match(src, /tab === 'pg'/);
  assert.match(src, /지급대행 연동 전/);
  assert.match(src, /LCH-110/);
  assert.match(src, /LCH-120/);
  assert.match(src, /가짜 상태를 채우지 않습니다/);
  assert.match(src, /payoutAccount: null/);
  assert.match(src, /pgRegistration: \{ tossSellers: unknown\[\]; portonePartnerRegistered: boolean \}/);
  assert.match(src, /등록 전/);
  assert.match(src, /연동 전/);
});

test('SCR065_viewer는_화면에_들어올_수_없고_CS는_읽기_전용이다', () => {
  const src = read('./ConnectedPage.tsx');
  assert.match(src, /const ACCESS: Record<ConsoleRole, boolean> = \{ viewer: false, operator: true, commander: true, cs_agent: true, cs_lead: true \}/);
  assert.match(src, /if \(!ACCESS\[role\]\) return <NoAccess/);
  assert.match(src, /const canWrite = role === 'operator' \|\| role === 'commander'/);
  assert.match(src, /\{canWrite \?/);
  assert.match(src, /\{createOpen && canWrite \?/);
  assert.match(src, /\{changeOpen && canWrite && !pending \?/);
  assert.match(src, /disabled=\{!!pending\}/);
});

test('SCR065_오류_문구는_409·422·503을_구분하고_서버_원문을_그대로_보이지_않는다', () => {
  const model = read('../model/contracts.ts');
  assert.match(model, /status === 409 && type === 'contract-change-pending'/);
  assert.match(model, /status === 409/);
  assert.match(model, /status === 422/);
  assert.match(model, /status === 503/);
  assert.match(model, /status === 403/);
  assert.match(model, /export function formatBp/);
  assert.match(model, /export function parseBp/);
  assert.match(model, /bp \/ 100/);
  assert.match(model, /Math\.round\(n \* 100\)/);
  // 875bp → 8.75%, 8.75% → 875bp를 표기 함수가 다룬다(값은 화면 표기다)
  assert.match(model, /10,000bp = 100%|10_000bp = 100%|875bp → 8\.75%/);
});

test('SCR065_RV-03_계약_변경_요청은_멱등_키를_보낸다', () => {
  const src = read('./ConnectedPage.tsx');
  assert.match(src, /crypto\.randomUUID\(\)/, '멱등 키를 만들지 않는다');
  const at = src.indexOf('createOpsPromoterContractTermChange(');
  assert.ok(at >= 0, 'createOpsPromoterContractTermChange 호출이 없다');
  const call = src.slice(at, at + 900);
  assert.match(call, /headers\s*:/, '생성 호출에 머리(options)를 넘기지 않는다');
  assert.match(call, /['"]idempotency-key['"]\s*:/i, '생성 호출이 Idempotency-Key를 싣지 않는다');
});

test('SCR065_실제_경로는_연결_화면을_쓰고_디자인_보드는_미리보기에만_남긴다', () => {
  const src = read('./Page.tsx');
  assert.match(src, /__PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>/);
  assert.match(src, /const ACCESS: Record<ConsoleRole, Access> = \{ viewer: 'none', operator: 'act', commander: 'act', cs_agent: 'read', cs_lead: 'read' \}/);
  assert.match(src, /ACCESS\[chosen\] === 'none'/);
  assert.match(src, /<ReadOnlyScope on=\{!!chosen && ACCESS\[chosen\] === 'read'\}/);
});
