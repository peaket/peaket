// orval 8.45의 Zod 생성기가 옮기지 않는 JSON Schema 제약을 다룬다(design.md 결정 10).
// - 옮길 수 있는 셋은 orval의 schemaExtension으로 생성 스키마에 검사 규칙(.refine)을 붙인다.
//   orval은 type과 format이 모두 같은 확장만 고르므로 format: ''(format이 없는 스키마)를 적는다.
// - 남은 것은 untranslatedKeywords()가 위치를 찾고, 시험(test/untranslated-constraints.test.ts)이 적어 둔 목록과 견준다.

/** orval 생성 스키마에 넣는 검사 규칙. callable은 생성물에 소스 그대로 옮겨지므로 바깥 변수는 bindings로만 넘긴다 */
export const schemaExtension = [
  {
    type: 'array',
    format: '',
    validatorsGenerator: (s) => (s.uniqueItems === true
      // JSON Schema는 키 순서만 다른 객체를 같은 값으로 보므로 직렬화할 때 객체의 키를 정렬해 견준다.
      // 이 함수는 생성된 TypeScript에 그대로 옮겨지므로, 매개변수 타입이 문맥에서 정해지는 꼴(JSON.stringify의 replacer)로 쓴다
      ? {
        callable: (v) => new Set(v.map((x) => JSON.stringify(x, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val)
          ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
          : val)))).size === v.length,
        bindings: null,
      }
      : null),
  },
  {
    type: 'object',
    format: '',
    validatorsGenerator: (s) => [
      s.maxProperties !== undefined
        ? { callable: (v) => Object.keys(v).length <= maxProperties, bindings: { maxProperties: s.maxProperties } }
        : null,
      s.propertyNames?.maxLength !== undefined
        ? { callable: (v) => Object.keys(v).every((k) => k.length <= maxNameLength), bindings: { maxNameLength: s.propertyNames.maxLength } }
        : null,
    ],
  },
];

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
