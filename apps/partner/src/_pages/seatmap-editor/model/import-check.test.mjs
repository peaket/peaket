// 가져오기 대화상자 시험(ADR-0264 결정 9, d5 §6.5 '가져오기 결과'). 앞 검사 경계(10MB 정확히·1바이트 넘음, gzip·zip)와 결과 표·문구,
// 반영은 문서 바꾸기 명령 하나라 되돌릴 수 있고 모르는 등급은 가격이 빈 등급으로 더해 저장을 막는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { docFromLayout, emptyDoc, saveBlockers } from './doc.ts';
import { IMPORT_MAX_BYTES, importFailureText, importFileName, importView, isCompressed, precheck, TOO_LARGE_TEXT } from './import-check.ts';
import { withImportedTiers } from './price-tiers.ts';
import { addShapeCmd, createEditorStore, replaceCmd } from './store.ts';

const head = (...b) => new Uint8Array(b);

test('FE-T46 ⑧ 가져오기 대화상자: 행 오류 표, SVG_IGNORED 이름은 글자, 10MB·압축 파일은 보내지 않음, JSON은 확인 뒤 명령 하나 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', () => {
  // 10MB(10,485,760바이트) 정확히는 보내고 1바이트 넘으면 서버 413과 같은 문구
  assert.equal(IMPORT_MAX_BYTES, 10_485_760);
  assert.equal(precheck(10_485_760, head(0x73)), null);
  assert.equal(precheck(10_485_761, head(0x73)), TOO_LARGE_TEXT);
  assert.equal(importFailureText(413, 'seatmap-import-too-large'), TOO_LARGE_TEXT);
  // 압축 앞부분(gzip 1F 8B, zip 50 4B 03 04)은 크기와 상관없이 보내지 않는다. 한 바이트 다른 것은 보낸다
  assert.equal(precheck(6, head(0x1f, 0x8b, 8, 0)), TOO_LARGE_TEXT);
  assert.equal(precheck(6, head(0x50, 0x4b, 0x03, 0x04)), TOO_LARGE_TEXT);
  assert.deepEqual([isCompressed(head(0x1f, 0x8c)), isCompressed(head(0x50, 0x4b, 0x03, 0x05)), isCompressed(head(0x1f))], [false, false, false]);
  assert.equal(precheck(0, head()), '빈 파일입니다');
  assert.deepEqual(['SVG', 'JSON', 'CSV'].map(importFileName), ['seatmap.svg', 'seatmap.json', 'seatmap.csv']);

  // 행 오류: 줄·칸·쉬운 문구의 표이고 반영하지 않는다(ok 거짓). 서버가 준 1,000개까지
  const rows = importView({ ok: false, errors: [{ line: 5, field: 'x', code: 'COORD_INVALID' }, { line: 4, field: 'number', code: 'NUMBER_INVALID' }, { line: 9, field: 'q', code: 'NEW_CODE' }], warnings: [] });
  assert.equal(rows.ok, false);
  assert.deepEqual(rows.rows, [
    { line: 5, field: 'x', text: '좌표가 숫자가 아닙니다' },
    { line: 4, field: 'number', text: '좌석 번호는 1 이상 숫자 8자리까지입니다' },
    { line: 9, field: 'q', text: '값이 올바르지 않습니다(NEW_CODE)' },
  ]);
  const many = importView({ ok: false, errors: Array.from({ length: 1_001 }, (_, i) => ({ line: i + 2, field: 'x', code: 'COORD_INVALID' })) });
  assert.deepEqual([many.rows.length, many.errorCount], [1_000, 1_001]);
  // SVG_IGNORED는 이름만 글자로(값·주소는 없다). '<script>'처럼 꺾쇠가 든 이름도 글자 그대로 둔다(화면은 텍스트 노드로만 넣는다)
  const svg = importView({ ok: true, layout: { canvas: { width: 10, height: 10 }, sections: [] }, warnings: [{ code: 'SVG_IGNORED', ignored: ['script', 'image', '<b onclick=x>'] }, { code: 'W1', seatIds: [] }] });
  assert.equal(svg.ok, true);
  assert.equal(svg.ignoredText, '읽지 않고 넘긴 요소: script, image, <b onclick=x>');
  assert.equal(importView({ ok: true, warnings: [] }).ignoredText, null);
  for (const [status, type] of [[422, 'seatmap-import-rejected'], [429, 'server-busy'], [503, 'seatmap-worker-unavailable'], [404, 'not-found']]) assert.ok(importFailureText(status, type).length > 0);
  assert.equal(importFailureText(404, 'not-found'), '공연을 찾을 수 없습니다');

  // 정상 JSON: 지금 배치가 있으면 확인을 묻고(화면), 반영은 문서 바꾸기 명령 하나 → 되돌리면 앞 문서
  const st = createEditorStore(emptyDoc(), 4, false, { idPrefix: 'i' });
  const s = st.getState;
  s().exec(addShapeCmd(s().doc, 'section', { kind: 'POLYGON', points: [[0, 0], [100, 0], [100, 100]] }, 's1'));
  const before = structuredClone(s().doc);
  const imported = docFromLayout({ canvas: { width: 2000, height: 1500 }, sections: [{ sectionId: '1', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [1000, 0], [1000, 1000]] }, seats: [{ seatId: '1-1-1', row: '1', number: 1, x: 10, y: 10, tierId: 'VIP' }] }] });
  const next = { ...imported, priceTiers: withImportedTiers(imported, s().doc.priceTiers) };
  assert.deepEqual(next.priceTiers, [{ tierId: 'VIP', name: 'VIP', price: null }]);
  assert.equal(s().exec(replaceCmd(s().doc, next)), true);
  assert.equal(s().doc.order.length, 1);
  assert.equal(s().past.length, 2);
  // 가격을 채우기 전에는 저장하지 않는다
  assert.deepEqual(saveBlockers(s().doc), ['가격을 채우지 않은 등급이 있습니다. 등급과 가격에서 가격을 넣어 주세요']);
  s().undo();
  assert.deepEqual(s().doc, before);
});

test('내보낸 JSON을 다시 가져오면 그 파일의 가격 등급 가격을 지키고, 없는 등급만 빈 가격으로 더한다(ADR-0264 결정 9)', () => {
  const imported = docFromLayout({
    canvas: { width: 2000, height: 1500 },
    priceTiers: [{ tierId: 'R', name: 'R석', price: 150000 }],
    sections: [
      { sectionId: '1', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [1000, 0], [1000, 1000]] }, seats: [{ seatId: '1-1-1', row: '1', number: 1, x: 10, y: 10, tierId: 'S' }] },
    ],
  });
  const tiers = withImportedTiers(imported, [{ tierId: 'A', name: 'A석', price: 70000 }]);
  assert.deepEqual(tiers, [
    { tierId: 'A', name: 'A석', price: 70000 },
    { tierId: 'R', name: 'R석', price: 150000 },
    { tierId: 'S', name: 'S', price: null },
  ]);
});
