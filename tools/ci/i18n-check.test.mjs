// 번역 키 검사기 시험(docs/frontend.md §5.12, NFR-024).
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCatalogs, LOCALES } from './i18n-check.mjs';

const DIR = new URL('../../apps/web/src/shared/i18n/messages/', import.meta.url);

test('LCH-190 네 로케일 키가 같고 문구마다 review 표시가 있다', () => {
  const r = checkCatalogs();
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.summary.keys, 1);
  assert.equal(r.summary.native.ko, 1);
  assert.deepEqual([r.summary.machine.en, r.summary.machine.ja, r.summary.machine.zh], [1, 1, 1]);
});

test('LCH-190 키가 빠지거나 review가 틀리면 검사기가 실패한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-i18n-'));
  try {
    for (const locale of LOCALES) cpSync(new URL(`${locale}.json`, DIR), join(dir, `${locale}.json`));
    const en = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'));
    en['identity.domesticPhoneRequired'].review = 'unknown';
    writeFileSync(join(dir, 'en.json'), JSON.stringify(en));
    const badReview = checkCatalogs(dir);
    assert.equal(badReview.ok, false);
    assert.match(badReview.errors.join('\n'), /review/);

    const ja = JSON.parse(readFileSync(join(dir, 'ja.json'), 'utf8'));
    delete ja['identity.domesticPhoneRequired'];
    writeFileSync(join(dir, 'ja.json'), JSON.stringify(ja));
    const missing = checkCatalogs(dir);
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join('\n'), /키 목록/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LCH-190 빈 문구와 {자리} 불일치를 잡는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-i18n-'));
  try {
    for (const locale of LOCALES) cpSync(new URL(`${locale}.json`, DIR), join(dir, `${locale}.json`));
    const zh = JSON.parse(readFileSync(join(dir, 'zh.json'), 'utf8'));
    zh['identity.domesticPhoneRequired'].text = '   ';
    writeFileSync(join(dir, 'zh.json'), JSON.stringify(zh));
    const empty = checkCatalogs(dir);
    assert.equal(empty.ok, false);
    assert.match(empty.errors.join('\n'), /문구가 비었다/);

    cpSync(new URL('zh.json', DIR), join(dir, 'zh.json'));
    const en = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'));
    en['identity.domesticPhoneRequired'].text += ' {count}';
    writeFileSync(join(dir, 'en.json'), JSON.stringify(en));
    const placeholder = checkCatalogs(dir);
    assert.equal(placeholder.ok, false);
    assert.match(placeholder.errors.join('\n'), /자리/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
