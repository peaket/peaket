// F-01-8 identity 법정 접속기록 줄 시험(docs/features/identity.md §9, ASVS v5.0.0-16.3.1·16.3.2).
// 줄은 표준 출력 한 줄(JSON)이고, 법정 사본 갈래만 읽는다. 토큰·비밀번호·쿠키·본문은 싣지 않는다.
import { describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { createLegalAccessLog, recordLegalAccess } from '../src/modules/session/legal-access-log.js';
import { kit } from './support.js';

const NOW = Date.parse('2026-11-24T03:00:00.000Z');

function harness() {
  const lines: string[] = [];
  const log = createLegalAccessLog({ write: (line) => lines.push(line), now: () => NOW, pod: 'identity-0' });
  return { lines, log, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('F-01-8 identity 법정 접속기록 줄', () => {
  test('16.3.1 [ASVS v5.0.0-16.3.1] 로그인·재인증·로그아웃·토큰 갱신의 성공은 결과·요소·seq를 싣는다', () => {
    const t = harness();
    t.log.record({ event: 'LOGIN', result: 'SUCCESS', provider: 'kakao', clientIp: '203.0.113.7', userAgent: 'Chrome/130', requestId: 'req-1', accountId: 'acc-1' });
    t.log.record({ event: 'REAUTH', result: 'SUCCESS', factors: ['password', 'totp', 'passkey'], act: 'OPS_COMMAND', clientIp: '203.0.113.7', requestId: 'req-2', accountId: 'acc-2' });
    t.log.record({ event: 'LOGOUT', result: 'SUCCESS', requestId: 'req-3', accountId: 'acc-1' });
    t.log.record({ event: 'REFRESH', result: 'SUCCESS', requestId: 'req-4', accountId: 'acc-1' });

    const [login, reauth, logout, refresh] = t.parsed();
    expect(login).toMatchObject({ kind: 'legal-access', service: 'identity-svc', event: 'LOGIN', result: 'SUCCESS', provider: 'kakao', client_ip: '203.0.113.7', user_agent: 'Chrome/130', request_id: 'req-1', account_id: 'acc-1', pod: 'identity-0', seq: 1 });
    expect(login.ts).toBe('2026-11-24T12:00:00.000+09:00');
    expect(reauth).toMatchObject({ event: 'REAUTH', result: 'SUCCESS', factors: ['password', 'totp', 'passkey'], act: 'OPS_COMMAND', seq: 2 });
    expect(logout).toMatchObject({ event: 'LOGOUT', result: 'SUCCESS', seq: 3 });
    expect(refresh).toMatchObject({ event: 'REFRESH', result: 'SUCCESS', seq: 4 });
    // 파드마다 늘어나기만 하고 빈 값이 없다
    expect(t.parsed().map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(t.parsed().every((l) => Number.isInteger(l.seq) && (l.seq as number) > 0)).toBe(true);
  });

  test('16.3.2 [ASVS v5.0.0-16.3.2] 실패한 인증 시도는 실패 종류를 싣고 성공과 같은 seq를 쓴다', () => {
    const t = harness();
    for (const failure of ['password', 'totp', 'passkey', 'locked', 'session'] as const)
      t.log.record({ event: 'REAUTH', result: 'FAILED', failure, act: 'APPROVAL', accountId: 'acc-1' });
    const lines = t.parsed();
    expect(lines.map((l) => l.failure)).toEqual(['password', 'totp', 'passkey', 'locked', 'session']);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
    // 실패 줄에는 요소가 없다(확인하지 못했다)
    expect(lines.every((l) => l.factors === undefined)).toBe(true);
    // 모르는 실패 종류·이벤트·결과는 지어내지 않고 던진다
    expect(() => t.log.record({ event: 'REAUTH', result: 'FAILED', failure: 'other' as never })).toThrow();
    expect(() => t.log.record({ event: 'SIGNUP' as never, result: 'SUCCESS' })).toThrow();
    expect(() => t.log.record({ event: 'LOGIN', result: 'MAYBE' as never })).toThrow();
  });

  test('16.3.1 [ASVS v5.0.0-16.3.1] 비밀번호·토큰·쿠키·본문은 줄에 싣지 않고 User-Agent는 512자로 끊는다', () => {
    const t = harness();
    // 실수로 넘긴 값도 줄에 새지 않는다(칸을 골라 쓴다)
    t.log.record({
      event: 'LOGIN',
      result: 'FAILED',
      failure: 'password',
      userAgent: '가'.repeat(600),
      clientIp: '2001:db8::1',
      token: 'secret-token',
      password: 'secret-pw',
      authorization: 'Bearer secret',
      cookie: 'session=secret',
      email: 'fan@example.test',
      phone: '010-1234-5678',
    } as never);
    const [line] = t.parsed();
    expect(line.client_ip).toBe('2001:db8::1');
    expect((line.user_agent as string).length).toBe(512);
    for (const key of ['token', 'password', 'authorization', 'cookie', 'email', 'phone', 'accessToken', 'refreshToken'])
      expect(line[key]).toBeUndefined();
    expect(t.lines[0]!.includes('secret')).toBe(false);
  });

  test('16.3.1 [ASVS v5.0.0-16.3.1] 로그인 성공은 identity 표준 출력에 접속기록 줄 하나를 쓴다', async () => {
    const store = new MemorySessionStore();
    const k = await kit(store);
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as never);
    let token = '';
    try {
      const out = await k.create.run({ idempotencyKey: 'abcdefghijklmnop', provider: 'kakao', providerUserId: '4000001', email: 'fan@kakao.test', deviceId: 'dev-A', clientIp: '203.0.113.9', userAgent: 'Chrome/130' });
      token = out.accessToken;
    } finally {
      spy.mockRestore();
    }
    const lines = chunks.flatMap((c) => c.split('\n')).filter((l) => l.includes('"kind":"legal-access"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ event: 'LOGIN', result: 'SUCCESS', provider: 'kakao', client_ip: '203.0.113.9', user_agent: 'Chrome/130' });
    expect(Number.isInteger(lines[0]!.seq)).toBe(true);
    expect(chunks.join('').includes(token)).toBe(false);

    // 모듈 단일 기록기도 같은 꼴의 줄을 쓴다(호출부가 줄을 잃지 않았는지)
    const more: string[] = [];
    const spy2 = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      more.push(String(chunk));
      return true;
    }) as never);
    try {
      recordLegalAccess({ event: 'LOGOUT', result: 'SUCCESS', accountId: 'acc-1' });
    } finally {
      spy2.mockRestore();
    }
    expect(more.join('')).toContain('"kind":"legal-access"');
  });

  test('IR-08 관리 계정 줄은 is_admin 1을 싣고 일반 줄은 0이다', () => {
    const t = harness();
    t.log.record({ event: 'LOGIN', result: 'SUCCESS', provider: 'kakao', accountId: 'fan-1' });
    t.log.record({ event: 'LOGIN', result: 'SUCCESS', provider: 'kakao', accountId: 'admin-1', isAdmin: true });
    const [fan, admin] = t.parsed();
    expect(fan.is_admin).toBe(0);
    expect(admin.is_admin).toBe(1);
  });

  test('IR-13 일련번호는 같은 파일을 쓰는 새 기록기에서도 이어지고 1로 돌아가지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peaket-legal-seq-'));
    const path = join(dir, 'seq');
    try {
      const a = createLegalAccessLog({ write: () => {}, now: () => NOW, pod: 'identity-0', statePath: path });
      a.record({ event: 'LOGIN', result: 'SUCCESS', provider: 'kakao' });
      a.record({ event: 'LOGOUT', result: 'SUCCESS' });
      const lines: string[] = [];
      const b = createLegalAccessLog({ write: (l) => lines.push(l), now: () => NOW, pod: 'identity-0', statePath: path });
      b.record({ event: 'REFRESH', result: 'SUCCESS' });
      expect(JSON.parse(lines[0]!).seq).toBe(3);
      expect(readFileSync(path, 'utf8').trim()).toBe('3');
      // 새 기록기는 파일의 마지막 값을 읽어 이어 간다(프로세스 재시작 흉내)
      const restarted2 = createLegalAccessLog({ write: () => {}, now: () => NOW, pod: 'identity-0', statePath: path });
      restarted2.record({ event: 'LOGOUT', result: 'SUCCESS' });
      expect(readFileSync(path, 'utf8').trim()).toBe('4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
