// F-02-6(동결 로컬) RB-03·RB-04 런북의 정적 계약. 구현/문서 전에는 파일이 없어 실패한다.
// 정본: docs/infra.md §10 RB-03·RB-04, docs/features/control-tower.md §3 명령 6, §5 'CDN 설정 API',
// docs/features/queue-admission.md §4·§9, ADR-0078 결정 2, ADR-0223 결정 1·8.
// 수치 주장 없음: 이 파일은 처리량·인원·K1/K2/K7 수치를 새로 주장하지 않는다.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : '');

describe('F026-RB RB-03·RB-04 런북', () => {
  test('F026-RB ① RB-03·RB-04가 네 모드·원본 그룹 값·해제 절차·감사 확인을 담고 infra §10에서 이어진다', () => {
    const rb03 = read('docs/runbooks/RB-03.md');
    expect(rb03, 'docs/runbooks/RB-03.md가 없다').not.toBe('');
    for (const token of ['mode:entry', 'stateDegraded', 'pollHintMs', 'ENTRY_DEGRADED', 'STATE_DEGRADED', '명령 6', '되돌리기', '감사 기록']) {
      expect(rb03, `RB-03에 ${token}이 없다`).toContain(token);
    }
    // 토큰만 늘어놓은 문서가 아니라 실제 절차 단계가 있어야 한다
    expect((rb03.match(/^\s*\d+\./gm) ?? []).length, 'RB-03에 번호 붙은 절차가 3단계보다 적다').toBeGreaterThanOrEqual(3);
    expect(rb03, 'RB-03에 해제(되돌리기) 판 번호·확인 문구가 없다').toMatch(/mode:entry[\s\S]{0,400}(해제|되돌리기)/);

    const rb04 = read('docs/runbooks/RB-04.md');
    expect(rb04, 'docs/runbooks/RB-04.md가 없다').not.toBe('');
    for (const token of ['STATE_MIRROR_FIXED', 'SOLD_OUT_STATIC', '원본 그룹', '500', '502', '503', '504', '2초', '1회', 'pollHintMs', '명령 6', '되돌리기', '감사 기록']) {
      expect(rb04, `RB-04에 ${token}이 없다`).toContain(token);
    }
    expect((rb04.match(/^\s*\d+\./gm) ?? []).length, 'RB-04에 번호 붙은 절차가 3단계보다 적다').toBeGreaterThanOrEqual(3);
    expect(rb04, 'RB-04에 원본 그룹 확인과 S3 고정 해제가 이어지지 않는다').toMatch(/원본 그룹[\s\S]{0,400}STATE_MIRROR_FIXED/);

    // docs/infra.md §10의 색인 행에서 이어져야 한다(다른 절의 링크로는 통과하지 않는다)
    const infra = read('docs/infra.md');
    const from = infra.indexOf('## 10. 런북 목차');
    const to = infra.indexOf('## 11.', from);
    expect(from).toBeGreaterThanOrEqual(0);
    const section10 = infra.slice(from, to);
    expect(section10, 'docs/infra.md §10이 RB-03.md를 잇지 않는다').toContain('runbooks/RB-03.md');
    expect(section10, 'docs/infra.md §10이 RB-04.md를 잇지 않는다').toContain('runbooks/RB-04.md');
  });
});
