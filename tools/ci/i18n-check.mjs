#!/usr/bin/env node
// 번역 키 검사(docs/frontend.md §5.12, NFR-024): 네 로케일의 키가 같고, 문구가 비어 있지 않고,
// 문구마다 `review: machine | native` 표시가 있는지 본다. `{이름}` 자리도 로케일끼리 같아야 한다.
// 쓰는 법: node tools/ci/i18n-check.mjs [--dir <폴더>]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCALES = ['ko', 'en', 'ja', 'zh'];
const HERE = fileURLToPath(new URL('../../apps/web/src/shared/i18n/messages/', import.meta.url));

const placeholders = (text) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).sort().join(',');

/** 폴더의 ko·en·ja·zh.json을 검사한다 */
export function checkCatalogs(dir = HERE) {
  const catalogs = Object.fromEntries(LOCALES.map((locale) => [locale, JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8'))]));
  const baseKeys = Object.keys(catalogs.ko).sort();
  const errors = [];
  const summary = { keys: baseKeys.length, machine: {}, native: {} };
  for (const locale of LOCALES) {
    const keys = Object.keys(catalogs[locale]).sort();
    if (keys.join('\n') !== baseKeys.join('\n')) errors.push(`${locale}: 키 목록이 ko와 다르다`);
    for (const key of baseKeys) {
      const entry = catalogs[locale][key];
      if (!entry || typeof entry.text !== 'string' || entry.text.trim() === '') {
        errors.push(`${locale}:${key}: 문구가 비었다`);
        continue;
      }
      if (!['machine', 'native'].includes(entry.review)) errors.push(`${locale}:${key}: review가 machine·native가 아니다`);
      else summary[entry.review][locale] = (summary[entry.review][locale] ?? 0) + 1;
      if (placeholders(entry.text) !== placeholders(catalogs.ko[key].text)) errors.push(`${locale}:${key}: {자리}가 ko와 다르다`);
    }
  }
  return { ok: errors.length === 0, errors, summary };
}

function main(argv) {
  let dir = HERE;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') dir = resolve(argv[++i] ?? '');
    else {
      console.error(`i18n-check: 모르는 인자: ${argv[i]}`);
      return 2;
    }
  }
  const r = checkCatalogs(dir);
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
