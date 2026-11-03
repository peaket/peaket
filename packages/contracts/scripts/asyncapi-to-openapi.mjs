// AsyncAPI 3.0 문서의 메시지 본문을 OpenAPI 3.1 구성 요소(components.schemas)로 옮긴다.
// 같은 생성기(orval)로 메시지 본문의 Zod 스키마와 타입을 만들려는 것이다(openspec 변경 add-contracts-package, design.md 결정 3).
// 바이너리 메시지는 빼고, 옮긴 문서에서 풀리지 않을 참조는 실패시킨다. 원본 문서는 바꾸지 않는다.

const BINARY = 'application/octet-stream';
const SCHEMA_REF = '#/components/schemas/';

function refsOutsideSchemas(node, found = []) {
  if (Array.isArray(node)) {
    for (const v of node) refsOutsideSchemas(v, found);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && !v.startsWith(SCHEMA_REF)) found.push(v);
      else refsOutsideSchemas(v, found);
    }
  }
  return found;
}

/**
 * @param {any} asyncapi 읽은 AsyncAPI 문서
 * @returns {{ openapi: string, info: { title: string, version: string }, paths: {}, components: { schemas: Record<string, any> } }}
 */
export function toOpenApi(asyncapi) {
  const components = asyncapi?.components ?? {};
  const schemas = {};
  for (const [name, schema] of Object.entries(components.schemas ?? {})) {
    schemas[name] = structuredClone(schema);
  }
  for (const [name, message] of Object.entries(components.messages ?? {})) {
    const contentType = message?.contentType ?? asyncapi.defaultContentType;
    if (contentType === BINARY) continue;
    const payload = message?.payload;
    if (!payload || typeof payload !== 'object') {
      throw new Error(`메시지 ${name}: 본문(payload)이 없다`);
    }
    if ('schemaFormat' in payload) {
      throw new Error(`메시지 ${name}: 본문의 schemaFormat(${payload.schemaFormat})은 옮기지 않는다. JSON Schema 본문만 받는다`);
    }
    if (name in schemas) {
      throw new Error(`메시지 ${name}: 같은 이름의 구성 요소 스키마가 이미 있다`);
    }
    const outside = refsOutsideSchemas(payload);
    if (outside.length) {
      throw new Error(`메시지 ${name}: ${outside.join(', ')}는 옮긴 문서에서 풀리지 않는다(${SCHEMA_REF}만 받는다)`);
    }
    schemas[name] = structuredClone(payload);
  }
  return {
    openapi: '3.1.0',
    info: { title: asyncapi.info?.title ?? 'AsyncAPI', version: asyncapi.info?.version ?? '0.0.0' },
    paths: {},
    components: { schemas },
  };
}
