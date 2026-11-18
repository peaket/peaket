// 통합 시험 도우미 waitReady(test-int/media-support.ts)의 시험(BAT-174 계획 12 (ㄱ), 시험 이의 7). Docker 없이 돈다.
// 시작 파일로 띄운 아이 프로세스가 준비 전에 끝나면 기다림이 남은 시간을 쓰지 않고 실패하고, 실패 메시지에 끝 코드와 아이 출력 끝 40줄이 실린다.
// 판정은 메시지의 글로 하고 벽시계 짧은 상한에 기대지 않는다(기다림 상한 30초를 다 쓰면 '시간이 지났다' 글이 나와 실패한다).
import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { freePort, until, waitReady } from '../test-int/media-support.js';

const kids: ChildProcess[] = [];
function node(code: string): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  kids.push(child);
  let text = '';
  child.stdout!.on('data', (d) => (text += String(d)));
  child.stderr!.on('data', (d) => (text += String(d)));
  return { child, output: () => text };
}
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null && k.signalCode === null) k.kill();
});

describe('통합 시험 도우미: 시작 파일 아이의 준비 기다림', () => {
  test('BAT-174 (다) 시작 파일로 띄운 아이가 준비 전에 끝나면 기다림은 바로 실패하고 끝 코드와 출력을 보인다', async () => {
    const url = `http://127.0.0.1:${await freePort()}/ready`;
    const k = node("for (let i = 0; i < 100; i++) console.error('line ' + i); console.error('boom'); process.exit(3)");
    const e = await waitReady(url, k.child, k.output, 'core-svc 준비', 30_000, 200).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(e).toBeInstanceOf(Error);
    const msg = e!.message;
    expect(msg).toContain('준비 전에 아이 프로세스가 끝났다(끝 코드 3)');
    expect(msg).not.toContain('시간이 지났다');
    expect(msg).toContain('core-svc 준비');
    // 끝 40줄: 'line 61'~'line 99'와 'boom'만 싣는다
    expect(msg).toContain('boom');
    expect(msg).toContain('line 61\n');
    expect(msg).not.toContain('line 60\n');
  }, 60_000);

  test('BAT-174 (다) 준비 기다림이 시간을 넘기면 그때의 아이 출력 끝 40줄을 싣는다(기다리기 시작한 뒤에 나온 출력도)', async () => {
    const url = `http://127.0.0.1:${await freePort()}/ready`;
    // 표준 입력을 받으면 100줄을 쓰고, 끝나지 않고 머문다
    const k = node("process.stdin.once('data', () => { for (let i = 0; i < 100; i++) console.error('late ' + i); }); setInterval(() => {}, 1000)");
    const waiting = waitReady(url, k.child, k.output, 'core-svc 준비', 10_000, 50).then(
      () => undefined,
      (err: Error) => err,
    );
    k.child.stdin!.write('go\n');
    await until(() => k.output().includes('late 99'), '아이 출력 100줄', 20_000);
    const e = await waiting;
    expect(e).toBeInstanceOf(Error);
    const msg = e!.message;
    expect(msg).toContain('기다리다 시간이 지났다: core-svc 준비');
    expect(msg).not.toContain('아이 프로세스가 끝났다');
    expect(msg).toContain('late 99');
    expect(msg).toContain('late 60\n');
    expect(msg).not.toContain('late 59\n');
  }, 60_000);
});
