// Q-T47 합성 대기자(reflect.sim.test.ts가 프로세스 여럿으로 띄운다. 원본 서버와 같은 프로세스에 두면 이벤트 루프를 나눠 써 원본이 늦어진다).
// 부모가 { start: n }을 보내면 번호 n의 대기자가 자기 구간 파일을 0.5초 ±20%로 폴링하고, 파일의 serving이 n 이상이면 servingSteps에서
// serving이 n을 넘은 전진 시각을 찾아(브라우저의 반영 지연 재기와 같다, ADR-0110) 결과를 부모에게 보낸다. { stop: true }면 끝낸다.
// 인자: 엣지 주소, 회차 ID, 폴링 간격(ms)
const [edge, eventId, pollMsRaw] = process.argv.slice(2);
const POLL_MS = Number(pollMsRaw ?? 500);
let stop = false;
/** @type {{ requests: number, errors: number, staleHits: number, staleMaxMs: number, noStep: number, cache: Record<string, number> }} */
const stats = { requests: 0, errors: 0, staleHits: 0, staleMaxMs: 0, noStep: 0, cache: {} };
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** @param {(m: object) => void} f */
const send = (f) => f;
const post = send((m) => process.send?.(m));

/** @param {number} n */
async function poll(n) {
  const seg = Math.floor((n - 1) / 1000);
  while (!stop) {
    const req = Date.now();
    try {
      stats.requests += 1;
      const r = await fetch(`${edge}/v1/queues/${eventId}/segment-states/${seg}.json`);
      const recv = Date.now();
      const cache = r.headers.get('x-cache') ?? '-';
      stats.cache[cache] = (stats.cache[cache] ?? 0) + 1;
      const expires = Date.parse(r.headers.get('expires') ?? '');
      // 캐시가 Expires가 지난 파일을 냈다. Expires는 원본이 생성 경계(초)에서 정하고 요청 시각과 같은 이 PC 시계라 여유는 50ms만 둔다
      if (cache === 'HIT' && Number.isFinite(expires) && req > expires + 50) {
        stats.staleHits += 1;
        stats.staleMaxMs = Math.max(stats.staleMaxMs, req - expires);
      }
      if (r.status === 200) {
        const body = /** @type {{ serving: number, generatedAtMs: number, servingSteps?: Array<[number, number]> }} */ (await r.json());
        if (body.serving >= n) {
          const step = (body.servingSteps ?? []).find((s) => s[1] >= n);
          if (!step) stats.noStep += 1;
          post({ seen: { n, adv: step ? step[0] : null, req, recv, gen: body.generatedAtMs, cache, imminent: Array.isArray(body.servingSteps) } });
          return;
        }
      } else {
        await r.arrayBuffer();
        stats.errors += 1;
      }
    } catch {
      stats.errors += 1;
    }
    await sleep(POLL_MS * (0.8 + Math.random() * 0.4) - (Date.now() - req));
  }
}

process.on('message', (/** @type {{ start?: number, stop?: boolean }} */ m) => {
  if (m.start !== undefined) void poll(m.start);
  if (m.stop) {
    stop = true;
    setTimeout(() => {
      post({ stats });
      setTimeout(() => process.exit(0), 200);
    }, 1_500);
  }
});
post({ ready: true });
