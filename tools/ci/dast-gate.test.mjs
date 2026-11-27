// ZAP 기준선 결과 → SARIF 판정 시험(BOT-161, docs/devops.md §3, ADR-0323).
// - riskcode 3(High)은 보안 등급 8.0, 2(Medium)은 5.0. 판정은 High 7.0 이상을 막고 Medium 이하는 알림만 남긴다.
// - 결과 파일이 없거나 비었거나 JSON이 아니거나 점검 흔적(site·@name)이 없으면 막는다.
// - 요청·응답 본문·쿠키·공격 문자열(evidence·attack·otherinfo·request/response)은 SARIF에 옮기지 않는다.
// 실행: node --test tools/ci/dast-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCK_SEVERITY, SEVERITY_OF_RISK, main, toSarif } from './dast-gate.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'dast-gate-'));
const write = (name, text) => {
  const f = join(dir(), name);
  writeFileSync(f, text);
  return f;
};
const alertOf = (riskcode, over = {}) => ({
  pluginid: '40018',
  alert: 'SQL Injection',
  name: 'SQL Injection',
  riskcode,
  riskdesc: `${riskcode} (High)`,
  instances: [{ uri: 'https://www.peaket.example/v1/search?q=1' }],
  ...over,
});
const reportOf = (alerts, site = { '@name': 'https://www.peaket.example' }) => ({ '@version': '2.16.1', site: [{ ...site, alerts }] });

const run = (report, event = 'schedule') => {
  const reportPath = write('zap.json', typeof report === 'string' ? report : JSON.stringify(report));
  const out = join(dir(), 'zap.sarif');
  const code = main(['--report', reportPath, '--out', out, '--event', event]);
  return { code, out };
};
/** main은 막아야 할 입력에 던진다(CLI가 받아 1로 끝난다). 시험은 둘 다 '막음'으로 본다 */
const blocked = (report) => {
  try {
    return run(report).code === 1;
  } catch {
    return true;
  }
};

test('BOT-161 High 1건이면 SARIF security-severity 8.0이고 판정은 1(막음)이다', () => {
  const { sarif, high, medium } = toSarif(reportOf([alertOf(3)]));
  assert.equal(high, 1);
  assert.equal(medium, 0);
  const rule = sarif.runs[0].tool.driver.rules[0];
  assert.equal(rule.properties['security-severity'], '8.0');
  assert.equal(rule.defaultConfiguration.level, 'error');
  assert.equal(sarif.runs[0].results[0].level, 'error');
  assert.ok(Number(rule.properties['security-severity']) >= BLOCK_SEVERITY);
  const r = run(reportOf([alertOf(3)]));
  assert.equal(r.code, 1);
});

test('BOT-161 Medium만 있으면 통과(0)하고 SARIF는 warning·5.0이다', () => {
  const { sarif, high, medium } = toSarif(reportOf([alertOf(2, { pluginid: '10020', alert: 'X-Frame-Options' })]));
  assert.equal(high, 0);
  assert.equal(medium, 1);
  assert.equal(sarif.runs[0].tool.driver.rules[0].properties['security-severity'], '5.0');
  assert.equal(sarif.runs[0].results[0].level, 'warning');
  assert.equal(run(reportOf([alertOf(2)])).code, 0);
});

test('BOT-161 결과 파일이 없거나 비었거나 JSON이 아니거나 ZAP 꼴이 아니면 막는다', () => {
  // 없는 파일
  const out = join(dir(), 'x.sarif');
  assert.throws(() => main(['--report', join(dir(), 'nope.json'), '--out', out]), /결과 파일이 없다/);
  // 빈 파일
  assert.equal(blocked(''), true);
  assert.equal(blocked('  \n\t '), true);
  // 깨진 JSON
  assert.equal(blocked('{"site": ['), true);
  // JSON이지만 객체가 아니다
  assert.equal(blocked([]), true);
  assert.equal(blocked('null'), true);
  // site가 없거나 비었거나 점검 흔적(@name/host)이 없다
  assert.equal(blocked({}), true);
  assert.equal(blocked({ site: [] }), true);
  assert.equal(blocked({ site: [{ alerts: [] }] }), true);
  assert.equal(blocked({ site: [{ '@name': '', alerts: [] }] }), true);
  assert.equal(blocked({ site: [{ '@name': 'www.peaket.example' }] }), true);
  assert.equal(blocked({ site: ['nope'] }), true);
});

