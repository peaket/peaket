// orval 8.45의 Zod 생성기가 옮기지 않는 JSON Schema 제약을 다룬다(design.md 결정 10).
// - 옮길 수 있는 셋은 orval의 schemaExtension으로 생성 스키마에 검사 규칙(.refine)을 붙인다.
//   orval은 type과 format이 모두 같은 확장만 고르므로 format: ''(format이 없는 스키마)를 적는다.
// - 남은 것은 untranslatedKeywords()가 위치를 찾고, 시험(test/untranslated-constraints.test.ts)이 적어 둔 목록과 견준다.

// 검사 규칙 함수. callable은 생성물에 소스 그대로 옮겨지므로 바깥 변수는 bindings로만 넘긴다.
// JSON Schema는 키 순서만 다른 객체를 같은 값으로 보므로 직렬화할 때 객체의 키를 정렬해 견준다.
// 이 함수는 생성된 TypeScript에 그대로 옮겨지므로, 매개변수 타입이 문맥에서 정해지는 꼴(JSON.stringify의 replacer)로 쓴다
const uniqueItemsCheck = (v) => new Set(v.map((x) => JSON.stringify(x, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : val)))).size === v.length;
const maxPropertiesCheck = (v) => Object.keys(v).length <= maxProperties;
// 글자 수는 코드 포인트로 센다(JSON Schema maxLength·Ajv·Zod .max()와 같다. UTF-16 단위로 세면 이모지 이름이 두 길에서 달랐다, 코드 리뷰 2026-11-01)
const propertyNamesCheck = (v) => Object.keys(v).every((k) => [...k].length <= maxNameLength);

/** orval 생성 스키마에 넣는 검사 규칙 */
export const schemaExtension = [
  {
    type: 'array',
    format: '',
    validatorsGenerator: (s) => (s.uniqueItems === true ? { callable: uniqueItemsCheck, bindings: null } : null),
  },
  {
    type: 'object',
    format: '',
    validatorsGenerator: (s) => [
      s.maxProperties !== undefined ? { callable: maxPropertiesCheck, bindings: { maxProperties: s.maxProperties } } : null,
      s.propertyNames?.maxLength !== undefined ? { callable: propertyNamesCheck, bindings: { maxNameLength: s.propertyNames.maxLength } } : null,
    ],
  },
];

// orval 8.45가 위 확장을 옮겨 쓰는 모양: bindings가 없으면 .refine((함수)), 있으면 즉시 부르는 함수 안의 const
const bound = (name, check) => ({ head: `(() => {\n  const ${name} = `, tail: `;\n  return (${check});\n})()` });
const KNOWN = [
  { exact: `(${uniqueItemsCheck})`, meta: () => '{ "uniqueItems": true }' },
  { ...bound('maxProperties', maxPropertiesCheck), meta: (n) => `{ "maxProperties": ${n} }` },
  { ...bound('maxNameLength', propertyNamesCheck), meta: (n) => `{ "propertyNames": { "maxLength": ${n} } }` },
];

/** .refine( 뒤 여는 괄호의 짝이 되는 닫는 괄호 위치(검사 함수 소스에는 괄호가 든 문자열이 없다) */
function closingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  throw new Error('.refine( 의 닫는 괄호가 없다');
}

/**
 * 생성물의 검사 규칙(.refine) 뒤에 같은 JSON Schema 낱말을 Zod 메타데이터로 단다(add-service-structure-and-request-checks 결정 4).
 * z.toJSONSchema()는 .refine을 옮기지 못하지만 메타데이터는 그대로 싣는다. 그래서 Fastify 경로 스키마와 서비스 문서 비교(D-T38)도
 * 그 제약을 본다. 모르는 모양의 .refine이 있으면 던진다(메타데이터 없는 검사 규칙이 조용히 남지 않게)
 * @param {string} text 생성된 파일 내용
 */
export function annotateRefines(text) {
  let out = '';
  let at = 0;
  for (;;) {
    const start = text.indexOf('.refine(', at);
    if (start < 0) return out + text.slice(at);
    const open = start + '.refine'.length;
    const close = closingParen(text, open);
    const inner = text.slice(open + 1, close);
    let meta;
    for (const k of KNOWN) {
      if (k.exact !== undefined && inner === k.exact) meta = k.meta();
      else if (k.head !== undefined && inner.startsWith(k.head) && inner.endsWith(k.tail)) {
        const n = inner.slice(k.head.length, inner.length - k.tail.length);
        if (/^\d+$/.test(n)) meta = k.meta(n);
      }
    }
    if (meta === undefined) throw new Error(`메타데이터를 달 수 없는 검사 규칙: .refine(${inner.slice(0, 80)}…`);
    out += `${text.slice(at, close + 1)}.meta(${meta})`;
    at = close + 1;
  }
}

/**
 * 모음 파일의 상대 다시 내보내기에 .js를 붙인다(결정 10). TypeScript(NodeNext·Bundler)와 Vite는 .js를 원본 .ts로 찾고,
 * tsc로 만든 dist/는 그대로 Node가 읽는다
 * @param {string} text 생성된 파일 내용
 */
export function addJsExtensions(text) {
  return text.replace(/^(export \* from '\.\/[^']+?)(?<!\.js)';$/gm, "$1.js';");
}

// 생성기가 옮기지 않는 제약 키워드. 위 확장이 옮기는 셋은 확장이 실제로 붙는 자리(같은 노드에 type이 array·object이고
// format이 없음)일 때만 빼고, 그 밖의 자리(type이 없음, allOf의 한 갈래, format이 있음)는 못 옮긴 것으로 센다
const UNTRANSLATED = new Set(['minProperties', 'patternProperties', 'if', 'then', 'else', 'dependentRequired',
  'dependentSchemas', 'contains', 'minContains', 'maxContains', 'not', 'unevaluatedProperties', 'unevaluatedItems']);
const SKIP = new Set(['example', 'examples', 'default', 'const', 'enum']);
const EXTENDED = { uniqueItems: 'array', maxProperties: 'object', propertyNames: 'object' };

function extensionApplies(node, keyword) {
  if (node.type !== EXTENDED[keyword] || node.format !== undefined) return false;
  if (keyword !== 'propertyNames') return true;
  const v = node.propertyNames;
  return !!v && typeof v === 'object' && Object.keys(v).length === 1 && v.maxLength !== undefined;
}

/**
 * 계약에서 생성 스키마가 걸러 주지 않는 제약의 위치를 `<이름>:<점으로 이은 경로>`로 돌려준다.
 * `properties` 아래의 키는 칸 이름이라 키워드로 보지 않는다. 예시·기본값 같은 값 자리는 보지 않는다.
 * @param {any} doc 읽은 계약 문서
 * @param {string} label 위치 앞에 붙일 이름
 */
export function untranslatedKeywords(doc, label) {
  const out = [];
  const walk = (node, path, underProperties) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, false));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const here = path ? `${path}.${k}` : k;
      if (!underProperties) {
        if (SKIP.has(k)) continue;
        if (UNTRANSLATED.has(k)) out.push(`${label}:${here}`);
        if (k in EXTENDED && !extensionApplies(node, k)) out.push(`${label}:${here}`);
      }
      walk(v, here, !underProperties && k === 'properties');
    }
  };
  walk(doc, '', false);
  return out;
}
