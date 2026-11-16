// 트랜잭션 풀링(PgBouncer)에서는 세션 권고 잠금이 연결에 남아 다른 파드의 트랜잭션에 넘어간다. 서비스 코드는 트랜잭션 권고 잠금만 쓴다
// (리뷰 R165-19, ADR-0271 결정 12 '잠금과 임대', 계획 docs/review/plans/BAT-165.md '### 15'). 마이그레이션 잡(scripts/migrate.mjs)은 PgBouncer를 거치지 않아 셈에서 뺀다.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
const hits = (re: RegExp) => files(SRC).flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (re.test(line) ? [`${f.slice(SRC.length)}:${i + 1}`] : [])));

describe('권고 잠금', () => {
  test('HOT-270 서비스 코드는 세션 권고 잠금 함수를 쓰지 않는다(트랜잭션 풀링, R165-19)', () => {
    // 대조군: 같은 검사가 트랜잭션 권고 잠금은 찾는다(검사가 빈 결과로 통과하지 않게)
    expect(files(SRC).length).toBeGreaterThanOrEqual(50);
    expect(hits(/pg_try_advisory_xact_lock\(/).length).toBeGreaterThanOrEqual(1);
    // 세션 잠금 함수(이름 뒤 '(' 또는 _all). xact 이름은 걸리지 않는다
    expect(hits(/pg_advisory_lock\(|pg_try_advisory_lock\(|pg_advisory_unlock(_all)?\b/)).toEqual([]);
  });
});
