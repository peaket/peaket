// F-08-9 P-T1 추가 장애 인자(계획 docs/review/plans/F-08-9.md 6.2·7.1~7.2).
// 결제 1만 건·100/s·발생기 2대·웹훅 중복 2회·불변식 검사를 v1 payment-fault 명령으로 받는다.
// 실제 결제·Toxiproxy 실행은 run.mjs가 측정 창에서 맡는다.

export class UsageError extends Error {
  name = 'UsageError';
}

const fail = (m) => {
  throw new UsageError(m);
};

const RUN_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,80}$/;
const PROM_URL = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})$/;
const intArg = (name, raw, lo, hi) => {
  if (!/^\d+$/.test(String(raw))) fail(`${name}은 ${lo}~${hi} 정수다: ${raw}`);
  const n = Number(raw);
  if (n < lo || n > hi) fail(`${name}은 ${lo}~${hi} 정수다: ${raw}`);
  return n;
};

/** v1 payment-fault 인자. 계획 7.2의 공개 꼴 */
export function parsePaymentFaultArgs(argv) {
  if (!Array.isArray(argv)) fail('인자 목록이 없다');
  const seen = new Map();
  const valueFlags = new Set(['--payments', '--rate', '--generators', '--webhook-duplicates', '--out', '--run-id', '--prom-url']);
  const boolFlags = new Set(['--invariants', '--record']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!valueFlags.has(flag) && !boolFlags.has(flag)) fail(`모르는 인자: ${flag}`);
    if (seen.has(flag)) fail(`${flag}를 두 번 줬다`);
    if (boolFlags.has(flag)) {
      seen.set(flag, true);
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${flag}에 값이 없다`);
    seen.set(flag, v);
    i++;
  }
  const record = seen.get('--record') === true;
  const runId = seen.get('--run-id');
  if (record && runId === undefined) fail('--record에는 --run-id가 꼭 있어야 한다');
  if (!record && runId !== undefined) fail('--run-id는 --record와 함께만 준다');
  if (runId !== undefined && !RUN_ID.test(runId)) fail(`--run-id 꼴이 틀렸다(YYYY-MM-DD-영소문자·숫자·-): ${runId}`);
  const promUrl = seen.get('--prom-url');
  if (promUrl !== undefined && !PROM_URL.test(promUrl)) fail(`--prom-url은 http://127.0.0.1:<포트>나 http://localhost:<포트>다: ${promUrl}`);
  return {
    payments: intArg('--payments', seen.get('--payments') ?? 10000, 1, 100000),
    rate: intArg('--rate', seen.get('--rate') ?? 100, 1, 1000),
    generators: intArg('--generators', seen.get('--generators') ?? 2, 1, 16),
    webhookDuplicates: intArg('--webhook-duplicates', seen.get('--webhook-duplicates') ?? 2, 2, 10),
    invariants: seen.get('--invariants') === true,
    ...(seen.get('--out') !== undefined ? { out: seen.get('--out') } : {}),
    record,
    ...(runId !== undefined ? { runId } : {}),
    ...(promUrl !== undefined ? { promUrl } : {}),
  };
}
