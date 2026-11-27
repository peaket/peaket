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
    for (const token of ['mode:entry', 'stateDegraded', 'ENTRY_DEGRADED', 'STATE_DEGRADED', '명령 6', '감사']) {
      expect(rb03, `RB-03에 ${token}이 없다`).toContain(token);
    }

    const rb04 = read('docs/runbooks/RB-04.md');
    expect(rb04, 'docs/runbooks/RB-04.md가 없다').not.toBe('');
    for (const token of ['STATE_MIRROR_FIXED', 'SOLD_OUT_STATIC', '500', '502', '503', '504', '2초', '1회', 'pollHintMs', '명령 6', '감사']) {
      expect(rb04, `RB-04에 ${token}이 없다`).toContain(token);
    }

    const infra = read('docs/infra.md');
    expect(infra, 'docs/infra.md §10이 RB-03.md를 잇지 않는다').toContain('RB-03.md');
    expect(infra, 'docs/infra.md §10이 RB-04.md를 잇지 않는다').toContain('RB-04.md');
  });
});
