#!/usr/bin/env node
// ZAP 기준선 점검 JSON을 SARIF로 바꾸는 도구(DAST 기준선 판정, docs/devops.md §3, ADR-0323).
// - High(riskcode 3)는 security-severity 8.0, Medium(2)은 5.0, Low(1)은 3.0, Informational(0)은 0.0으로 옮긴다.
// - 막는 판정은 tools/ci/scan-gate.mjs --tool zap이 한다(High 7.0 이상). 이 도구는 결과 파일이 없거나 비었거나
//   ZAP JSON 꼴이 아니거나 점검 흔적(site·@name/host)이 없으면 통과시키지 않고 1로 끝난다.
// - 보고서에는 요청·응답 본문·쿠키·공격 문자열(evidence·attack·otherinfo·request/response)을 옮기지 않는다.
// 쓰는 법: node tools/ci/dast-gate.mjs --report <zap.json> --out <sarif> [--event <사건>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runIfMain } from './entry.mjs';

/** 위험도(riskcode) → SARIF security-severity. 없는 등급은 0 */
export const SEVERITY_OF_RISK = Object.freeze({ 3: 8.0, 2: 5.0, 1: 3.0, 0: 0.0 });
export const BLOCK_SEVERITY = 7.0;

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * ZAP JSON을 읽어 SARIF 개체를 만든다. 꼴이 아니면 던진다.
 * 같은 규칙·주소의 중복은 하나로 합친다(인스턴스 여럿).
 * @param {unknown} report
 * @returns {{ sarif: object, high: number, medium: number, findings: number }}
 */
export function toSarif(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) throw new Error('ZAP JSON이 객체가 아니다');
  const sites = report.site;
  if (!Array.isArray(sites) || sites.length === 0) throw new Error('ZAP JSON에 site 목록이 없다(점검 흔적 없음)');
  const rules = new Map();
  const results = [];
  const seen = new Set();
  let high = 0;
  let medium = 0;
  for (const [si, site] of sites.entries()) {
    if (site === null || typeof site !== 'object') throw new Error(`site[${si}]가 객체가 아니다`);
    const host = str(site['@name']) || str(site.host);
    if (host === '') throw new Error(`site[${si}]에 @name/host가 없다(점검 흔적 없음)`);
    const alerts = site.alerts;
    if (!Array.isArray(alerts)) throw new Error(`site[${si}]에 alerts 목록이 없다`);
    for (const [ai, alert] of alerts.entries()) {
      if (alert === null || typeof alert !== 'object') throw new Error(`site[${si}].alerts[${ai}]가 객체가 아니다`);
      const pluginId = str(alert.pluginid) || 'unknown';
      const riskCode = Number(alert.riskcode);
      const level = riskCode === 3 ? 'error' : riskCode === 2 ? 'warning' : 'note';
      if (riskCode === 3) high += 1;
      if (riskCode === 2) medium += 1;
      const ruleId = `ZAP-${pluginId}`;
      const severity = SEVERITY_OF_RISK[riskCode] ?? 0;
      if (!rules.has(ruleId)) {
        rules.set(ruleId, {
          id: ruleId,
          name: str(alert.alert) || ruleId,
          shortDescription: { text: str(alert.alert) || ruleId },
          defaultConfiguration: { level },
          properties: { 'security-severity': severity.toFixed(1), tags: ['security', 'dast'] },
        });
      }
      const instances = Array.isArray(alert.instances) ? alert.instances : [];
      const uris = instances.length > 0 ? instances.map((x) => str(x?.uri)).filter(Boolean) : [`https://${host}`];
      for (const uri of uris.length > 0 ? uris : [`https://${host}`]) {
        const key = `${ruleId}|${uri}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          ruleId,
          level,
          message: { text: str(alert.name) || str(alert.alert) || ruleId },
          locations: [{ physicalLocation: { artifactLocation: { uri } } }],
          properties: { 'security-severity': severity.toFixed(1), riskcode: String(riskCode) },
        });
      }
    }
  }
  return {
    sarif: {
      version: '2.1.0',
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      runs: [
        {
          tool: { driver: { name: 'ZAP', informationUri: 'https://www.zaproxy.org/', rules: [...rules.values()] } },
          results,
        },
      ],
    },
    high,
    medium,
    findings: results.length,
  };
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, options: { report: { type: 'string' }, out: { type: 'string' }, event: { type: 'string' } } });
  if (!values.report || !values.out) throw new Error('--report와 --out이 필요하다');
  if (!existsSync(values.report)) throw new Error(`ZAP 결과 파일이 없다: ${values.report}`);
  const text = readFileSync(values.report, 'utf8');
  if (text.trim() === '') throw new Error(`ZAP 결과 파일이 비었다: ${values.report}`);
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error(`ZAP 결과 파일이 JSON이 아니다: ${values.report}`);
  }
  const { sarif, high, medium, findings } = toSarif(report);
  writeFileSync(values.out, `${JSON.stringify(sarif, null, 2)}\n`);
  console.log(`ZAP 기준선: 결과 ${findings}건(High ${high}, Medium ${medium}) → ${values.out}`);
  // 이벤트 이름은 판정 도구가 받는 값과 같게 두되, 여기서는 막지 않는다(High는 scan-gate가 막는다)
  // High가 있어도 SARIF는 남긴다. 이 도구는 High가 있으면 1로 끝나고, scan-gate --tool zap도 같은 결과를 막는다
  return high > 0 ? 1 : 0;
}

await runIfMain(import.meta.url, async () => {
  try {
    return main();
  } catch (e) {
    console.log(process.env.GITHUB_ACTIONS === 'true' ? `::error::${e.message}` : `실패: ${e.message}`);
    return 1;
  }
});
