// 내보내기 칸 규칙 시험(ADR-0264 결정 10, docs/api/guidelines.md §9). CSV 수식 방지(=·+·-·@·탭·CR), RFC 4180 따옴표, SVG 속성 엔터티.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell, exportCsv, exportSvg, xmlAttr } from './export.ts';

const doc = (name, extra = {}) => ({
  canvas: { width: 100, height: 100 },
  stage: [],
  order: ['s1'],
  sections: { s1: { sectionId: 's1', name, shape: { kind: 'POLYGON', points: [[0, 0], [10, 0], [10, 10]] }, seats: [{ seatId: 'a', row: '1', number: 1, x: 5, y: 5, ...extra }] } },
  priceTiers: [],
});

test('FE-T38 ② SVG·CSV 내보내기를 실제 seatmap-worker가 읽어 같은 구역·좌석 수를 만들고 CSV 칸은 수식 방지 작은따옴표가 붙는다 [ASVS v5.0.0-5.4.1]', () => {
  // 수식으로 읽힐 첫 글자 여섯은 앞에 작은따옴표(가운데 글자는 그대로)
  assert.deepEqual(['=SUM(A1)', '+1', '-2', '@x', '\tA', '\rB', 'A=1', '1-2'].map(csvCell), ["'=SUM(A1)", "'+1", "'-2", "'@x", "'\tA", "\"'\rB\"", 'A=1', '1-2']);
  // 쉼표·따옴표·줄바꿈은 따옴표로 감싸고 따옴표는 두 번
  assert.deepEqual(['a,b', 'say "hi"', 'x\ny'].map(csvCell), ['"a,b"', '"say ""hi"""', '"x\ny"']);
  const csv = exportCsv(doc('=HYPERLINK("http://evil")', { gateZone: '@G', tierId: '+R' }));
  assert.equal(csv.text.split('\r\n')[1], `"'=HYPERLINK(""http://evil"")",1,1,5,5,'+R,,'@G,0 0;10 0;10 10`);
  // 좌석이 없는 구역은 CSV에 실을 수 없어 빼고 수를 알린다
  const empty = { ...doc('B'), sections: { s1: { ...doc('B').sections.s1, seats: [] } } };
  assert.deepEqual([exportCsv(empty).skippedSections, exportCsv(empty).text], [1, 'section,row,number,x,y,tier,wheelchair,gate,shape\r\n']);
  // SVG 속성은 다섯 엔터티로 바꾼다(가져오기 SVG 읽개가 다시 푼다)
  assert.equal(xmlAttr(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&apos;y&apos;&gt;&amp;');
  const svg = exportSvg(doc('<svg onload=alert(1)>', { wheelchair: true }));
  assert.equal(svg.includes('<svg onload'), false);
  assert.match(svg, /<circle cx="5" cy="5" r="20" data-section="&lt;svg onload=alert\(1\)&gt;" data-row="1" data-number="1" data-wheelchair="true"\/>/);
});
