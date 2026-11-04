// 대기열 Redis 어댑터의 오류 가르기와 회차 일정 캐시(2026-11-03 새 맥락 리뷰): 일시 장애는 업무 오류(503)로, 버그는 그대로 던진다
import { fakeClock, type HotRedis, RedisConnectError, RedisDeadlineError } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { connOf, onlineReplicas, RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules, SCHEDULE_CACHE_MAX } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { QueueStoreUnavailable, RB05_CONFIRM_WAIT_MS } from '../src/modules/entry/domain/queue.js';

function failing(err: unknown): HotRedis {
  const fail = async () => Promise.reject(err);
  return { command: fail, evalScript: fail, sendCommand: fail, close: async () => {} };
}

describe('일시 장애', () => {
  // 끊김(ClientOfflineError) 같은 나머지 경우는 플랫폼 시험(packages/platform/test/redis.test.ts)이 본다
  test('마감초과·연결실패·클러스터재구성은_QueueStoreUnavailable로바꾼다', async () => {
    for (const err of [new RedisDeadlineError(100), new RedisConnectError(), new Error('CLUSTERDOWN The cluster is down'), new Error('TRYAGAIN rehashing')]) {
      const store = new RedisEntryStore(failing(err));
      await expect(store.preempt({ pid: 'p', eventId: 'e', requestId: 'r', pendingTtlMs: 10 })).rejects.toBeInstanceOf(QueueStoreUnavailable);
      await expect(store.number({ eventId: 'e', expireAtMs: 1 })).rejects.toBeInstanceOf(QueueStoreUnavailable);
      await expect(new RedisEventSchedules(failing(err), fakeClock()).get('e')).rejects.toBeInstanceOf(QueueStoreUnavailable);
    }
  });

  test('스크립트오류같은버그는_바꾸지않고그대로던진다', async () => {
    const bug = new Error('ERR Error running script');
    await expect(new RedisEntryStore(failing(bug)).number({ eventId: 'e', expireAtMs: 1 })).rejects.toBe(bug);
  });
});

describe('회차 일정 캐시', () => {
  const cfg = ['opensAtMs', '1', 'startsAtMs', '2', 'lobbyShuffle', '1', 'openBatch', '1', 'rev', '1'];

  function counting(found: (key: string) => boolean): HotRedis & { calls: number } {
    const r = {
      calls: 0,
      command: async () => null,
      // 일정 사본은 세대 키를 함께 맞추는 Lua 하나로 읽는다(ADR-0181)
      evalScript: async (_script: unknown, keys: string[]) => {
        r.calls++;
        return found(keys[0]!) ? cfg : [];
      },
      sendCommand: async () => null,
      close: async () => {},
    };
    return r;
  }

  test('없는회차는_캐시하지않는다_무작위회차ID로메모리를키우지못한다', async () => {
    const redis = counting(() => false);
    const s = new RedisEventSchedules(redis, fakeClock());
    for (let i = 0; i < 5; i++) expect(await s.get('nope')).toBeNull();
    expect(redis.calls).toBe(5);
    expect(s.cachedForTest()).toBe(0);
  });

  test('있는회차는_1초캐시하고_캐시는상한을넘지않는다', async () => {
    const redis = counting(() => true);
    const clock = fakeClock();
    const s = new RedisEventSchedules(redis, clock);
    await s.get('a');
    await s.get('a');
    expect(redis.calls).toBe(1);
    clock.advance(1_001);
    await s.get('a');
    expect(redis.calls).toBe(2);
    for (let i = 0; i < SCHEDULE_CACHE_MAX + 50; i++) await s.get(`e-${i}`);
    expect(s.cachedForTest()).toBeLessThanOrEqual(SCHEDULE_CACHE_MAX);
  });
});

describe('진행 중인 회차 목록', () => {
  test('목록넣기(ZADD)가실패해도_일정읽기는된다_리더를위한최선노력이다', async () => {
    const cfg = ['opensAtMs', '1', 'startsAtMs', '2', 'lobbyShuffle', '1', 'openBatch', '1', 'rev', '1'];
    const redis: HotRedis = {
      command: async () => Promise.reject(new RedisDeadlineError(100)),
      evalScript: async () => cfg,
      sendCommand: async () => null,
      close: async () => {},
    };
    expect(await new RedisEventSchedules(redis, fakeClock()).get('e')).not.toBeNull();
  });
});

test('목록넣기가끝나지않아도_일정읽기는기다리지않는다', async () => {
  const cfg = ['opensAtMs', '1', 'startsAtMs', '2', 'lobbyShuffle', '1', 'openBatch', '1', 'rev', '1'];
  const redis: HotRedis = { command: () => new Promise(() => {}), evalScript: async () => cfg, sendCommand: async () => null, close: async () => {} };
  expect(await new RedisEventSchedules(redis, fakeClock()).get('e')).not.toBeNull();
});

