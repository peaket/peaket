// 검색 측정 채우기 스크립트의 환경 확인(리뷰 W7L2-S8, ADR-0271 결정 21, 계획 docs/review/plans/BAT-165.md '### 17').
// PEAKET_ENV가 local·ci이고 DB 호스트가 localhost·127.0.0.1·::1일 때만 돈다. 그 밖에는 DB에 붙기 전에 멈춘다(덮어쓰는 깃발 없음).
// DB에 붙지 않았다는 것은 닫힌 로컬 포트를 주고 '연결 오류'가 아니라 환경 확인 문구로 멈추는지로 본다.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/fill-search.mjs', import.meta.url));
// 닫힌 로컬 포트(아무도 듣지 않는다)
const CLOSED = 'postgres://u:p@127.0.0.1:1/peaket';
const run = (env: Record<string, string>) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PEAKET_'))) as Record<string, string>;
  const out = spawnSync(process.execPath, [SCRIPT, '--count', '1'], { env: { ...base, ...env }, encoding: 'utf8', timeout: 30_000 });
  return { code: out.status, text: `${out.stdout ?? ''}\n${out.stderr ?? ''}` };
};
const connectionError = /ECONNREFUSED|connect|연결/i;

describe('채우기 스크립트 환경 확인', () => {
  test('채우기 스크립트는 로컬·CI의 로컬 DB에서만 돌고 그 밖에는 DB에 붙기 전에 멈춘다(W7L2-S8)', () => {
    // 환경 값마다(빈 값·demo·staging·prod) 멈추고 PEAKET_ENV를 까닭으로 찍는다. 연결 단계까지 가지 않는다
    for (const env of ['', 'demo', 'staging', 'prod']) {
      const r = run({ PEAKET_ENV: env, PEAKET_DATABASE_URL: CLOSED });
      expect({ env, stopped: r.code !== 0, why: /PEAKET_ENV/.test(r.text), connected: /ECONNREFUSED/.test(r.text) }).toEqual({ env, stopped: true, why: true, connected: false });
    }
    // local인데 호스트가 로컬이 아니면 멈춘다(호스트를 까닭으로)
    const remote = run({ PEAKET_ENV: 'local', PEAKET_DATABASE_URL: 'postgres://u:p@db.internal:5432/peaket' });
    expect({ stopped: remote.code !== 0, why: /db\.internal|호스트|host/i.test(remote.text), dns: /ENOTFOUND|EAI_AGAIN/.test(remote.text) }).toEqual({ stopped: true, why: true, dns: false });
    // 대조군: local·127.0.0.1은 환경 확인을 지나 연결 단계로 간다(닫힌 포트라 연결 오류로 끝난다)
    for (const env of ['local', 'ci']) {
      const ok = run({ PEAKET_ENV: env, PEAKET_DATABASE_URL: CLOSED });
      expect({ env, stopped: ok.code !== 0, reachedConnect: connectionError.test(ok.text) }).toEqual({ env, stopped: true, reachedConnect: true });
    }
  });

  test('채우기 스크립트는 쿼리 ?host=로 덮어쓴 원격 호스트도 멈춘다(W7L2-S12)', () => {
    // 호스트는 연결 문자열 해석기(pg-connection-string parse)가 낸 값으로 본다(ADR-0271 결정 21 보탬). 쿼리 ?host=가 주소의 호스트를 덮어쓴다
    const attempted = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENOENT|ETIMEDOUT|connect /;
    for (const url of [
      'postgres://u:p@127.0.0.1:1/peaket?host=db.internal',
      'postgres://u:p@127.0.0.1:1/peaket?host=10.0.0.5',
      'postgres://u:p@127.0.0.1:1/peaket?host=/var/run/postgresql',
      'postgres://u:p@:1/peaket',
      // 여러 호스트(쉼표): 첫 호스트가 로컬이어도 멈춘다(ADR-0271 결정 21 '여럿이면 멈춘다', V165-L3)
      'postgres://u:p@127.0.0.1:1/peaket?host=127.0.0.1,db.internal',
    ]) {
      const r = run({ PEAKET_ENV: 'local', PEAKET_DATABASE_URL: url });
      expect({ url, stopped: r.code !== 0, why: /호스트|host/i.test(r.text), attempted: attempted.test(r.text) }).toEqual({ url, stopped: true, why: true, attempted: false });
    }
    // 대조군: ?host=127.0.0.1은 확인을 지나 연결 단계로 간다(닫힌 포트라 연결 오류)
    const ok = run({ PEAKET_ENV: 'local', PEAKET_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/peaket?host=127.0.0.1' });
    expect({ stopped: ok.code !== 0, reachedConnect: /ECONNREFUSED/.test(ok.text) }).toEqual({ stopped: true, reachedConnect: true });
  });
});
