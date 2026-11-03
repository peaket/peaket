// 야간 비교의 실행 명령(k6-run.mjs)이 받는 인자 읽기(docs/devops.md §3.3). nightly.py는 설정의 k6 명령 뒤에 k6 인자를 붙여 부른다.

/** 판의 입구 주소(클러스터 안) → 네임스페이스. 새 판 v0, 기준판 v0-base */
export const NIGHTLY_URL = /^https:\/\/v0-gateway\.(v0|v0-base)\.svc\.cluster\.local:8443$/;

/**
 * argv(실행 명령 뒤의 인자) = [실행 도구에 그대로 넘길 인자 …, 'run', k6 인자 …].
 * k6 인자에서 받는 것: --quiet(값 없음), --summary-trend-stats <값>, --summary-export <경로>, -e <이름>=<값>(여러 번), 시나리오 경로 하나.
 * 결과: { passthrough: 'run' 앞의 인자, summaryExport, env: { 이름: 값 }, scenario }.
 * 'run'이 없음, 모르는 k6 인자, 값이 빠진 인자, 시나리오가 없거나 둘 이상, --summary-export 없음, '='가 없는 -e는 Error
 * @param {string[]} argv
 * @returns {{ passthrough: string[], summaryExport: string, env: Record<string, string>, scenario: string }}
 */
export function parseK6Args(argv) {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) throw new Error('인자 목록이 아니다');
  const at = argv.indexOf('run');
  if (at < 0) throw new Error("k6 인자에 'run'이 없다");
  const passthrough = argv.slice(0, at);
  const rest = argv.slice(at + 1);
  const env = {};
  let summaryExport;
  const scenarios = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('-')) throw new Error(`${a}에 값이 없다`);
      i++;
      return v;
    };
    if (a === '--quiet') continue;
    if (a === '--summary-trend-stats') value();
    else if (a === '--summary-export') summaryExport = value();
    else if (a === '-e') {
      const kv = value();
      const eq = kv.indexOf('=');
      if (eq <= 0) throw new Error(`-e 값은 이름=값이다: ${kv}`);
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('-')) throw new Error(`모르는 k6 인자: ${a}`);
    else scenarios.push(a);
  }
  if (scenarios.length !== 1) throw new Error(`시나리오 경로는 하나다(${scenarios.length}개)`);
  if (summaryExport === undefined) throw new Error('--summary-export가 없다');
  return { passthrough, summaryExport, env, scenario: scenarios[0] };
}

/**
 * 판의 입구 주소에서 네임스페이스를 읽는다(NIGHTLY_URL). 맞지 않으면 Error
 * @param {string} url
 * @returns {'v0' | 'v0-base'}
 */
export function namespaceFromUrl(url) {
  const m = typeof url === 'string' ? NIGHTLY_URL.exec(url) : null;
  if (!m) throw new Error(`야간 비교 판 주소가 아니다: ${String(url)}`);
  return /** @type {'v0' | 'v0-base'} */ (m[1]);
}
