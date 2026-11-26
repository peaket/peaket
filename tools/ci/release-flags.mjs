#!/usr/bin/env node
// 릴리스 플래그 정의 검사(docs/devops.md §5.4, ADR-0386 결정 5, BAS-060, F-09-2 계획 §5).
// 끝 코드: 0 통과, 1 스키마·중복·로컬 한정 위반, 2 파일을 읽지 못함·인자 오류. 만료는 경고만 한다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    'local-only': { type: 'boolean', default: false },
    root: { type: 'string', default: '.' },
    now: { type: 'string' },
  },
});
if (!values.check && !values['local-only']) {
  console.error('쓰는 법: node tools/ci/release-flags.mjs [--check|--local-only] [--root <폴더>] [--now YYYY-MM-DD]');
  process.exit(2);
}
const ROOT = resolve(values.root);
const now = values.now ?? new Date().toISOString().slice(0, 10);
const envsDir = join(ROOT, 'deploy', 'envs');
if (!existsSync(envsDir)) process.exit(0);

const errors = [];
const warnings = [];
let readFailure = false;

function fail(path, message) {
  errors.push(`막음: ${path}: ${message}`);
}

for (const env of readdirSync(envsDir).sort()) {
  const dir = join(envsDir, env, 'flags');
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) continue;
  if (values['local-only'] && env !== 'local') fail(join(dir, files[0]), `${env} 환경에는 릴리스 플래그를 두지 않는다(local만)`);
  const names = new Set();
  for (const file of files) {
    const path = join(dir, file);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      readFailure = true;
      console.error(`읽지 못함: ${relative(ROOT, path)}`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.flags !== 'object' || parsed.flags === null) {
      fail(relative(ROOT, path), 'flags 객체가 없다');
      continue;
    }
    for (const [name, flag] of Object.entries(parsed.flags)) {
      if (names.has(name)) fail(relative(ROOT, path), `같은 환경에서 플래그 이름이 중복된다: ${name}`);
      names.add(name);
      if (typeof flag !== 'object' || flag === null) {
        fail(relative(ROOT, path), `${name} 정의가 객체가 아니다`);
        continue;
      }
      const metadata = flag.metadata;
      if (typeof metadata !== 'object' || metadata === null || typeof metadata.owner !== 'string' || metadata.owner.trim() === '' || typeof metadata.expiresAt !== 'string' || metadata.expiresAt.trim() === '') {
        fail(relative(ROOT, path), `${name}에 metadata.owner·metadata.expiresAt이 필요하다`);
      } else if (metadata.expiresAt < now) {
        warnings.push(`만료: ${name} (${metadata.expiresAt})`);
      }
      if (flag.defaultVariant !== 'off') fail(relative(ROOT, path), `${name}의 defaultVariant는 off여야 한다`);
      const variants = flag.variants;
      if (typeof variants !== 'object' || variants === null || variants.on !== true || variants.off !== false) {
        fail(relative(ROOT, path), `${name}의 variants는 {on:true, off:false}여야 한다`);
      }
    }
  }
}

for (const warning of warnings) console.error(warning);
for (const error of errors) console.error(error);
process.exit(readFailure ? 2 : errors.length > 0 ? 1 : 0);
