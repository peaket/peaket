// 임시저장 관리(ADR-0245). 저장소를 가짜로 두고 복원·저장·지우기의 순서를 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DraftKeeper } from './draft-keeper.ts';
import { emptyDraft, parseDraft, serializeDraft } from './form.ts';

function fakeStore(initial = null) {
  const s = {
    draft: initial,
    key: null,
    writable: true,
    readDraft: () => s.draft,
    writeDraft: (v) => {
      if (!s.writable) return false;
      s.draft = v;
      return true;
    },
    readKey: () => s.key,
    writeKey: (v) => {
      if (!s.writable) return false;
      s.key = v;
      return true;
    },
    clear: () => {
      s.draft = null;
      s.key = null;
    },
  };
  return s;
}
const named = (title) => ({ ...emptyDraft(), title });
const stored = (s) => parseDraft(s.draft)?.title;

test('임시저장: 복원 전에는 저장하지 않고, 복원 직후 flush가 저장값을 빈 값으로 덮지 않는다(StrictMode 이중 실행)', () => {
  const s = fakeStore(serializeDraft(named('저장본')));
  const k = new DraftKeeper(s, emptyDraft());
  assert.equal(k.flush(), 'none');
  assert.equal(k.restore()?.title, '저장본');
  assert.equal(k.flush(), 'none');
  assert.equal(k.restore()?.title, '저장본');
  assert.equal(stored(s), '저장본');
});

test('임시저장: 바뀐 값만 저장한다', () => {
  const s = fakeStore();
  const k = new DraftKeeper(s, emptyDraft());
  assert.equal(k.restore(), null);
  assert.equal(k.isDirty(), false);
  assert.equal(k.flush(), 'none');
  k.change(named('a'));
  assert.equal(k.isDirty(), true);
  assert.equal(k.flush(), 'saved');
  assert.equal(stored(s), 'a');
  assert.equal(k.flush(), 'none');
});

test('리뷰 재현: 저장에 실패하면 다음 flush가 다시 시도한다', () => {
  const s = fakeStore();
  s.writable = false;
  const k = new DraftKeeper(s, emptyDraft());
  k.restore();
  k.change(named('a'));
  assert.equal(k.flush(), 'failed');
  s.writable = true;
  assert.equal(k.flush(), 'saved');
  assert.equal(stored(s), 'a');
});

test('리뷰 재현: 처음부터 다시는 지운 초안을 다시 쓰지 않고, 빈 값도 저장하지 않는다', () => {
  const s = fakeStore(serializeDraft(named('옛 초안')));
  const k = new DraftKeeper(s, emptyDraft());
  k.restore();
  k.change(named('옛 초안 고침'));
  k.reset(emptyDraft());
  assert.equal(s.draft, null);
  assert.equal(k.flush(), 'none');
  assert.equal(s.draft, null);
  k.change(named('새 입력'));
  assert.equal(k.flush(), 'saved');
  assert.equal(stored(s), '새 입력');
});

test('등록이 끝나면 저장을 지우고 더 쓰지 않는다', () => {
  const s = fakeStore();
  const k = new DraftKeeper(s, emptyDraft());
  k.restore();
  k.change(named('a'));
  k.flush();
  s.key = '{"key":"k","body":"{}"}';
  k.change(named('b'));
  k.finish();
  assert.equal(s.draft, null);
  assert.equal(s.key, null);
  assert.equal(k.flush(), 'none');
});

test('리뷰 재현: 다른 탭이 지우면 이 탭은 더 저장하지 않는다(등록이 끝난 초안을 되살리지 않는다)', () => {
  const s = fakeStore();
  const k = new DraftKeeper(s, emptyDraft());
  k.restore();
  k.change(named('a'));
  s.clear();
  assert.equal(k.fromOtherTab(null), 'closed');
  assert.equal(k.flush(), 'none');
  assert.equal(s.draft, null);
  k.reset(emptyDraft());
  k.change(named('다시'));
  assert.equal(k.flush(), 'saved');
});

test('리뷰 재현: 다른 탭의 저장을 따라오고, 따라온 값은 다시 쓰지 않는다', () => {
  const s = fakeStore();
  const k = new DraftKeeper(s, emptyDraft());
  k.restore();
  const other = named('다른 탭');
  s.draft = serializeDraft(other);
  assert.equal(k.fromOtherTab(other), 'adopted');
  assert.equal(k.isDirty(), false);
  assert.equal(k.flush(), 'none');
});

test('리뷰 재현: 저장소를 못 써도 같은 본문이면 같은 멱등 키다', () => {
  const s = fakeStore();
  s.writable = false;
  const k = new DraftKeeper(s, emptyDraft());
  k.restore();
  let n = 0;
  const make = () => `key-${++n}`;
  assert.equal(k.requestKey({ a: 1 }, make), 'key-1');
  assert.equal(k.requestKey({ a: 1 }, make), 'key-1');
  assert.equal(k.requestKey({ a: 2 }, make), 'key-2');
});

test('멱등 키: 새로고침해도 저장한 키를 쓴다', () => {
  const s = fakeStore();
  let n = 0;
  const make = () => `key-${++n}`;
  new DraftKeeper(s, emptyDraft()).requestKey({ a: 1 }, make);
  assert.equal(new DraftKeeper(s, emptyDraft()).requestKey({ a: 1 }, make), 'key-1');
});
