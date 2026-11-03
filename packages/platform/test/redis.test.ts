// 핫패스 Redis 연결의 규칙(ADR-0176 결정 2, OPEN[11] node-redis 확정, BUILD_ORDER FND-120이 넘긴 것). 실제 Valkey로 보는 시험은 test-int/redis.int.test.ts
import { createHash } from 'node:crypto';
import { ClientOfflineError, ClientClosedError, ConnectionTimeoutError, DisconnectsClientError, MaxCommandRedirectionsError, ReconnectStrategyError, RootNodesUnavailableError, SocketClosedUnexpectedlyError, SocketTimeoutError } from 'redis';
import { describe, expect, test } from 'vitest';
import { REDIS_CALL_DEADLINE_MS, REDIS_COMMAND_TIMEOUT_MS, RedisConnectError, RedisDeadlineError, hotRedisOver, isRedisUnavailable, redisClusterOptions, redisScript, type RawRedis } from '../src/redis.js';

function raw(send: RawRedis['send']): RawRedis & { calls: { key: string | undefined; args: string[]; binary?: boolean }[] } {
  const calls: { key: string | undefined; args: string[]; binary?: boolean }[] = [];
  return {
    calls,
    send: async (key, args, binary) => {
      calls.push({ key, args, ...(binary ? { binary } : {}) });
      return send(key, args, binary);
    },
    close: async () => {},
    destroy: () => {},
  };
}

const noSleep = { sleep: async () => {} };

describe('클러스터 연결 설정', () => {
  test('명령시간초과는_createCluster맨위의commandOptions에둔다_defaults안이면클러스터기본5초에덮인다', () => {
    const o = redisClusterOptions(['redis://a:6379', 'redis://b:6379']);
    expect(o.commandOptions?.timeout).toBe(REDIS_COMMAND_TIMEOUT_MS);
    expect(REDIS_COMMAND_TIMEOUT_MS).toBe(100);
    expect((o.defaults as { commandOptions?: unknown }).commandOptions).toBeUndefined();
    expect(o.defaults?.disableOfflineQueue).toBe(true);
    expect(o.rootNodes.map((n) => n.url)).toEqual(['redis://a:6379', 'redis://b:6379']);
  });
});

describe('클러스터 인증과 TLS', () => {
  test('찾아낸노드연결도_시작주소의사용자·비밀번호·TLS를쓴다_defaults에넣는다', () => {
    const o = redisClusterOptions(['rediss://queue-user:s3cret@a:6379', 'rediss://queue-user:s3cret@b:6379']);
    expect(o.defaults?.username).toBe('queue-user');
    expect(o.defaults?.password).toBe('s3cret');
    expect((o.defaults?.socket as { tls?: boolean }).tls).toBe(true);
    const plain = redisClusterOptions(['redis://:pw@a:6379']);
    expect(plain.defaults?.password).toBe('pw');
    expect(plain.defaults?.username).toBeUndefined();
    expect((plain.defaults?.socket as { tls?: boolean }).tls).toBeFalsy();
  });

  test('시작주소끼리인증·TLS가다르면_시작하지않고_비밀번호는오류문구에싣지않는다', () => {
    expect(() => redisClusterOptions(['rediss://u:p1@a:6379', 'redis://u:p1@b:6379'])).toThrow(/다르다/);
    try {
      redisClusterOptions(['rediss://u:p1@a:6379', 'rediss://u:p2@b:6379']);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('p1');
      expect((e as Error).message).not.toContain('p2');
    }
  });
});

