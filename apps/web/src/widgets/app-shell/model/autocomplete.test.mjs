// 머리 자동완성의 브라우저 규칙(docs/features/search.md §4.5, d5 §5.3, BUILD_ORDER HOT-313)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chosungOf, inputKind, minLengthOk, normalizeInput, parseRecent, refineLocally, suggestRequestQuery, toShellSuggestion } from './autocomplete.ts';

test('요청 최소 길이: 한글 음절이 있으면 1자부터, 로마자·숫자·낱자만이면 2자부터', () => {
  assert.equal(minLengthOk('루'), true);
  assert.equal(minLengthOk('l'), false);
  assert.equal(minLengthOk('lu'), true);
  assert.equal(minLengthOk('ㄹ'), false);
  assert.equal(minLengthOk('ㄹㅁ'), true);
  assert.equal(minLengthOk('   '), false);
});

test('정규화·입력 종류·초성', () => {
  assert.equal(normalizeInput(' ＬＵ​men  콘서트 '), 'lumen 콘서트');
  assert.equal(inputKind('ㄹㅁ'), 'chosung');
  assert.equal(normalizeInput('ㄹㅁ ㅎ'), 'ㄹㅁ ㅎ', 'NFKC 뒤 호환 자모로 되돌린다');
  assert.equal(normalizeInput('ㄱㅄㅀ'), 'ㄱㅄㅀ', '겹받침 호환 자모도 되돌린다(94자 역표)');
  assert.equal(inputKind(normalizeInput('ㄱㅄ')), 'chosung');
  assert.equal(normalizeInput('루\u3164멘'), '루멘', '한글 채움 문자는 NFKC 뒤에도 지운다');
  assert.equal(inputKind('루ㅁ'), 'hangul');
  assert.equal(inputKind('lumen'), 'roman');
  assert.equal(chosungOf('루멘 콘서트'), 'ㄹㅁ ㅋㅅㅌ');
});

const items = ['LUMEN 콘서트 2026 서울', 'LUMEN', 'LUNA 공연'].map((label) => ({ label }));
const hangul = ['루멘 팬미팅', '루멘 콘서트', '라멘 축제'].map((label) => ({ label }));
const label = (t) => t.label;

test('[SR-T11] 같은 검색은 같은 요청 값이다(대소문자·전각·겹친 공백), 정규화 뒤 50자를 넘으면 부르지 않는다', () => {
  const qs = ['LUMEN', 'Lumen', 'lumen', 'ＬＵＭＥＮ', ' lumen '].map(suggestRequestQuery);
  assert.deepEqual(new Set(qs), new Set(['lumen']));
  assert.equal(suggestRequestQuery('lu  men'), 'lu men');
  assert.equal(suggestRequestQuery('가'.repeat(51)), undefined);
  assert.equal(suggestRequestQuery(`${'가'.repeat(50)}   `), '가'.repeat(50), '공백을 지우고 50자면 부른다');
});

