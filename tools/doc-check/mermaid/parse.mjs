// doc-check의 mermaid 문법 검사(ADR-0138). check_all.py가 부른다.
// 표준 입력: [{"id": 0, "code": "flowchart TD ..."}, ...]
// 표준 출력: [{"id": 0, "ok": true, "type": "flowchart-v2", "edges": ["라벨", ...]}, {"id": 1, "ok": false, "error": "..."}]
// mermaid는 DOMPurify 때문에 DOM이 있어야 읽으므로 jsdom으로 빈 창을 만든다.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const mermaid = (await import('mermaid')).default;
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });

let input = '';
for await (const chunk of process.stdin) input += chunk;
const blocks = JSON.parse(input);
const out = [];
for (const b of blocks) {
  try {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(b.code);
    const data = typeof diagram.db.getData === 'function' ? diagram.db.getData() : null;
    const edges = data && Array.isArray(data.edges) ? data.edges.map((e) => String(e.label ?? e.text ?? '')) : null;
    out.push({ id: b.id, ok: true, type: diagram.type, edges });
  } catch (e) {
    out.push({ id: b.id, ok: false, error: String((e && e.message) || e).split('\n').slice(0, 3).join(' / ') });
  }
}
process.stdout.write(JSON.stringify(out));
