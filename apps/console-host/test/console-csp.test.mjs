// 관제 콘솔 CSP의 연결 출처(F-03-1 T14, docs/frontend.md §5.14.1 '[C 관제 콘솔]': connect-src는 'self'와 ops-api뿐, 관제 실시간은 SSE라 wss 출처가 없다, ADR-0100).
// 운영 빌드를 내는 미리보기 서버(scripts/preview-server.mjs)의 실제 응답 머리를 본다. 본문은 읽지 않아(HEAD) 빌드 산출물 없이 돈다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewServer } from '../scripts/preview-server.mjs';

const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1)]));

async function headOf(env, path) {
  // real-time: 미리보기 서버가 실제로 다는 응답 머리를 본다(루프백 포트 0, 끝나면 닫는다) F-03-1
  const server = createPreviewServer({ env });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'HEAD' });
    return Object.fromEntries(res.headers.entries());
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('F-03-1 T14 [ASVS v5.0.0-3.4.3] 관제 CSP connect-src는 \'self\'와 ops-api뿐이고 wss·ws·Grafana 프레임 출처가 없다(운영 기본값과 로컬 출처)', async () => {
  for (const [env, opsApi] of [
    [{}, 'https://ops-api.peaket.example'],
    [{ PEAKET_OPS_API_ORIGIN: 'http://localhost:4173' }, 'http://localhost:4173'],
  ]) {
    for (const path of ['/dashboard', '/commands']) {
      const h = await headOf(env, path);
      const csp = h['content-security-policy'];
      assert.ok(csp, `${path}: CSP가 없다`);
      const d = directives(csp);
      assert.deepEqual(d['connect-src'], ["'self'", opsApi], `${path} connect-src`);
      assert.deepEqual(d['default-src'], ["'none'"]);
      assert.deepEqual(d['frame-ancestors'], ["'none'"]);
      assert.equal(d['frame-src'], undefined, 'frame-src(Grafana 등 프레임 출처)를 두지 않는다');
      assert.doesNotMatch(csp, /wss:|ws:|grafana/i);
      // 막는 모드다(보고 모드 머리에는 Trusted Types만)
      assert.match(h['content-security-policy-report-only'], /^require-trusted-types-for 'script'; trusted-types /);
      assert.doesNotMatch(h['content-security-policy-report-only'], /connect-src/);
    }
  }
});