describe('RB-05 복제 확인(ADR-0186)', () => {
  const INFO = [
    '# Replication',
    'role:master',
    'connected_slaves:3',
    'slave0:ip=10.0.0.1,port=6379,state=online,offset=10,lag=0',
    'slave1:ip=10.0.0.2,port=6379,state=wait_bgsave,offset=0,lag=0',
    'slave2:ip=10.0.0.3,port=6379,state=online,offset=9,lag=1',
    'master_failover_state:no-failover',
    '',
  ].join('\r\n');
  const client = (id: number) => `id=${id} addr=10.0.1.5:51234 laddr=10.0.0.9:6379 fd=12 name= age=3 idle=0 flags=N db=0 cmd=client|info\n`;

  test('INFO_replication에서_state가online인복제본만센다', () => {
    expect(onlineReplicas(INFO)).toBe(2);
    expect(onlineReplicas('# Replication\r\nrole:master\r\nconnected_slaves:0\r\n')).toBe(0);
    expect(onlineReplicas('slave0:ip=10.0.0.1,port=6379,state=onlinex,offset=1,lag=0')).toBe(0);
  });

  test('CLIENT_INFO의연결표지는_연결번호와서버주소다', () => {
    expect(connOf(client(7))).toBe('7@10.0.0.9:6379');
    expect(connOf('addr=10.0.1.5:51234 fd=12')).toBeNull();
  });

  /** 공유 연결과 WAIT 전용 연결을 따로 두고 부른 순서·마감을 적는다. 지우기 Lua는 HDEL로 알아본다. reconnect면 두 번째 CLIENT INFO의 연결 번호가 바뀐다 */
  function recorder(o: { mark?: string | number; acked?: number; info?: string; reconnect?: boolean } = {}) {
    const seen: string[] = [];
    const deadlines: Array<number | undefined> = [];
    const pins: Array<boolean | undefined> = [];
    let clientInfos = 0;
    const shared = { command: async (a: string[]) => (seen.push(`shared:${a[0]}`), null), evalScript: async () => (seen.push('shared:eval'), 0), sendCommand: async () => null, close: async () => {} };
    const own = {
      command: async (a: string[], c?: { deadlineMs?: number; pin?: boolean }) => {
        seen.push(`wait:${a.join(' ')}`);
        deadlines.push(c?.deadlineMs);
        pins.push(c?.pin);
        if (a[0] === 'CLIENT') return client(o.reconnect && clientInfos++ > 0 ? 8 : 7);
        return a[0] === 'INFO' ? (o.info ?? INFO) : (o.acked ?? 2);
      },
      evalScript: async (s: { source: string }, _k: string[], args: string[], c?: { deadlineMs?: number }) => {
        const clear = s.source.includes('HDEL');
        seen.push(clear ? `wait:clear ${args.join(' ')}` : 'wait:mark');
        deadlines.push(c?.deadlineMs);
        return clear ? 2 : (o.mark ?? 'node-x:3');
      },
      sendCommand: async () => null,
      close: async () => {},
    };
    return { pins, store: new RedisEntryStore(shared as never, own as never), seen, deadlines };
  }

  test('[ASVS v5.0.0-15.4.2] 호출은모두WAIT전용연결로간다_연결표지_표시_INFO_WAIT_n_연결표지_표시한노드에서지우기순서이고_마감은WAIT만큼늘린다', async () => {
    const r = recorder();
    expect(await r.store.confirmRb05({ eventId: 'e' })).toBe('CONFIRMED');
    expect(r.seen).toEqual(['wait:CLIENT INFO', 'wait:mark', 'wait:INFO replication', `wait:WAIT 2 ${RB05_CONFIRM_WAIT_MS}`, 'wait:CLIENT INFO', 'wait:clear node-x:3']);
    expect(r.deadlines).toEqual(Array(6).fill(RB05_CONFIRM_WAIT_MS + 300));
    // 키 없는 명령은 클러스터 클라이언트가 key를 무시하므로 모두 key 슬롯의 주 노드로 못 박는다(CLIENT INFO, INFO, WAIT, CLIENT INFO)
    expect(r.pins).toEqual([true, true, true, true]);
  });

  test('받은복제본이붙은수보다적으면_WAITING이고표시를지우지않는다', async () => {
    const r = recorder({ acked: 1 });
    expect(await r.store.confirmRb05({ eventId: 'e' })).toBe('WAITING');
    expect(r.seen).toEqual(['wait:CLIENT INFO', 'wait:mark', 'wait:INFO replication', `wait:WAIT 2 ${RB05_CONFIRM_WAIT_MS}`]);
  });

  test('[ASVS v5.0.0-15.4.2] 표시와WAIT사이에연결이다시붙었으면_WAIT가표시를세지않았을수있어_WAITING이고지우지않는다', async () => {
    const r = recorder({ reconnect: true });
    expect(await r.store.confirmRb05({ eventId: 'e' })).toBe('WAITING');
    expect(r.seen.at(-1)).toBe('wait:CLIENT INFO');
    expect(r.seen.some((x) => x.startsWith('wait:clear'))).toBe(false);
  });

  test('표시를못쓰면(다른노드표지이거나확인할것이없음)_NONE이고더부르지않는다', async () => {
    const r = recorder({ mark: 0 });
    expect(await r.store.confirmRb05({ eventId: 'e' })).toBe('NONE');
    expect(r.seen).toEqual(['wait:CLIENT INFO', 'wait:mark']);
  });

  test('붙은복제본이없으면_기다리지않고지운다', async () => {
    const r = recorder({ info: '# Replication\r\nrole:master\r\nconnected_slaves:0\r\n' });
    expect(await r.store.confirmRb05({ eventId: 'e' })).toBe('CONFIRMED');
    expect(r.seen).toEqual(['wait:CLIENT INFO', 'wait:mark', 'wait:INFO replication', 'wait:CLIENT INFO', 'wait:clear node-x:3']);
  });
});
