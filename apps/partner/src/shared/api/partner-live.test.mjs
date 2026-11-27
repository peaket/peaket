// J-T26 내려받기 파일은 CSV(text)와 XLSX·PDF(blob) 모두 Blob으로 만든다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asBlob, newIdempotencyKey } from './partner-live.ts';

const src = readFileSync(new URL('./partner-live.ts', import.meta.url), 'utf8');

test('J-T26 CSV text 응답을 파일 Blob으로 바꾼다', async () => {
  const blob = asBlob('예매번호,이름\n1,김*민', new Headers({ 'content-type': 'text/csv; charset=utf-8' }));
  assert.equal(blob.type, 'text/csv; charset=utf-8');
  assert.equal(await blob.text(), '예매번호,이름\n1,김*민');
});

test('J-T26 Blob 응답은 그대로 쓴다', async () => {
  const source = new Blob(['x'], { type: 'application/pdf' });
  assert.equal(asBlob(source, new Headers()), source);
});

test('I-T53 멱등 키는 UUIDv4 꼴이다', () => {
  assert.match(newIdempotencyKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('FR-024 송장 등록은 목록의 version을 If-Match로 보낸다', () => {
  assert.match(src, /putPartnerMerchOrderItemShipment[\s\S]*ifMatch: `"\$\{version\}"`/);
});

test('POL-016 반품 도착 확인·거절은 멱등 키를 보낸다', () => {
  assert.match(src, /createPartnerMerchOrderItemArrivalConfirmation,[\s\S]{0,80}?idempotencyKey: newIdempotencyKey\(\)/);
  assert.match(src, /createPartnerMerchOrderItemArrivalRejection,[\s\S]{0,100}?idempotencyKey: newIdempotencyKey\(\)/);
});

test('J-T26 배송·예매자 명단 내려받기는 X-Reauth-Token과 60초 제한을 쓴다', () => {
  assert.match(src, /createPartnerMerchDeliveryExport[\s\S]*'X-Reauth-Token': token[\s\S]*timeoutMs: 60_000/);
  assert.match(src, /createPartnerEventAttendeeExport[\s\S]*'X-Reauth-Token': token[\s\S]*timeoutMs: 60_000/);
});

// ---- F-07-7 J-T42 ①② 정산 계좌·회차 정산서(계획 §5.1(자), 계약 operationId getPartnerPayoutAccount·putPartnerPayoutAccount·getPartnerEventSettlements) ----
const partnerGen = readFileSync(new URL('../../../../../packages/api-client/src/gen/endpoints/partner/partner.ts', import.meta.url), 'utf8');
const methodOf = (name) => {
  const at = partnerGen.indexOf(`export const ${name} = async`);
  assert.ok(at >= 0, `${name} 생성 함수가 없다(계약 operationId)`);
  return /\bmethod: '([A-Z]+)'/.exec(partnerGen.slice(at, at + 2_000))?.[1];
};
/** export async function name(…) 몸통(다음 export 앞까지). 없으면 실패 */
const fnBody = (name) => {
  const at = src.indexOf(`export async function ${name}(`);
  assert.ok(at >= 0, `${name}이 partner-live.ts에 없다`);
  const next = src.indexOf('\nexport ', at + 1);
  return src.slice(at, next < 0 ? undefined : next);
};

test('J-T42 ① getPayoutAccount(signal?)는 계약 GET getPartnerPayoutAccount를 부르고 signal을 넘긴다', () => {
  assert.equal(methodOf('getPartnerPayoutAccount'), 'GET');
  const body = fnBody('getPayoutAccount');
  assert.match(body, /^export async function getPayoutAccount\(signal\?: AbortSignal\)/);
  assert.match(body, /OPERATIONS\.getPartnerPayoutAccount/);
  assert.match(body, /\bsignal\b/);
});

test('J-T42 ①_[ASVS v5.0.0-3.3.4] putPayoutAccount(body, { ifMatch, reauthToken })는 계약 PUT에 If-Match와 X-Reauth-Token 머리만 쓰고 토큰을 본문·쿼리에 싣지 않는다', () => {
  assert.equal(methodOf('putPartnerPayoutAccount'), 'PUT');
  const body = fnBody('putPayoutAccount');
  assert.match(body, /OPERATIONS\.putPartnerPayoutAccount/);
  assert.match(body, /ifMatch/);
  assert.match(body, /'X-Reauth-Token': [A-Za-z.]*reauthToken/);
  assert.doesNotMatch(body, /body: \{[^}]*reauthToken/);
  assert.doesNotMatch(body, /query:/);
  // 계좌번호를 로그로 남기지 않는다
  assert.doesNotMatch(body, /console\./);
});

test('J-T42 ② listEventSettlements(eventId, signal?)는 계약 GET getPartnerEventSettlements를 회차 경로 인자로 부른다', () => {
  assert.equal(methodOf('getPartnerEventSettlements'), 'GET');
  const body = fnBody('listEventSettlements');
  assert.match(body, /^export async function listEventSettlements\(eventId: string, signal\?: AbortSignal\)/);
  assert.match(body, /OPERATIONS\.getPartnerEventSettlements/);
  assert.match(body, /params: \{ eventId \}/);
  assert.match(body, /\bsignal\b/);
});

test('J-T42 ② 파트너 정산서 타입에 KYC 예고 칸 kycNotice가 있다', () => {
  const at = src.indexOf('export interface SettlementStatement');
  assert.ok(at >= 0);
  assert.match(src.slice(at, src.indexOf('\n}', at)), /\bkycNotice\??: boolean/);
});

// ---- F-07-13 SCR-020 내 계정 보안(계획 §4·§6, 계약 operationId 여섯) ----
test('I-T53 ③ 보안 요약·기기 목록은 계약 GET을 부르고 signal을 넘긴다', () => {
  assert.equal(methodOf('getPartnerAuthSecuritySettings'), 'GET');
  assert.equal(methodOf('getPartnerAuthSessions'), 'GET');
  const summary = fnBody('getPartnerAuthSecuritySettings');
  assert.match(summary, /^export async function getPartnerAuthSecuritySettings\(signal\?: AbortSignal\)/);
  assert.match(summary, /OPERATIONS\.getPartnerAuthSecuritySettings/);
  assert.match(summary, /\bsignal\b/);
  const list = fnBody('getPartnerAuthSessions');
  assert.match(list, /^export async function getPartnerAuthSessions\(signal\?: AbortSignal\)/);
  assert.match(list, /OPERATIONS\.getPartnerAuthSessions/);
  assert.match(list, /\bsignal\b/);
});

test('I-T53 ③ [ASVS v5.0.0-7.5.1] 인증 앱 시작·복구 코드 다시 만들기는 재인증 토큰을 X-Reauth-Token 머리로만 보낸다', () => {
  assert.equal(methodOf('createPartnerAuthTotpEnrollment'), 'POST');
  assert.equal(methodOf('createPartnerAuthRecoveryCodes'), 'POST');
  for (const [name, op] of [
    ['beginPartnerTotpEnrollment', 'createPartnerAuthTotpEnrollment'],
    ['recreatePartnerRecoveryCodes', 'createPartnerAuthRecoveryCodes'],
  ]) {
    const body = fnBody(name);
    assert.match(body, new RegExp(`^export async function ${name}\\(reauthToken: string\\)`));
    assert.match(body, new RegExp(`OPERATIONS\\.${op}`));
    assert.match(body, /'X-Reauth-Token': reauthToken/);
    assert.doesNotMatch(body, /body: \{[^}]*reauthToken/);
    assert.doesNotMatch(body, /query:/);
    assert.doesNotMatch(body, /console\./);
  }
});

test('I-T53 ③ 확인 코드는 계약 POST 본문 { code }로만 보내고 토큰·시드를 URL에 싣지 않는다', () => {
  assert.equal(methodOf('createPartnerAuthTotpConfirmation'), 'POST');
  const body = fnBody('confirmPartnerTotpEnrollment');
  assert.match(body, /^export async function confirmPartnerTotpEnrollment\(code: string\)/);
  assert.match(body, /OPERATIONS\.createPartnerAuthTotpConfirmation/);
  assert.match(body, /body: \{ code \}/);
  assert.doesNotMatch(body, /reauthToken|params:|query:/);
});

test('I-T53 ③ [ASVS v5.0.0-7.5.2] 기기 끊기는 경로 인자 sessionId와 X-Reauth-Token 머리만 쓰고 토큰을 주소에 싣지 않는다', () => {
  assert.equal(methodOf('deletePartnerAuthSession'), 'DELETE');
  const body = fnBody('deletePartnerAuthSession');
  assert.match(body, /^export async function deletePartnerAuthSession\(sessionId: string, reauthToken: string\)/);
  assert.match(body, /OPERATIONS\.deletePartnerAuthSession/);
  assert.match(body, /params: \{ sessionId \}/);
  assert.match(body, /'X-Reauth-Token': reauthToken/);
  assert.doesNotMatch(body, /body:/);
  assert.doesNotMatch(body, /query:/);
  assert.doesNotMatch(body, /console\./);
});
