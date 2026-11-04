// 리더 저장소의 RB-05 복제 확인(ADR-0186): 호출은 묶음 게시 확인과 같은 WAIT 전용 연결로 가고 공유 연결은 쓰지 않는다.
// WAIT는 그 연결을 막으므로 공유 연결로 보내면 리더의 다른 회차 명령이 기다린다(queue-svc redis-adapters.test.ts와 같은 시험)
import { describe, expect, test } from 'vitest';
import { connOf, onlineReplicas, RedisLeaderStore } from '../src/modules/leader/adapters/redis-leader-store.js';
import { RB05_CONFIRM_WAIT_MS } from '../src/modules/leader/domain/plan.js';

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
    return { pins, store: new RedisLeaderStore(shared as never, own as never), seen, deadlines };
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
