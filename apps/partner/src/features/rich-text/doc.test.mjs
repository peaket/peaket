// 공연 설명 구조 문서(CMP-070, FE-T41, docs/design/d2 CMP-070, asvs/catalog-review 1.3.1, BUILD_ORDER HOT-322)
// 허용 노드 다섯: 문단(p)·줄바꿈(br)·강조(text의 b)·목록(ul·ol)·제목(h). 편집기마다 꺼낸 JSON을 이 문서로 바꾸고, 그 밖은 버리거나 글자로 낮춘다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docText, fromLexical, fromTiptap, validateDoc } from './doc.ts';

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

test('Tiptap: 같은 다섯 노드로 바꾸고 굵게 말고 다른 표시(기울임·링크·색)는 버린다', () => {
  const doc = fromTiptap({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '공연 소개' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '굵게', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { type: 'text', text: ' 보통', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
          { type: 'hardBreak' },
          { type: 'image', attrs: { src: 'http://evil/x.png' } },
        ],
      },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '하나' }] }] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: '<script>' }] },
      { type: 'horizontalRule' },
      { type: 'paragraph' },
    ],
  });
  assert.deepEqual(doc, {
    v: 1,
    blocks: [
      { t: 'h', level: 2, c: [{ t: 'text', v: '공연 소개' }] },
      { t: 'p', c: [{ t: 'text', v: '굵게', b: true }, { t: 'text', v: ' 보통' }, { t: 'br' }] },
      { t: 'ul', items: [[{ t: 'text', v: '하나' }]] },
      { t: 'p', c: [{ t: 'text', v: '<script>' }] },
      { t: 'p', c: [] },
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

test('글자만 뽑기(편집기 화면과 다시 그린 화면 견주기)', () => {
  assert.equal(
    docText({ v: 1, blocks: [{ t: 'h', level: 2, c: [{ t: 'text', v: '제목' }] }, { t: 'p', c: [{ t: 'text', v: 'a' }, { t: 'br' }, { t: 'text', v: 'b', b: true }] }, { t: 'ul', items: [[{ t: 'text', v: '하나' }], [{ t: 'text', v: '둘' }]] }] }),
    '제목\na\nb\n하나\n둘',
  );
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
  let tt = { type: 'text', text: '끝' };
  for (let i = 0; i < 20_000; i++) tt = { type: 'blockquote', content: [tt] };
  assert.doesNotThrow(() => fromTiptap({ type: 'doc', content: [tt] }));
});

test('리뷰 재현(서버와 같은 규칙): 글자판 길이(블록 사이 빈 줄 포함)와 저장할 수 없는 글자를 막는다', () => {
  const para = (n) => ({ t: 'p', c: [{ t: 'text', v: '가'.repeat(n) }] });
  assert.deepEqual(validateDoc({ v: 1, blocks: Array.from({ length: 200 }, () => para(98)) }), []);
  assert.ok(validateDoc({ v: 1, blocks: Array.from({ length: 200 }, () => para(100)) }).some((e) => e.includes('글자')));
  assert.ok(validateDoc({ v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'a\u0000' }] }] }).length > 0);
  assert.ok(validateDoc({ v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 'a\ud800' }] }] }).length > 0);
});
