// I-T53·J-T26 예매자 명단 내려받기의 사유·재인증 오류 문구와 파일 이름(SCR-027, POL-020).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkAttendeeExportReason, downloadName, exportCount, exportResult, reauthErrorView } from './roster-live.ts';

const ui = readFileSync(new URL('../ui/live/RosterLive.tsx', import.meta.url), 'utf8');

test('J-T26 ① 다운로드 사유는 비어 있거나 500자를 넘으면 막고, 사유·건수는 이력에 남긴다', () => {
  assert.match(checkAttendeeExportReason('   '), /다운로드 사유가 비어/);
  assert.match(checkAttendeeExportReason('가'.repeat(501)), /500자/);
  assert.equal(checkAttendeeExportReason('현장 명단 대조'), null);
  assert.equal(exportCount({ exportId: 'e', exportedAt: '2026-10-24T06:02:00.000Z', actorDisplayName: '관리자', actorRole: 'partner_admin', reason: '대조', count: 1031, format: 'XLSX', result: 'COMPLETED' }), '1,031건');
});

test('J-T26 ② 내려받기는 Blob 스트림을 받고 60초 안에 끝내며 재인증 토큰을 머리에 싣는다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../../shared/api/partner-live.ts', import.meta.url), 'utf8');
  assert.match(src, /send<Blob \| string>\(OPERATIONS\.createPartnerEventAttendeeExport/);
  assert.match(src, /asBlob\(r\.data, r\.headers\)/);
  assert.match(src, /'X-Reauth-Token': token/);
  assert.match(src, /timeoutMs: 60_000/);
});

test('I-T53 ① 403 reauth-required는 다시 인증 안내로 바꾼다', () => {
  const v = reauthErrorView({ status: 403, type: 'reauth-required' });
  assert.equal(v.kind, 'reauth-required');
  assert.match(v.message, /비밀번호·인증 앱 코드와 패스키/);
});

test('J-T26 ③ 보유 기간이 끝나면 410 retention-ended 안내다', () => {
  const v = reauthErrorView({ status: 410, type: 'retention-ended' });
  assert.equal(v.kind, 'retention-ended');
  assert.match(v.message, /1개월이 지나/);
});

test('I-T53 ⑤ 패스키 창을 닫거나 취소하면 내려받지 않는다', () => {
  const v = reauthErrorView(new DOMException('user cancelled', 'NotAllowedError'));
  assert.equal(v.kind, 'cancelled');
  assert.match(v.message, /패스키 확인을 취소/);
});

test('J-T26 파트너 실무자 403은 관리자만 안내다', () => {
  const v = reauthErrorView({ status: 403, type: 'partner-admin-required' });
  assert.equal(v.kind, 'other');
  assert.match(v.message, /파트너 관리자만/);
});

test('J-T26 다운로드 이력 결과와 건수를 가른다', () => {
  const ok = { exportId: 'e1', exportedAt: '2026-10-24T06:02:00.000Z', actorDisplayName: '스텔라 관리자', actorRole: 'partner_admin', reason: '대조', count: 1031, format: 'XLSX', result: 'COMPLETED' };
  assert.deepEqual(exportResult(ok), { label: '완료', badge: 'badge badge-success' });
  assert.equal(exportCount(ok), '1,031건');
  assert.equal(exportCount({ ...ok, result: 'FAILED' }), '—');
});

test('J-T26 파일 이름은 공연 이름과 형식으로 만든다', () => {
  assert.equal(downloadName('LUMEN 콘서트 2026 서울', 'XLSX'), 'LUMEN 콘서트 2026 서울_예매자명단.xlsx');
  assert.equal(downloadName('a/b:c', 'CSV'), 'a_b_c_예매자명단.csv');
});

test('J-T26 화면은 재인증 토큰을 받은 뒤에만 내보내기를 부른다', () => {
  assert.match(ui, /requestBookerExportReauth\(\{ password, code: code\.trim\(\) \}\)/);
  assert.match(ui, /createAttendeeExport\(selected, token/);
});
