// V-T41 표본 묶음: 세 구성에 같은 요청(정상·형식 오류·모르는 칸)을 보내 받기·거르기 결과와 Problem 본문을 견준다.
// 표본은 packages/platform/test/request-checks.test.ts의 좌석 홀드·대기열 진입 표본에서 머리 검사(멱등 키·구매 요청 서명)를 뺀 것이다.
// 쓰는 법: node samples.mjs <기준 주소> [<주소>...]  예: node samples.mjs http://127.0.0.1:18081 http://127.0.0.1:18082 http://127.0.0.1:18083
const js = { 'content-type': 'application/json' };
const tp = { 'content-type': 'text/plain' };
const seats11 = JSON.stringify({ seatIds: Array.from({ length: 11 }, (_, i) => `A-${i}`) });
export const SAMPLES = [
  ['hold', '직접 선택', js, '{"seatIds":["A-1"]}'],
  ['hold', '자동 배정(기본값)', js, '{"auto":{"firstTierId":"t1","count":2}}'],
  ['hold', '모르는 칸(닫지 않은 객체)', js, '{"seatIds":["A-1"],"zzz":1}'],
  ['hold', '배열 자리에 문자열', js, '{"seatIds":"A-1"}'],
  ['hold', '배열 상한 초과', js, seats11],
  ['hold', '닫은 객체의 모르는 칸', js, '{"behavior":{"v":1,"windowMs":10,"extra":1}}'],
  ['hold', '정수 칸에 문자열', js, '{"behavior":{"v":1,"windowMs":"10"}}'],
  ['hold', '깨진 JSON', js, '{"seatIds":'],
  ['hold', '무한대 숫자', js, '{"behavior":{"v":1,"windowMs":10,"pointerEntropy":1e400}}'],
  ['entry', 'text/plain 정상', tp, '{"preverifyToken":"t"}'],
  ['entry', 'JSON 정상', js, '{"preverifyToken":"t","entryRequestId":"0190f3a1-7c2e-4a00-8000-000000000002"}'],
  ['entry', '형이 틀림', tp, '{"preverifyToken":1}'],
  ['entry', 'UUID 아님', tp, '{"preverifyToken":"t","entryRequestId":"x"}'],
  ['entry', '필수 칸 없음', tp, '{}'],
  ['entry', '깨진 JSON', tp, '{"preverifyToken"'],
  ['entry', '폼 본문', { 'content-type': 'application/x-www-form-urlencoded' }, 'preverifyToken=t'],
  ['entry', '본문 없음', {}, ''],
];
const PATH = { hold: '/v1/events/e1/holds', entry: '/v1/queues/e1/entries' };

export async function run(base) {
  const out = [];
  for (const [route, name, headers, body] of SAMPLES) {
    const r = await fetch(base + PATH[route], { method: 'POST', headers, body: body === '' ? undefined : body });
    const text = await r.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        delete parsed.traceId;
        delete parsed.instance;
      }
    } catch {
      parsed = text.slice(0, 120);
    }
    out.push({ route, name, status: r.status, type: r.headers.get('content-type')?.split(';')[0], body: parsed });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('samples.mjs')) {
  const bases = process.argv.slice(2);
  const results = await Promise.all(bases.map(run));
  const rows = SAMPLES.map(([route, name], i) => ({ route, name, ...Object.fromEntries(bases.map((b, j) => [b, `${results[j][i].status} ${JSON.stringify(results[j][i].body).slice(0, 90)}`])) }));
  const diff = rows.filter((_, i) => new Set(results.map((r) => JSON.stringify([r[i].status, r[i].type, r[i].body]))).size > 1);
  console.log(JSON.stringify({ bases, results, differences: diff.map((d) => d.name + ' [' + d.route + ']') }, null, 2));
}
