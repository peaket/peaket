// BAT-179: Next.js 보안 판 올림(16.4.3 → 16.4.5)을 지키는 시험(T1).
// 두 Next 앱의 선언 최소 판과 잠금 파일의 next 주변 판이 16.4.5 이상인지,
// next 관련 16.4.0~16.4.4가 남지 않는지 본다. 구현 전 트리에서는 실패해야 한다.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 이 묶음이 정한 보안 수정판. 다음 판 올림 때 시험과 함께 올린다.
const FLOOR = '16.4.5';
const ROOT = new URL('../../../', import.meta.url);

const readJson = (path) => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));

const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
  return match ? match.slice(1).map(Number) : undefined;
};

const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

// "^16.4.5"·"~16.4.5"·">=16.4.5"·"16.4.5"에서 최소 판을 뽑는다.
const declaredFloor = (range) => {
  const match = /^(?:\^|~|>=)?\s*v?(\d+\.\d+\.\d+)/.exec(range ?? '');
  return match?.[1];
};

const isAtLeastFloor = (version) => {
  const parsed = typeof version === 'string' ? parseVersion(version) : version;
  const floor = parseVersion(FLOOR);
  return Boolean(parsed) && compareVersions(parsed, floor) >= 0;
};

const lockText = readFileSync(new URL('pnpm-lock.yaml', ROOT), 'utf8');

test('두 Next 앱의 next 선언이 같고 최소 판이 16.4.5 이상이다', () => {
  const webNext = readJson('apps/web/package.json').dependencies.next;
  const partnerNext = readJson('apps/partner/package.json').dependencies.next;

  assert.ok(webNext, 'apps/web/package.json의 dependencies.next가 없다');
  assert.ok(partnerNext, 'apps/partner/package.json의 dependencies.next가 없다');
  assert.equal(webNext, partnerNext, `두 앱의 next 선언이 다르다: web=${webNext}, partner=${partnerNext}`);

  const floor = declaredFloor(webNext);
  assert.ok(floor, `next 선언에서 최소 판을 읽지 못했다: ${webNext}`);
  assert.ok(
    isAtLeastFloor(floor),
    `next 선언의 최소 판이 ${FLOOR}보다 낮다: ${webNext} (최소 ${floor})`,
  );
});

test('잠금 파일의 작업 공간 next 해결 판이 16.4.5 이상이다', () => {
  // importers 아래 two 앱의 "next:" 항목(specifier·version)을 읽는다.
  const blocks = [...lockText.matchAll(/\n {6}next:\n {8}specifier: ([^\n]+)\n {8}version: ([^\s(]+)/g)];
  assert.equal(blocks.length, 2, `잠금 파일에서 Next 앱 두 곳의 next 항목을 찾지 못했다(찾은 수: ${blocks.length})`);

  const specifiers = new Set(blocks.map(([, specifier]) => specifier));
  assert.equal(specifiers.size, 1, `잠금 파일의 next specifier가 서로 다르다: ${[...specifiers].join(', ')}`);

  const [specifier] = specifiers;
  const floor = declaredFloor(specifier);
  assert.ok(
    floor && isAtLeastFloor(floor),
    `잠금 파일의 next specifier가 ${FLOOR}보다 낮다: ${specifier}`,
  );

  for (const [, declared, resolved] of blocks) {
    assert.ok(
      isAtLeastFloor(resolved),
      `잠금 파일의 next 해결 판이 ${FLOOR}보다 낮다: ${declared} → ${resolved}`,
    );
  }
});

test('잠금 파일의 next@·@next/env@·@next/swc-*@ 판이 16.4.5 이상이다', () => {
  const pattern = /^ {2}'?(next|@next\/env|@next\/swc-[a-z0-9-]+)@(\d+\.\d+\.\d+)'?[:(]/gm;
  const versions = new Map();
  for (const match of lockText.matchAll(pattern)) {
    versions.set(`${match[1]}@${match[2]}`, { name: match[1], version: match[2] });
  }

  assert.ok(versions.size > 0, '잠금 파일에서 next 관련 판을 하나도 찾지 못했다');

  const stale = [...versions.values()].filter(({ version }) => !isAtLeastFloor(version));
  assert.deepEqual(
    stale.map(({ name, version }) => `${name}@${version}`),
    [],
    `잠금 파일의 next 관련 판이 ${FLOOR}보다 낮다`,
  );
});

test('잠금 파일에 next 관련 16.4.0~16.4.4가 남지 않는다', () => {
  const oldVersion = /(?:^|[^/])\bnext@16\.4\.[0-4]\b|@next\/env@16\.4\.[0-4]\b|@next\/swc-[a-z0-9-]+@16\.4\.[0-4]\b/;
  const staleLines = lockText
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => oldVersion.test(line));

  assert.deepEqual(
    staleLines.map(({ line, number }) => `${number}: ${line}`),
    [],
    '잠금 파일에 next 관련 옛 판(16.4.0~16.4.4)이 남아 있다',
  );

  // @serwist/turbopack의 peer 묶음이 옛 next를 가리키면 Next 두 판이 함께 설치된다.
  const serwistStale = lockText
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.includes('@serwist/turbopack') && /next@16\.4\.[0-4]\b/.test(line));

  assert.deepEqual(
    serwistStale.map(({ line, number }) => `${number}: ${line}`),
    [],
    `@serwist/turbopack의 peer 묶음이 옛 next를 가리킨다`,
  );
});
