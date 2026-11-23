// R-T47 ③ payment-svc 시작 조립(F-07-8 계획 §5.1(라) 조립, §6 '시험 담당에게': 시작 파일 조립은 시험 조립과 따로 본다).
// 운영 조립(start.ts)이 배상 송금 결과 확정 바퀴(CompensationRefreshLoop, 리더 하나)를 만들어 시작하는지 글 경계로 고정한다.
// 기준 트리: 바퀴가 없어 실패한다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const source = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('R-T47 ③ start.ts는 배상 송금 결과 확정 바퀴를 만들고 시작한다', () => {
  const s = source('start.ts');
  expect(s).toContain('new CompensationRefreshLoop(');
  expect(s).toMatch(/new CompensationRefreshLoop\([\s\S]*?\.start\(\)/);
});
