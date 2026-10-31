// JSON Schema에서 additionalProperties: false와 additionalProperties: { not: {} }는 같은 뜻이다(정의 밖 칸을 받지 않는다).
// orval 8.45의 Zod 생성기는 false를 무시해 정의 밖 칸을 조용히 버리는 zod.object()를 만들고, { not: {} }는
// 거절하는 .catchall(zod.never())로 만든다. 권한 표는 요청 스키마의 정의 밖 칸을 400으로 거절하라고 하므로
// (docs/security/authz-matrix.md, ASVS 8.2.3·15.3.3) 생성 전에 계약 사본에서 앞의 표기를 뒤의 것으로 바꾼다(design.md 결정 9).
// 원본은 바꾸지 않고 새 값을 돌려준다. `properties` 안에 그 이름의 칸이 있어도 값이 false일 때만 바꾸므로 칸 정의는 건드리지 않는다.

export function closeAdditionalProperties(node) {
  if (Array.isArray(node)) return node.map(closeAdditionalProperties);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = k === 'additionalProperties' && v === false ? { not: {} } : closeAdditionalProperties(v);
  }
  return out;
}
