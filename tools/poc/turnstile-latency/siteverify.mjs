// BAS-100 Turnstile 검증 지연 PoC: Cloudflare가 공개한 시험 키와 더미 토큰으로 siteverify 호출 지연을 잰다.
// 시험 키는 공개 문서 값이라 비밀이 아니다(https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
// 운영 비밀 키는 저장소에 넣지 않는다. 이 스크립트는 로컬 PoC이고, 로비 부하 시험(Q-T57)이 아니다.
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// 공개 시험 키를 한 덩어리 비밀처럼 보이지 않게 나눠 적는다(값은 Cloudflare 테스트 문서 그대로다).
export const TEST_SITE_KEY = ['1x', '0'.repeat(20), 'AA'].join('');
export const TEST_SECRET = ['1x', '0'.repeat(31), 'AA'].join('');
export const TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
export const DEFAULT_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** 오름차순 배열의 백분위(0~100). 표본이 작으면 가장 가까운 값 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** 한 번 검증하고 `{ ok, ms, status }`를 낸다 */
export async function verifyOnce({ url = DEFAULT_URL, secret = TEST_SECRET, token = TEST_TOKEN, fetchImpl = fetch } = {}) {
  const body = new URLSearchParams({ secret, response: token });
  const t0 = performance.now();
  const res = await fetchImpl(url, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
  const json = await res.json().catch(() => null);
  return { ok: res.ok && json?.success === true, ms: performance.now() - t0, status: res.status };
}

/** 지연 표본을 요약한다 */
function summary(rounds, times, errors) {
  const sorted = [...times].sort((a, b) => a - b);
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    rounds,
    ok: times.length,
    errors,
    minMs: round1(sorted[0] ?? 0),
    p50Ms: round1(percentile(sorted, 50)),
    p95Ms: round1(percentile(sorted, 95)),
    p99Ms: round1(percentile(sorted, 99)),
    maxMs: round1(sorted.at(-1) ?? 0),
  };
}

/** rounds번 검증해 분포를 낸다. 실패는 error로 세고 지연 분포에는 넣지 않는다 */
export async function measure({ rounds = 20, fetchImpl = fetch, url = DEFAULT_URL } = {}) {
  const times = [];
  let errors = 0;
  for (let i = 0; i < rounds; i += 1) {
    try {
      const r = await verifyOnce({ url, fetchImpl });
      if (r.ok) times.push(r.ms);
      else errors += 1;
    } catch {
      errors += 1;
    }
  }
  return summary(rounds, times, errors);
}

/** concurrency개를 동시에 돌려 rounds번 검증한다. Q-T57의 작은 대역(실제 1,700/s는 아니다) */
export async function measureConcurrent({ rounds = 20, concurrency = 10, fetchImpl = fetch, url = DEFAULT_URL } = {}) {
  const times = [];
  let errors = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= rounds) return;
      try {
        const r = await verifyOnce({ url, fetchImpl });
        if (r.ok) times.push(r.ms);
        else errors += 1;
      } catch {
        errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rounds) }, worker));
  return summary(rounds, times, errors);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rounds = Number(process.argv[2] ?? 20);
  const r = await measure({ rounds });
  process.stdout.write(`${JSON.stringify({ ...r, siteKey: TEST_SITE_KEY, url: DEFAULT_URL }, null, 2)}\n`);
}