test('받은 후보가 8개보다 적으면 더 긴 입력은 그 안에서 거른다(같은 입력 종류, 두 글자 이상, 결과가 있을 때만)', () => {
  assert.deepEqual(refineLocally({ query: 'lu', items }, 'lume', label)?.map(label), ['LUMEN 콘서트 2026 서울', 'LUMEN']);
  assert.equal(refineLocally({ query: 'l', items }, 'lu', label), undefined, '앞선 입력이 한 글자');
  assert.equal(refineLocally({ query: '루멘', items: hangul.slice(0, 2) }, '루멘x', label), undefined, '거른 결과 0건이면 다시 요청');
  assert.deepEqual(refineLocally({ query: '루멘', items: hangul.slice(0, 2) }, '루멘 팬', label)?.map(label), ['루멘 팬미팅']);
  assert.equal(refineLocally({ query: 'lu', items }, 'luz', label), undefined, '거른 결과 0건이면 다시 요청');
  assert.equal(refineLocally({ query: 'lu', items: Array.from({ length: 8 }, () => ({ label: 'lumen' })) }, 'lum', label), undefined, '8개면 더 있을 수 있어 다시 요청');
  assert.equal(refineLocally({ query: 'lu', items }, 'ab', label), undefined, '앞선 입력으로 시작하지 않음');
  assert.equal(refineLocally({ query: '루', items: hangul.slice(0, 2) }, '루멘', label), undefined, '한글은 앞선 입력이 두 음절 이상');
  assert.deepEqual(refineLocally({ query: 'ㄹㅁ', items: hangul }, 'ㄹㅁ ㅍ', label)?.map(label), ['루멘 팬미팅'], '초성끼리');
  assert.equal(refineLocally({ query: 'ㄹㅁ', items: hangul }, 'ㄹㅁㅏ', label), undefined, '초성 → 낱자로 넘어가면 비교 방식이 바뀌어 다시 요청');
  assert.equal(refineLocally({ query: 'ㄹㅁ', items }, 'ㄹㅁ ㅍ', label), undefined, '앞선 답에 초성으로 설명되지 않는 후보(LUMEN)가 있으면 다시 요청');
  assert.equal(refineLocally(undefined, 'lumen', label), undefined);
  // 앞선 답에 브라우저가 설명하지 못하는 후보(다른 이름으로 맞은 'LUMENS')가 있으면 다시 요청한다
  assert.equal(refineLocally({ query: '루멘', items: [{ label: 'LUMENS' }, { label: '루멘스타 콘서트' }] }, '루멘스', label), undefined);
  // 띄어쓰기를 없앤 값으로도 견준다
  assert.deepEqual(refineLocally({ query: '루멘', items: [{ label: '루멘 콘서트' }, { label: '루멘 팬미팅' }] }, '루멘콘', label)?.map(label), ['루멘 콘서트']);
  // 서버가 8개를 줬는데 하나를 그리지 못해 뺐다면 더 있을 수 있어 다시 요청한다
  assert.equal(refineLocally({ query: 'lu', items, rawCount: 8 }, 'lum', label), undefined);
});

test('[ASVS v5.0.0-1.2.1] 계약 후보 → 셸 후보: 갈 곳, 오픈 일시, 서버가 준 굵게 위치만(범위 밖은 버림)', () => {
  assert.deepEqual(
    toShellSuggestion({ kind: 'PRODUCTION', label: 'LUMEN 콘서트', matches: [{ start: 0, length: 5 }, { start: 3, length: 99 }], productionId: 'p1', eventId: 'e1', nextOpenAt: '2026-11-20T11:00:00Z', posterUrl: 'https://img.peaket.example/p1', saleStatus: 'UPCOMING' }),
    { id: 'p-p1', kind: 'production', label: 'LUMEN 콘서트', href: '/events/e1', meta: '11/20(금) 20:00 오픈', posterUrl: 'https://img.peaket.example/p1', highlights: [[0, 5]] },
  );
  assert.deepEqual(toShellSuggestion({ kind: 'ARTIST', label: 'LUMEN', artistId: 'a 1' }), { id: 'a-a 1', kind: 'artist', label: 'LUMEN', href: '/search?artistId=a%201', highlights: [] });
  assert.equal(toShellSuggestion({ kind: 'PLACE', label: '피켓 아레나', placeId: 'v1' }).href, '/search?placeId=v1');
  assert.equal(toShellSuggestion({ kind: 'PRODUCTION', label: 'x' }), undefined, '대표 회차가 없으면 뺀다');
});

test('최근 검색어 저장 값 읽기: 모양이 틀리면 빈 목록, 10개까지', () => {
  assert.deepEqual(parseRecent(null), []);
  assert.deepEqual(parseRecent('not json'), []);
  assert.deepEqual(parseRecent('{"a":1}'), []);
  assert.deepEqual(parseRecent(JSON.stringify(['a', 1, '', 'b'])), ['a', 'b']);
  assert.equal(parseRecent(JSON.stringify(Array.from({ length: 20 }, (_, i) => `q${i}`))).length, 10);
  assert.deepEqual(parseRecent(JSON.stringify(['가'.repeat(51), 'ok'])), ['ok']);
});
