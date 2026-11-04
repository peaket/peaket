// 시험 보고서 읽기(trace-check.mjs·asvs-report.mjs가 같이 쓴다).
// 보고서: vitest JSON(`vitest run --reporter=json --outputFile=…`), JUnit XML(`node --test --test-reporter=junit`, pytest `--junitxml`).
import { readFileSync } from 'node:fs';

/** 보고서가 틀렸다(종료 코드 2) */
export class ReportError extends Error {}

const unescapeXml = (s) =>
  s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[name.toLowerCase()] ?? m;
  });

/** 보고서 하나 → [{ name, status: passed|failed|skipped }] */
export function readReport(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (text.startsWith('{')) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ReportError(`JSON 보고서를 읽지 못했다: ${path}`);
    }
    if (!Array.isArray(json.testResults)) throw new ReportError(`vitest JSON 보고서가 아니다(testResults 없음): ${path}`);
    return json.testResults.flatMap((f) =>
      (f.assertionResults ?? []).map((t) => ({
        name: t.fullName ?? [...(t.ancestorTitles ?? []), t.title].join(' '),
        status: t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'skipped',
      })),
    );
  }
  if (text.startsWith('<')) {
    const out = [];
    // 속성 값은 따옴표째 한 덩어리로 읽는다. node --test는 속성 안의 '>'를 바꾸지 않고 실패 메시지를 failure 속성에도 싣는다(새 맥락 리뷰)
    const re = /<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
    for (const m of text.matchAll(re)) {
      const attrs = new Map([...m[1].matchAll(/([A-Za-z_:][-\w.:]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((a) => [a[1], unescapeXml(a[2] ?? a[3] ?? '')]));
      const attr = (k) => attrs.get(k) ?? '';
      const body = m[3] ?? '';
      const status = /<(failure|error)\b/.test(body) || attrs.has('failure') || attrs.has('error') ? 'failed' : /<skipped\b/.test(body) || attrs.has('skipped') ? 'skipped' : 'passed';
      out.push({ name: `${attr('classname')} ${attr('name')}`.trim(), status });
    }
    return out;
  }
  throw new ReportError(`보고서 형식을 모른다(vitest JSON·JUnit XML만): ${path}`);
}
