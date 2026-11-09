// 공연 설명 구조 문서(CMP-070, FE-T41, docs/design/d2 CMP-070, asvs/catalog-review 1.3.1, BUILD_ORDER HOT-322)
// 허용 노드 다섯: 문단(p)·줄바꿈(br)·강조(text의 b)·목록(ul·ol)·제목(h). 편집기마다 꺼낸 JSON을 이 문서로 바꾸고, 그 밖은 버리거나 글자로 낮춘다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docPlainText, fromLexical, isEmptyDoc, toLexical, validateDoc } from './doc.ts';

const lexText = (text, format = 0) => ({ type: 'text', text, format, detail: 0, mode: 'normal', style: 'color: red', version: 1 });
const lexical = (children) => ({ root: { type: 'root', children, direction: 'ltr', format: '', indent: 0, version: 1 } });

test('Lexical: 문단·제목·목록·강조·줄바꿈만 남기고 그 밖(표·인용·링크·스타일)은 글자로 낮춘다', () => {
  const doc = fromLexical(
    lexical([
      { type: 'heading', tag: 'h1', children: [lexText('공연 소개')] },
      { type: 'paragraph', children: [lexText('굵게', 1), lexText(' 보통'), { type: 'linebreak' }, { type: 'link', url: 'javascript:alert(1)', children: [lexText('링크')] }] },
      { type: 'list', listType: 'number', children: [{ type: 'listitem', children: [lexText('하나')] }, { type: 'listitem', children: [{ type: 'list', listType: 'bullet', children: [{ type: 'listitem', children: [lexText('안쪽')] }] }] }] },
      { type: 'quote', children: [lexText('인용')] },
      { type: 'table', children: [{ type: 'tablerow', children: [{ type: 'tablecell', children: [{ type: 'paragraph', children: [lexText('칸')] }] }] }] },
      { type: 'heading', tag: 'h4', children: [lexText('작은 제목', 3)] },
    ]),
  );
  assert.deepEqual(doc, {
    v: 1,
    blocks: [
      { t: 'h', level: 2, c: [{ t: 'text', v: '공연 소개' }] },
      { t: 'p', c: [{ t: 'text', v: '굵게', b: true }, { t: 'text', v: ' 보통' }, { t: 'br' }, { t: 'text', v: '링크' }] },
      { t: 'ol', items: [[{ t: 'text', v: '하나' }], [{ t: 'text', v: '안쪽' }]] },
      { t: 'p', c: [{ t: 'text', v: '인용' }] },
      { t: 'p', c: [{ t: 'text', v: '칸' }] },
      { t: 'h', level: 3, c: [{ t: 'text', v: '작은 제목', b: true }] },
    ],
  });
  assert.deepEqual(validateDoc(doc), []);
});

test('검사: 허용 노드 다섯 밖의 노드·속성, 제목 단계, 길이 상한을 모두 잡는다', () => {
  assert.deepEqual(validateDoc({ v: 1, blocks: [{ t: 'img', src: 'x' }] }), ['blocks[0]: 모르는 노드 img']);
  assert.deepEqual(validateDoc({ v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'a', style: 'x' }] }] }), ['blocks[0].c[0]: 모르는 속성 style']);
  assert.deepEqual(validateDoc({ v: 1, blocks: [{ t: 'h', level: 1, c: [] }] }), ['blocks[0]: 제목 단계는 2·3']);
  assert.deepEqual(validateDoc({ v: 1, blocks: [{ t: 'p', c: [], onclick: 'x' }] }), ['blocks[0]: 모르는 속성 onclick']);
  assert.ok(validateDoc({ v: 1, blocks: Array.from({ length: 201 }, () => ({ t: 'p', c: [] })) }).some((e) => e.includes('블록은 200개까지')));
  assert.ok(validateDoc({ v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'a'.repeat(20_001) }] }] }).some((e) => e.includes('글자는 20,000자까지')));
  assert.deepEqual(validateDoc({ v: 2, blocks: [] }), ['v: 판은 1']);
});

test('글자판은 서버와 같다: 블록 사이는 빈 줄, 목록 항목·줄바꿈은 줄바꿈(ADR-0244)', () => {
  assert.equal(
    docPlainText({ v: 1, blocks: [{ t: 'h', level: 2, c: [{ t: 'text', v: '제목' }] }, { t: 'p', c: [{ t: 'text', v: 'a' }, { t: 'br' }, { t: 'text', v: 'b', b: true }] }, { t: 'ul', items: [[{ t: 'text', v: '하나' }], [{ t: 'text', v: '둘' }]] }] }),
    '제목\n\na\nb\n\n하나\n둘',
  );
});

test('저장한 문서를 편집기 상태로 되돌려도 같은 문서다(ADR-0247)', () => {
  const doc = {
    v: 1,
    blocks: [
      { t: 'h', level: 2, c: [{ t: 'text', v: '제목' }] },
      { t: 'h', level: 3, c: [{ t: 'text', v: '작은 제목' }] },
      { t: 'p', c: [{ t: 'text', v: '굵게', b: true }, { t: 'text', v: ' 보통' }, { t: 'br' }, { t: 'text', v: '다음 줄' }] },
      { t: 'p', c: [] },
      { t: 'ul', items: [[{ t: 'text', v: '하나' }], [{ t: 'text', v: '둘', b: true }]] },
      { t: 'ol', items: [[{ t: 'text', v: '첫째' }]] },
    ],
  };
  const state = toLexical(doc);
  assert.equal(state.root.type, 'root');
  assert.deepEqual(fromLexical(state), doc);
});

