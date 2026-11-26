// F-04-15 core-svc support 소명 표 마이그레이션 시험(동결 로컬, LCH-310).
// 정본: docs/data.md appeal, docs/features/transfer-refund.md §7.1, docs/api/openapi.yaml 태그 support.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../migrations/0048_support_appeal.sql', import.meta.url), 'utf8');

test('FX-T20 ⑬ 마이그레이션 0048은 appeal 표·검사·인덱스·core_app 권한을 만든다', () => {
  assert.match(sql, /create table "appeal"/i);
  for (const column of ['id', 'account_id', 'kind', 'target_id', 'body', 'status', 'result', 'case_id', 'submitted_at', 'decided_at']) {
    assert.match(sql, new RegExp(`"${column}"`, 'i'), column);
  }
  assert.match(sql, /create index[^;]*appeal[^;]*account_id[^;]*submitted_at/i);
  assert.match(sql, /create index[^;]*appeal[^;]*target_id/i);
  assert.match(sql, /char_length\("?body"?\) <= 2000/i);
  assert.match(sql, /grant select, insert, update on "appeal" to core_app/i);
});

test('FX-T20 ⑬ appeal의 kind·status·result 검사는 정본 이름과 같다', () => {
  assert.match(sql, /kind" in \('RESTRICTION', 'RECLAIM', 'FRAUD_CASE'\)/);
  assert.match(sql, /status" in \('SUBMITTED', 'DECIDED', 'INVALID'\)/);
  assert.match(sql, /result" is null or "appeal"\."result" in \('LIFTED', 'KEPT', 'NOT_RECLAIMED', 'RECLAIMED', 'ACCEPTED', 'REJECTED'\)/);
});
