// 서버 그리기 HTML을 읽는 작은 도우미(시험 전용, F-03-3). 이름이 *.test.mjs로 끝나지 않아 node --test가 시험 파일로 돌리지 않는다.
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' };
export const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (m) => ENTITIES[m]);

/** 보이는 글(태그·주석을 빼고 공백을 하나로) */
export function textOf(html) {
  return decode(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

const attrsOf = (raw) => Object.fromEntries([...raw.matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)].map((a) => [a[1], decode(a[2] ?? '')]));

/** <a> 요소마다 속성과 글 */
export function anchors(html) {
  return [...html.matchAll(/<a(\s[^>]*)?>([\s\S]*?)<\/a>/g)].map((m) => ({ ...attrsOf(m[1] ?? ''), text: textOf(m[2]) }));
}

/** 이름이 tag인 요소의 여는 태그 속성들 */
export function elements(html, tag) {
  return [...html.matchAll(new RegExp(`<${tag}(\\s[^>]*)?\\/?>`, 'g'))].map((m) => attrsOf(m[1] ?? ''));
}

/** 링크가 새 탭·opener 없음인가(rel 낱말에 noopener) */
export const newTabNoOpener = (a) => a.target === '_blank' && (a.rel ?? '').split(/\s+/).includes('noopener');
