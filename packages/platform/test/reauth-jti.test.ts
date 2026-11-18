// 재인증 토큰 jti 한 번 쓰기 저장소(RedisReauthJtiStore) 단위 시험(R-T39 ⑤, BAT-415-reauth, 시험 담당 l3-b415r-test).
// 정본: docs/data.md §3 `reauth:jti:{jti}`(`SET NX PX`, 값 `1`. 수명은 토큰의 남은 시간이고 5분 30초를 넘지 않는다),
// docs/features/transfer-refund.md §3.1 '한 번 쓰기'(공용 저장소의 상한도 5분 30초).
// 고친 곳 검증 R4(공용 상한을 6분으로 늘림)는 purchase 어댑터의 상한이 가려 살아남았다. 다른 받는 서비스(core·ops·payment)는
// 어댑터 상한이 없어 이 저장소의 상한만 믿으므로 저장소를 따로 본다. 단언 값은 정본에서 가져온다(코드 상수를 가져오지 않는다).
import { describe, expect, test } from 'vitest';
import { RedisReauthJtiStore } from '../src/reauth-jti.js';

const NOW = Date.parse('2026-11-13T10:00:00+09:00');
/** 정본의 상한: 5분 + 시계 차이 30초 */
const CAP_MS = 330_000;

function recorder() {
  const commands: { args: string[]; key: string }[] = [];
  let reply: unknown = 'OK';
  return {
    commands,
    set reply(v: unknown) {
      reply = v;
    },
    async command(args: readonly string[], o: { key: string }) {
      commands.push({ args: [...args], key: o.key });
      return reply;
    },
  };
}

describe('RedisReauthJtiStore [BAT-415-reauth]', () => {
  test('R-T39 ⑤ 남은 수명이 상한보다 길면 PX를 정본 값 330000으로 자르고, 짧으면 남은 수명 그대로다', async () => {
    const cases: [string, number, string][] = [
      ['남은 400초', 400_000, '330000'],
      ['남은 330,001ms(상한 + 1ms)', CAP_MS + 1, '330000'],
      ['남은 330,000ms(상한 그대로)', CAP_MS, '330000'],
      ['남은 329,999ms(상한 − 1ms)', CAP_MS - 1, '329999'],
      ['남은 100초', 100_000, '100000'],
    ];
    for (const [what, remainMs, px] of cases) {
      const redis = recorder();
      const store = new RedisReauthJtiStore(redis);
      expect(await store.claim('jti-a', NOW + remainMs, NOW), what).toBe(true);
      expect(redis.commands, what).toEqual([{ args: ['SET', 'reauth:jti:jti-a', '1', 'NX', 'PX', px], key: 'reauth:jti:jti-a' }]);
    }
  });

  test('R-T39 ⑤ 이미 있으면(NX가 null) false다', async () => {
    const redis = recorder();
    redis.reply = null;
    expect(await new RedisReauthJtiStore(redis).claim('jti-b', NOW + 100_000, NOW)).toBe(false);
    expect(redis.commands).toHaveLength(1);
  });
});