test('BOT-161 High 2건은 high 2로 세고, 같은 규칙·주소의 중복 인스턴스는 SARIF 결과 1건으로 합친다', () => {
  const dup = toSarif(reportOf([alertOf(3), alertOf(3)]));
  assert.equal(dup.high, 2);
  assert.equal(dup.findings, 1);
  const two = toSarif(
    reportOf([
      alertOf(3, { instances: [{ uri: 'https://www.peaket.example/a' }] }),
      alertOf(3, { pluginid: '40012', instances: [{ uri: 'https://www.peaket.example/b' }] }),
    ]),
  );
  assert.equal(two.high, 2);
  assert.equal(two.findings, 2);
  const many = toSarif(reportOf([alertOf(3, { instances: [{ uri: 'https://www.peaket.example/a' }, { uri: 'https://www.peaket.example/b' }] })]));
  assert.equal(many.high, 1);
  assert.equal(many.findings, 2);
});

test('BOT-161 요청·응답 본문·쿠키·공격 문자열은 SARIF에 옮기지 않는다', () => {
  const secret = 'PEAKET-SECRET-COOKIE-7f3c';
  const { sarif } = toSarif(
    reportOf([
      alertOf(3, {
        evidence: `<script>alert('${secret}')</script>`,
        attack: `' OR 1=1 -- ${secret}`,
        otherinfo: `cookie __Host-peaket_ops_at=${secret}`,
        requestHeader: `Cookie: __Host-peaket_ops_rt=${secret}`,
        requestBody: `{"password":"${secret}"}`,
        responseHeader: `Set-Cookie: __Secure-peaket_partner_rt=${secret}`,
        responseBody: `{"token":"${secret}"}`,
        request: `GET /?q=${secret} HTTP/1.1`,
        response: `HTTP/1.1 200 OK\\r\\n\\r\\n${secret}`,
      }),
    ]),
  );
  const text = JSON.stringify(sarif);
  assert.ok(!text.includes(secret), '공격 문자열·본문·쿠키 값이 SARIF에 들어갔다');
  assert.ok(!text.includes('<script>'), '증거 문자열이 SARIF에 들어갔다');
  // 규칙·주소·이름은 남는다(보고에 필요)
  assert.match(text, /ZAP-40018/);
  assert.match(text, /www\.peaket\.example/);
});

test('BOT-161 ① riskcode는 숫자·문자 모두 읽고, 없거나 모르는 등급은 9.0(High)으로 막는다', () => {
  assert.equal(SEVERITY_OF_RISK[3], 8);
  assert.equal(SEVERITY_OF_RISK[2], 5);
  assert.equal(SEVERITY_OF_RISK[1], 3);
  assert.equal(SEVERITY_OF_RISK[0], 0);
  const asText = toSarif(reportOf([alertOf('3')]));
  assert.equal(asText.high, 1);
  assert.equal(asText.sarif.runs[0].results[0].properties['security-severity'], '8.0');
  // 모르는 등급과 빠진 등급은 High로 보아 막는다(닫힘 실패, BAT-045 RV-13a)
  const unknown = toSarif(reportOf([alertOf(9)]));
  assert.equal(unknown.high, 1);
  assert.equal(unknown.sarif.runs[0].results[0].properties['security-severity'], '9.0');
  assert.equal(run(reportOf([alertOf(9)])).code, 1);
  const missing = toSarif(reportOf([alertOf(undefined)]));
  assert.equal(missing.high, 1);
  assert.equal(missing.sarif.runs[0].results[0].properties['security-severity'], '9.0');
  assert.equal(run(reportOf([alertOf(undefined)])).code, 1);
  // 0~3은 지금 등급 그대로다
  const info = toSarif(reportOf([alertOf(0)]));
  assert.equal(info.high, 0);
  assert.equal(info.sarif.runs[0].results[0].properties['security-severity'], '0.0');
  assert.equal(run(reportOf([alertOf(0)])).code, 0);
});
