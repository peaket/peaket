// F-06-5 ops-svc 팬 조회 저장소 SQL 정적 검사(시험 담당 lane2-freeze-F-06-5-opencode, ASVS 1.2.4).
// 열람 기록·건 탭 조회는 파라미터 쿼리여야 한다. 구현 전에는 파일이 없어 실패한다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const source = (): string => {
  try {
    return readFileSync(join(process.cwd(), 'src', 'modules', 'fan-lookup', 'adapters', 'db', 'drizzle-fan-lookup.ts'), 'utf8');
  } catch {
    throw new Error('src/modules/fan-lookup/adapters/db/drizzle-fan-lookup.ts가 없다(계획 §3)');
  }
};

describe('ASVS v5.0.0-1.2.4 팬 조회 저장소 파라미터 쿼리', () => {
  test('drizzle 식·파라미터로 값을 넘기고 문자열 보간으로 SQL을 만들지 않는다', () => {
    const t = source();
    expect(t).toMatch(/from 'drizzle-orm'/);
    expect(t).toMatch(/\beq\s*\(/);
    expect(t).toMatch(/\.values\s*\(/);
    expect(t).toMatch(/\.where\s*\(/);
    expect(t).not.toMatch(/sql\.raw\s*\(/);
    expect(t).not.toMatch(/`[^`]*\$\{[^}]*(accountId|adminAccountId|reason|memberCode)[^}]*\}[^`]*(select|insert|update|delete)/i);
    expect(t).not.toMatch(/(select|insert|update|delete)[^;]*['"`]\s*\+\s*(accountId|adminAccountId|reason|memberCode)/i);
  });
});