test('빈 문서는 편집기 상태를 만들지 않고, 깨진 칸은 건너뛴다', () => {
  assert.equal(toLexical({ v: 1, blocks: [] }), null);
  assert.equal(toLexical({ v: 1, blocks: [{ t: 'video' }, 'x', null] }), null);
  assert.deepEqual(fromLexical(toLexical({ v: 1, blocks: [{ t: 'video' }, { t: 'p', c: [{ t: 'img' }, { t: 'text', v: 'a' }] }] })), { v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'a' }] }] });
});

test('글자가 없는 문서는 빈 문서다', () => {
  assert.equal(isEmptyDoc({ v: 1, blocks: [] }), true);
  assert.equal(isEmptyDoc({ v: 1, blocks: [{ t: 'p', c: [] }, { t: 'p', c: [{ t: 'br' }] }, { t: 'p', c: [{ t: 'text', v: '  ' }] }, { t: 'ul', items: [[]] }] }), true);
  assert.equal(isEmptyDoc({ v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'a' }] }] }), false);
});

test('검사는 모양도 본다: 배열이 아닌 칸·글자가 아닌 글·노드 수 상한(빈 줄바꿈 10만 개 등)', () => {
  assert.deepEqual(validateDoc({ v: 1 }), ['문서: blocks는 배열']);
  assert.deepEqual(validateDoc({ v: 1, blocks: [{ t: 'p' }] }), ['blocks[0]: c는 배열']);
  assert.deepEqual(validateDoc({ v: 1, blocks: [{ t: 'p', c: '<script>' }] }), ['blocks[0]: c는 배열']);
  assert.deepEqual(validateDoc({ v: 1, blocks: [{ t: 'ul', items: ['abc'] }] }), ['blocks[0].items[0]: 줄은 배열']);
  assert.deepEqual(validateDoc({ v: 1, blocks: [{ t: 'ul' }] }), ['blocks[0]: items는 배열']);
  assert.ok(validateDoc({ v: 1, blocks: [{ t: 'p', c: Array.from({ length: 100_000 }, () => ({ t: 'br' })) }] }).some((e) => e.includes('노드는 5,000개까지')));
});

test('깊게 겹친 입력도 멈추지 않는다(깊이 64 [가정]에서 자른다)', () => {
  let lex = { type: 'text', text: '끝', format: 0 };
  for (let i = 0; i < 20_000; i++) lex = { type: 'link', children: [lex] };
  assert.doesNotThrow(() => fromLexical({ root: { children: [{ type: 'paragraph', children: [lex] }] } }));
});

test('리뷰 재현(서버와 같은 규칙): 글자판 길이(블록 사이 빈 줄 포함)와 저장할 수 없는 글자를 막는다', () => {
  const para = (n) => ({ t: 'p', c: [{ t: 'text', v: '가'.repeat(n) }] });
  assert.deepEqual(validateDoc({ v: 1, blocks: Array.from({ length: 200 }, () => para(98)) }), []);
  assert.ok(validateDoc({ v: 1, blocks: Array.from({ length: 200 }, () => para(100)) }).some((e) => e.includes('글자')));
  assert.ok(validateDoc({ v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'a\u0000' }] }] }).length > 0);
  assert.ok(validateDoc({ v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'a\ud800' }] }] }).length > 0);
});

test('리뷰 재현: 한 줄에 글이 66개를 넘어도 잘리지 않는다(목록·인용)', () => {
  const inline = Array.from({ length: 80 }, (_, i) => [{ type: 'text', text: `글${i}`, format: 0 }, { type: 'linebreak' }]).flat();
  const doc = fromLexical({ root: { children: [{ type: 'list', listType: 'bullet', children: [{ type: 'listitem', children: inline }] }, { type: 'quote', children: inline }] } });
  assert.equal(doc.blocks[0].items[0].length, 160);
  assert.equal(doc.blocks[1].c.length, 160);
});

test('리뷰 재현: 모양만 볼 때는 상한과 글자 내용을 보지 않는다(임시저장을 잃지 않게)', () => {
  const para = (v) => ({ t: 'p', c: [{ t: 'text', v }] });
  assert.deepEqual(validateDoc({ v: 1, blocks: [para('가'.repeat(20_001))] }, 'shape'), []);
  assert.deepEqual(validateDoc({ v: 1, blocks: Array.from({ length: 201 }, () => para('a')) }, 'shape'), []);
  assert.deepEqual(validateDoc({ v: 1, blocks: [para('a\u0000')] }, 'shape'), []);
  assert.ok(validateDoc({ v: 1, blocks: [{ t: 'video' }] }, 'shape').length > 0);
  assert.ok(validateDoc({ v: 1, blocks: [{ t: 'p' }] }, 'shape').length > 0);
});
