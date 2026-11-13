// LCH-190 카탈로그·로케일 주소 시험(docs/frontend.md §5.12, NFR-024, ADR-0060 결정 3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES, isLocale, languageAlternates, loadMessages, localePath, translate } from './catalog.ts';
import { domesticPhoneNotice } from './notice.ts';

test('LCH-190 로케일 넷과 주소 접두: 한국어는 접두 없음, 나머지는 /en·/ja·/zh', () => {
  assert.deepEqual([...LOCALES], ['ko', 'en', 'ja', 'zh']);
  assert.equal(isLocale('en'), true);
  assert.equal(isLocale('ko'), true);
  assert.equal(isLocale('fr'), false);
  assert.equal(localePath('ko', '/login'), '/login');
  assert.equal(localePath('en', '/login'), '/en/login');
  assert.equal(localePath('ja', '/events/e1'), '/ja/events/e1');
  assert.deepEqual(languageAlternates('/events/e1'), { ko: '/events/e1', en: '/en/events/e1', ja: '/ja/events/e1', zh: '/zh/events/e1' });
});

test('LCH-190 카탈로그는 네 로케일 모두 같은 키와 review 표시를 갖는다', async () => {
  for (const locale of LOCALES) {
    const messages = await loadMessages(locale);
    const entry = messages['identity.domesticPhoneRequired'];
    assert.ok(entry.text.length > 0, locale);
    assert.ok(['machine', 'native'].includes(entry.review), locale);
  }
});

test('LCH-190 review 표시는 한국어 native, 나머지 machine(원어민 검토 전)', async () => {
  // 원어민 검토를 마치면 해당 로케일을 native로 바꾸고 이 시험도 함께 고친다.
  assert.equal((await loadMessages('ko'))['identity.domesticPhoneRequired'].review, 'native');
  for (const locale of ['en', 'ja', 'zh']) {
    assert.equal((await loadMessages(locale))['identity.domesticPhoneRequired'].review, 'machine', locale);
  }
});

test('[ASVS v5.0.0-1.3.10] LCH-190 translate는 {자리}만 바꾸고 모르는 자리는 그대로 둔다', async () => {
  const messages = await loadMessages('ko');
  assert.equal(translate(messages, 'identity.domesticPhoneRequired'), messages['identity.domesticPhoneRequired'].text);
  const withVar = { 'x.y': { text: '앞 {count}개', review: 'native' } };
  assert.equal(translate(withVar, 'x.y', { count: 3 }), '앞 3개');
  assert.equal(translate(withVar, 'x.y', {}), '앞 {count}개');
  assert.throws(() => translate(withVar, 'x.z'), /missing key/);
});

test('LCH-190 구매 조건 알림은 en·ja·zh에만 있고 한국어에는 없다', async () => {
  assert.equal(await domesticPhoneNotice('ko'), undefined);
  assert.equal(await domesticPhoneNotice(undefined), undefined);
  for (const locale of ['en', 'ja', 'zh']) {
    const text = await domesticPhoneNotice(locale);
    assert.ok(text && text.length > 0, locale);
  }
});
