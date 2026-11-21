// queue-svc 시작 파일(src/start.ts)이 듣기 전에 종료 세션 목록 소비를 켜고 서비스를 닫은 뒤 끄는지 소스 경계로 본다
// (docs/features/identity.md §3 '서비스에 잇기'·§12 I-T3 ②, ADR-0333 결정 1·2, BUILD_ORDER HOT-401 묶음 BAT-059).
// 시험 조립이 아니라 시작 파일의 조립을 본다(시험 조립은 도우미를 부르지 않아도 통과한다). 도우미 자체는 packages/platform 시험이 본다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const SOURCE = readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8');
/** 주석을 뺀 코드(주석 속 이름에 속지 않게) */
const CODE = SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n');

describe('queue-svc 종료 세션 목록 소비 조립(I-T3 ②)', () => {
  test('I-T3 ②-8 queue-svc 시작 파일은 시간 옵션 없이 도우미를 한 번 부르고, 그 호출이 service.listen보다 앞이다', () => {
    const calls = [...CODE.matchAll(/startServiceControlSync\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls).toEqual(['service, env']);
    const call = CODE.indexOf('startServiceControlSync(service, env)');
    const listen = CODE.indexOf('service.listen(');
    expect(listen).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(listen);
  });

  test('I-T3 ②-9 queue-svc 시작 파일은 닫는 경로에서 서비스를 닫은 뒤 소비를 끈다', () => {
    const closeService = CODE.lastIndexOf('.then(() => service.close())');
    const closeSync = CODE.lastIndexOf('.then(() => controlSync?.close())');
    expect(closeService).toBeGreaterThan(0);
    expect(closeSync).toBeGreaterThan(closeService);
  });
});
