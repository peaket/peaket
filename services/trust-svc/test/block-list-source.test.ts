// 원본 검사 B-T9 ①: 차단 기기 목록(tr:block)을 새로 올리는 코드는 라벨 반영 저장소 한 곳뿐이다(docs/features/bot-defense.md §9 '올리는 조건', trust.proto ApplyLabel 주석).
// 추가 검증 실패·허니팟 적중·재평가 후보 같은 자동 신호의 코드에는 차단 키를 쓰는 길이 없다. 재평가 작업자(trust-reassess)는 아직 없다(BUILD_ORDER OPS-180).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const rel = (p: string) => p.slice(repo.length).replaceAll('\\', '/');
/** 차단 키를 가리키는 글: 키 이름 'tr:block:'(판 가드 tr:blkv는 아니다)과 키 함수 keys.block( */
const BLOCK_KEY = /tr:block:|keys\.block\(/;

describe('B-T9① 차단 키를 쓰는 곳', () => {
  test('B-T9①_서비스원본에서차단키를가리키는파일은trust-svc의피처저장소와라벨반영저장소둘뿐이다', () => {
    const services = join(repo, 'services');
    const files = readdirSync(services)
      .map((s) => join(services, s, 'src'))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      })
      .flatMap(walk)
      .filter((f) => /\.(ts|js|mjs|lua)$/.test(f));
    expect(files.length).toBeGreaterThan(50);
    const hits = files.filter((f) => BLOCK_KEY.test(readFileSync(f, 'utf8'))).map(rel).sort();
    expect(hits).toEqual(['services/trust-svc/src/modules/scoring/adapters/redis-feature-store.ts', 'services/trust-svc/src/modules/scoring/adapters/redis-label-store.ts']);
  });

  test('B-T9①_피처저장소는차단키를읽기(EXISTS)와이음의옮기기(있는키를새판이름으로)로만다루고_값을새로쓰지않는다', () => {
    const text = readFileSync(join(repo, 'services/trust-svc/src/modules/scoring/adapters/redis-feature-store.ts'), 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => BLOCK_KEY.test(l));
    const allowed = [
      // 키 이름 정의
      /^\s*block: \(ref: string\) => `tr:block:\{\$\{ref\}\}`,$/,
      // 판정의 확정 신호 읽기
      /\['EXISTS', keys\.block\(ref\)\]/,
      // 키 회전의 이음: 옛 판 키 → 새 판 키(DUMP·RESTORE)
      /^\s*block: \[keys\.block\(i\.from\), keys\.block\(i\.to\)\],$/,
    ];
    // 머리 주석 한 줄은 이 규칙을 적은 글이다
    const code = lines.filter((l) => !l.trimStart().startsWith('//'));
    expect(code.length).toBe(3);
    for (const l of code) expect(allowed.some((re) => re.test(l)), l).toBe(true);
  });

  test('B-T9①_차단키에값을쓰는Lua는라벨반영저장소의한스크립트뿐이고_그스크립트는판가드와함께쓴다', () => {
    const label = readFileSync(join(repo, 'services/trust-svc/src/modules/scoring/adapters/redis-label-store.ts'), 'utf8');
    const sets = label.match(/redis\.call\('SET', bk,/g) ?? [];
    expect(sets).toHaveLength(1);
    expect(label).toMatch(/redis\.call\('HSET', gk, e, ARGV\[2\] \.\. '\|' \.\. result\)/);
    const feature = readFileSync(join(repo, 'services/trust-svc/src/modules/scoring/adapters/redis-feature-store.ts'), 'utf8');
    // 피처 저장소의 SET은 판정 근거 키(e)·허니팟 표시(KEYS[1])·이어 달기(KEYS[2]·refNext)뿐이다
    const featureSets = [...feature.matchAll(/'SET', ([A-Za-z0-9_[\]]+)/g)].map((m) => m[1]).sort();
    expect(featureSets).toEqual(['KEYS[1]', 'KEYS[2]', 'e', 'refNext']);
  });
});
