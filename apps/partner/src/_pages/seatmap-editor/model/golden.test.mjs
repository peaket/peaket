// 골든 파일 시험(BAT-150 계획 §3.4): 에디터 문서 변환·저장 본문·내보내기의 출력이 services/core-svc/test-int/fixtures/seatmap-editor/의 파일과 같다.
// core-svc 통합 시험(seatmap-editor.int.test.ts)이 같은 파일을 실제 core-svc·seatmap-worker에 보낸다. 골든을 다시 쓸 때만 PEAKET_UPDATE_GOLDEN=1.
// load-response.json·save-response.json은 실제 core-svc 답(좌석 UUID를 차례 번호로 바꾼 것)이라 통합 시험이 쓴다.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

register('../../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const { GOLDEN_DIR, GOLDEN_PRODUCTION, golden, goldenJson, goldenStore, normalizeIds, XSS_NAME } = await import('./golden-scenario.mjs');
const { docFromLayout, saveBody, seatTotal, sectionsInOrder } = await import('./doc.ts');
const { exportFile } = await import('./export.ts');

const UPDATE = process.env.PEAKET_UPDATE_GOLDEN === '1';
const write = (name, text) => writeFileSync(join(GOLDEN_DIR, name), text);

const body0 = () => saveBody(goldenStore().getState().doc, 0);

test('FE-T46 ⑦ 에디터 명령으로 만든 문서의 저장 본문이 골든 save-body.json과 같고 색인·응답 전용 칸이 없다 [ASVS v5.0.0-3.5.2]', () => {
  const body = body0();
  if (UPDATE) write('save-body.json', `${JSON.stringify(body, null, 2)}\n`);
  assert.deepEqual(body, goldenJson('save-body.json'));
  // 판 0은 layoutVersion 0(If-Match "0"과 같다). 서버가 매기는 칸과 응답 전용 칸은 본문에 없다
  assert.equal(body.layoutVersion, 0);
  const text = JSON.stringify(body);
  for (const k of ['"index"', '"seatIndexRange"', '"fanFilePublished"', '"geometryLocked"', '"warnings"']) assert.equal(text.includes(k), false, k);
  assert.deepEqual(body.priceTiers.map((t) => t.tierId), ['S', 'R', 'A']);
  assert.equal(body.sections.length, 4);
  assert.equal(body.sections.reduce((n, s) => n + s.seats.length, 0), 83);
});

test('FE-T46 ① 실제 불러오기 응답 골든(load-response.json)을 문서로 읽으면 서버 판의 구역·좌석 수이고 다시 만든 본문이 보낸 본문과 같다', () => {
  const load = goldenJson('load-response.json');
  const doc = docFromLayout(load);
  assert.equal(load.layoutVersion, 1);
  assert.equal(load.geometryLocked, false);
  assert.equal(doc.order.length, 4);
  assert.equal(seatTotal(doc), 83);
  assert.deepEqual(sectionsInOrder(doc).map((s) => [s.sectionId, s.seats.length]), [['s1', 36], ['s2', 5], ['s3', 12], ['s4', 30]]);
  // 응답의 색인은 문서에 남지 않는다(다시 보내는 본문에 없다)
  const again = saveBody(doc, 1);
  assert.deepEqual(normalizeIds(again), normalizeIds({ ...body0(), layoutVersion: 1 }));
});

test('FE-T46 ⑩ 부채꼴·곡선 띠의 arc가 불러오기 응답 골든에 그대로 있고 문서로 읽으면 같은 손잡이 값이다', () => {
  const load = goldenJson('load-response.json');
  const sent = goldenJson('save-body.json');
  assert.deepEqual(load.sections[2].shape.arc, sent.sections[2].shape.arc);
  assert.deepEqual(load.sections[3].shape.arc, { cx: 4000, cy: 500, innerRadius: 2500, outerRadius: 3200, startAngle: 60, endAngle: 120 });
  const doc = docFromLayout(load);
  assert.deepEqual(doc.sections.s3.shape.arc, { cx: 1500, cy: 4500, innerRadius: 0, outerRadius: 1000, startAngle: 180, endAngle: 270 });
  assert.equal(doc.sections.s1.shape.arc, undefined);
});

test('FE-T46 ⑪ 구역 이름 <img …>는 문서·본문에 글자 그대로이고 HTML로 바꾸지 않는다 [ASVS v5.0.0-1.1.2]', () => {
  const doc = docFromLayout(goldenJson('load-response.json'));
  assert.equal(doc.sections.s2.name, XSS_NAME);
  assert.equal(saveBody(doc, 1).sections[1].name, XSS_NAME);
});

test('FE-T38 ① JSON 내보내기는 골든 export.json과 같고 그 파일을 다시 읽으면 구역·좌석 수와 좌표가 같다', () => {
  const doc = docFromLayout(goldenJson('load-response.json'));
  const f = exportFile(doc, 'JSON', GOLDEN_PRODUCTION, 1);
  if (UPDATE) write('export.json', f.text);
  assert.equal(f.text, golden('export.json'));
  assert.equal(f.name, 'seatmap-0b8f1f2e-v1.json');
  const back = docFromLayout(JSON.parse(f.text));
  assert.deepEqual(sectionsInOrder(back).map((s) => s.seats.map((x) => [x.row, x.number, x.x, x.y])), sectionsInOrder(doc).map((s) => s.seats.map((x) => [x.row, x.number, x.x, x.y])));
});

test('FE-T38 ② CSV·SVG 내보내기는 골든 export.csv·export.svg와 같고 같은 구역·좌석 수를 싣는다 [ASVS v5.0.0-5.4.1]', () => {
  const doc = docFromLayout(goldenJson('load-response.json'));
  const csv = exportFile(doc, 'CSV', GOLDEN_PRODUCTION, 1);
  const svg = exportFile(doc, 'SVG', GOLDEN_PRODUCTION, 1);
  // 저장소는 줄 끝을 LF로 둔다(.gitattributes). CSV는 RFC 4180대로 CRLF로 내보내고 골든은 LF로 견준다(가져오기는 둘 다 읽는다)
  const lf = csv.text.replaceAll('\r\n', '\n');
  if (UPDATE) {
    write('export.csv', lf);
    write('export.svg', svg.text);
  }
  assert.equal(csv.text.includes('\r\n'), true);
  assert.equal(csv.text.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(lf, golden('export.csv'));
  assert.equal(svg.text, golden('export.svg'));
  assert.deepEqual([csv.name, csv.mime, svg.name, svg.mime], ['seatmap-0b8f1f2e-v1.csv', 'text/csv;charset=utf-8', 'seatmap-0b8f1f2e-v1.svg', 'image/svg+xml']);
  const lines = csv.text.trimEnd().split('\r\n');
  assert.equal(lines[0], 'section,row,number,x,y,tier,wheelchair,gate,shape');
  assert.equal(lines.length - 1, 83);
  // 구역마다 첫 행에만 shape(꼭짓점 'x y;…')가 있다
  assert.equal(lines.filter((l) => /,"?\d+ \d+;/.test(l)).length, 4);
  assert.equal((svg.text.match(/<circle /g) ?? []).length, 83);
  assert.equal((svg.text.match(/<polygon data-section=/g) ?? []).length, 4);
  assert.equal((svg.text.match(/data-kind="stage"/g) ?? []).length, 1);
  // 구역 이름 <img …>는 XML 엔터티로 바뀌어 요소가 생기지 않는다
  assert.equal(svg.text.includes('<img'), false);
  assert.equal(svg.text.includes('data-section="&lt;img src=x onerror=alert(1)&gt;"'), true);
});