describe('호출 규칙', () => {
  test('키를주지않은RedisCommander호출은_둘째인자를키로보내_클러스터가노드를고르게한다', async () => {
    const r = raw(async () => 1);
    await hotRedisOver(r).sendCommand(['XACK', 'q:{event:E}:stream', 'g', '1-0']);
    expect(r.calls[0]).toEqual({ key: 'q:{event:E}:stream', args: ['XACK', 'q:{event:E}:stream', 'g', '1-0'] });
  });

  test('마감이지난뒤에는_끊겨서못쓴명령을다시보내지않는다', async () => {
    let fail: (e: Error) => void = () => {};
    const r = raw(() => new Promise((_res, rej) => (fail = rej)));
    const p = hotRedisOver(r, noSleep).command(['INCR', 'k'], { key: 'k', deadlineMs: 20 });
    await expect(p).rejects.toBeInstanceOf(RedisDeadlineError);
    fail(new ClientOfflineError());
    await new Promise((res) => setTimeout(res, 10));
    expect(r.calls).toHaveLength(1);
  });

  test('연결이끊겨_소켓에쓰지못한명령만_한번다시보낸다', async () => {
    let n = 0;
    const r = raw(async () => {
      if (++n === 1) throw new ClientOfflineError();
      return 'OK';
    });
    const redis = hotRedisOver(r, noSleep);
    await expect(redis.command(['SET', 'k', 'v'], { key: 'k' })).resolves.toBe('OK');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toEqual({ key: 'k', args: ['SET', 'k', 'v'] });
  });

  test('다시보낸명령도끊기면_그오류로실패하고_더보내지않는다', async () => {
    const r = raw(async () => {
      throw new ClientOfflineError();
    });
    await expect(hotRedisOver(r, noSleep).command(['GET', 'k'], { key: 'k' })).rejects.toBeInstanceOf(ClientOfflineError);
    expect(r.calls).toHaveLength(2);
  });

  test('쓴뒤의실패는_결과를모르므로_다시보내지않는다', async () => {
    const r = raw(async () => {
      throw new Error('ERR something');
    });
    await expect(hotRedisOver(r, noSleep).command(['INCR', 'k'], { key: 'k' })).rejects.toThrow('ERR something');
    expect(r.calls).toHaveLength(1);
  });

  test('호출쪽마감이지나면_RedisDeadlineError로끊는다_명령시간초과는소켓에쓰기전까지만든다', async () => {
    const r = raw(() => new Promise(() => {}));
    const started = Date.now();
    await expect(hotRedisOver(r).command(['BLPOP', 'k', '1'], { key: 'k', deadlineMs: 30 })).rejects.toBeInstanceOf(RedisDeadlineError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(REDIS_CALL_DEADLINE_MS).toBe(100);
  });

  test('스크립트는_EVALSHA로보내고_NOSCRIPT면_같은마감안에서EVAL한다', async () => {
    const s = redisScript('return KEYS[1]');
    expect(s.sha).toBe(createHash('sha1').update('return KEYS[1]').digest('hex'));
    const r = raw(async (_key, args) => {
      if (args[0] === 'EVALSHA') throw new Error('NOSCRIPT No matching script. Please use EVAL.');
      return 'k1';
    });
    await expect(hotRedisOver(r, noSleep).evalScript(s, ['k1'], ['a'])).resolves.toBe('k1');
    expect(r.calls.map((c) => c.args)).toEqual([
      ['EVALSHA', s.sha, '1', 'k1', 'a'],
      ['EVAL', 'return KEYS[1]', '1', 'k1', 'a'],
    ]);
    expect(r.calls.every((c) => c.key === 'k1')).toBe(true);
  });

  test('binary를주면_응답을바이트로받으라고연결에넘긴다_스크립트의EVAL로다시보내기도같다', async () => {
    const s = redisScript('return KEYS[1]');
    const r = raw(async (_key, args) => {
      if (args[0] === 'EVALSHA') throw new Error('NOSCRIPT No matching script. Please use EVAL.');
      return Buffer.from([0x80]);
    });
    const redis = hotRedisOver(r, noSleep);
    await redis.command(['GETRANGE', 'k', '0', '-1'], { key: 'k', binary: true });
    await redis.evalScript(s, ['k'], [], { binary: true });
    await redis.command(['GET', 'k'], { key: 'k' });
    expect(r.calls.map((c) => [c.args[0], c.binary ?? false])).toEqual([
      ['GETRANGE', true],
      ['EVALSHA', true],
      ['EVAL', true],
      ['GET', false],
    ]);
  });

  test('마감이지난뒤에는_EVAL을새로보내지않는다', async () => {
    let release: () => void = () => {};
    const r = raw(
      (_key, args) =>
        new Promise((_res, rej) => {
          if (args[0] === 'EVALSHA') release = () => rej(new Error('NOSCRIPT No matching script.'));
        }),
    );
    const p = hotRedisOver(r, noSleep).evalScript(redisScript('return 1'), ['k'], [], { deadlineMs: 20 });
    await expect(p).rejects.toBeInstanceOf(RedisDeadlineError);
    release();
    await new Promise((res) => setTimeout(res, 10));
    expect(r.calls.map((c) => c.args[0])).toEqual(['EVALSHA']);
  });
});

describe('일시 장애 가르기', () => {
  test('마감초과·연결끊김·클러스터재구성·장애전환중오류는_일시장애다_스크립트오류같은버그는아니다', () => {
    for (const e of [new RedisDeadlineError(100), new RedisConnectError(), new ClientOfflineError(), new Error('CLUSTERDOWN The cluster is down'), new Error('TRYAGAIN Multiple keys request during rehashing of slot'), new Error('LOADING Redis is loading the dataset in memory'), new Error('MASTERDOWN Link with MASTER is down'), new Error("READONLY You can't write against a read only replica."), new Error('NOREPLICAS Not enough good replicas to write.')]) {
      expect(isRedisUnavailable(e)).toBe(true);
    }
    for (const e of [new Error('ERR Error running script'), new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), 'x', undefined]) {
      expect(isRedisUnavailable(e)).toBe(false);
    }
  });

  test('node-redis 연결 오류는 클래스로 가른다(name이 모두 Error라 이름으로는 맞지 않는다, PRF-085 Q-T13에서 찾음)', () => {
    for (const e of [new SocketClosedUnexpectedlyError(), new ClientClosedError(), new ConnectionTimeoutError(), new SocketTimeoutError(100), new DisconnectsClientError(), new RootNodesUnavailableError(), new ReconnectStrategyError(new Error('x'), new Error('y'))]) {
      expect(e.name).toBe('Error');
      expect(isRedisUnavailable(e)).toBe(true);
    }
  });

  test('연결이 오류로 끊기면 node-redis는 처리 중이던 명령을 소켓 오류 그대로 거부한다: errno 코드로 일시 장애로 본다. 클러스터 넘겨주기 상한도 일시 장애다', () => {
    const sys = (code: string) => Object.assign(new Error(`read ${code}`), { code, errno: -1, syscall: 'read' });
    for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']) expect(isRedisUnavailable(sys(code))).toBe(true);
    expect(isRedisUnavailable(new MaxCommandRedirectionsError())).toBe(true);
    // 그 밖의 시스템 오류 코드(버그일 수 있다)는 아니다
    expect(isRedisUnavailable(sys('EACCES'))).toBe(false);
  });
});
