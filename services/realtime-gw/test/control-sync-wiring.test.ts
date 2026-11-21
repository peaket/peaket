// realtime-gw 시작 함수(src/start.ts, main.ts와 합본이 함께 부른다)가 듣기 전에 제어 설정 토픽(control.settings) 읽기를 켜고, 닫는 경로와 시작 실패 경로에서
// 서비스를 닫은 뒤 끄는지 소스 경계로 본다(docs/features/control-tower.md C-T75 ②, docs/api/asyncapi.yaml control.settings '모든 서비스의 모든 파드',
// docs/features/identity.md §3 '서비스에 잇기', ADR-0334 결정 2, BUILD_ORDER BAT-215 리뷰 RV215-1). BAT-059의 control-sync-wiring.test.ts와 같은 꼴이다.
// 시험 조립이 아니라 시작 파일의 조립을 본다. 도우미 자체는 packages/platform 시험이 본다. realtime-gw는 입장 토큰만 받고 sid가 없어 설정 토픽만 읽는다(sessions: false).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const strip = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
/** 주석을 뺀 코드(주석 속 이름에 속지 않게) */
const CODE = strip(readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8'));
const MAIN = strip(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'));

describe('realtime-gw 제어 설정 토픽 읽기 조립(C-T75 ②, ADR-0334 결정 2)', () => {
  test('C-T75 ② realtime-gw 시작 함수는 설정 토픽만 읽는 도우미(sessions: false)를 시간 옵션 없이 한 번 부르고, 그 호출이 started.listen보다 앞이며, 시작 파일은 프로세스 환경을 넘긴다', () => {
    const calls = [...CODE.matchAll(/startServiceControlSync\(([^()]*)\)/g)].map((m) => m[1]);
    expect(calls).toEqual(['started, env, { sessions: false }']);
    const call = CODE.indexOf('controlSync = startServiceControlSync(started, env, { sessions: false })');
    const listen = CODE.indexOf('await started.listen(');
    expect(call).toBeGreaterThan(0);
    expect(listen).toBeGreaterThan(0);
    expect(call).toBeLessThan(listen);
    expect(CODE).toMatch(/const \{ env \} = o;/);
    expect(MAIN).toContain('start({ env: process.env })');
  });

  test('C-T75 ② realtime-gw 시작 함수는 내리는 경로(shutdown)에서 서비스를 닫은 뒤 설정 토픽 읽기를 끄고, 시작 실패 경로(catch)에서도 서비스를 닫은 뒤 끈다', () => {
    const shutdown = CODE.indexOf('const shutdown = async (): Promise<void> =>');
    expect(shutdown).toBeGreaterThan(0);
    // 내리는 경로: 서비스를 닫은 뒤 finally에서 끈다(서비스 닫기가 실패해도 끈다)
    const down = CODE.slice(shutdown, CODE.indexOf('const close = (): Promise<void> =>', shutdown));
    const closeService = down.indexOf('await started.close()');
    const finallyAt = down.indexOf('} finally {');
    const closeSync = down.indexOf('await startedControlSync?.close()');
    expect(closeService).toBeGreaterThan(0);
    expect(finallyAt).toBeGreaterThan(closeService);
    expect(closeSync).toBeGreaterThan(finallyAt);
    // 끄는 대상은 시작 때 받은 그 소비다
    expect(CODE).toContain('const startedControlSync = controlSync;');
    // 시작 실패 경로
    const failed = CODE.slice(CODE.lastIndexOf('} catch (err) {'));
    const failService = failed.indexOf('await service?.close()');
    const failSync = failed.indexOf('await controlSync?.close()');
    expect(failService).toBeGreaterThan(0);
    expect(failSync).toBeGreaterThan(failService);
    expect(failed.indexOf('throw err')).toBeGreaterThan(failSync);
  });
});
