// 계약 깨짐 검사가 쓰는 AsyncAPI 메시지 본문 변환(openspec 변경 add-contract-breaking-check, design.md 결정 4, D-T48).
// AsyncAPI CLI의 diff는 AsyncAPI 3.0 메시지 본문의 필드·열거 기호 지우기를 분류하지 않는다(2026-11-01 확인).
// 소비자가 메시지를 읽는 것은 클라이언트가 응답을 읽는 것과 같은 방향이므로, 메시지마다 GET /messages/<이름>의
// 200 응답으로 본문을 가리키는 OpenAPI 문서를 만들어 oasdiff의 응답 규칙으로 견주게 한다.
// 내용 형식으로 나눠 고를 수 있다: json(application/json 등 Avro가 아닌 것), avro(application/avro). 바이너리는 늘 뺀다.
// 사용: node scripts/asyncapi-messages.mjs <asyncapi.yaml> <나갈 파일.json> [json|avro]   (tools/ci/contract-breaking.mjs가 부른다)
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { toOpenApi } from './asyncapi-to-openapi.mjs';

const KINDS = ['json', 'avro'];
const kindOf = (message, doc) => (/avro/i.test(message?.contentType ?? doc.defaultContentType ?? '') ? 'avro' : 'json');

/**
 * @param {any} asyncapi 읽은 AsyncAPI 문서
 * @param {'json' | 'avro'} [kind] 이 형식의 메시지만 작업으로 만든다(없으면 모두)
 * @returns {{ openapi: string, info: { title: string, version: string }, paths: Record<string, any>, components: { schemas: Record<string, any> } }}
 */
export function messagesAsOperations(asyncapi, kind) {
  if (kind !== undefined && !KINDS.includes(kind)) throw new Error(`형식은 ${KINDS.join('·')} 가운데 하나다: ${kind}`);
  const doc = toOpenApi(asyncapi);
  const messages = asyncapi?.components?.messages ?? {};
  for (const name of Object.keys(messages)) {
    if (!(name in doc.components.schemas)) continue; // 바이너리 메시지는 변환기가 뺐다
    if (kind && kindOf(messages[name], asyncapi) !== kind) continue;
    doc.paths[`/messages/${name}`] = {
      get: {
        operationId: `read${name}`,
        responses: { '200': { description: name, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } } },
      },
    };
  }
  return doc;
}

if (import.meta.main) {
  const [from, to, kind] = process.argv.slice(2);
  if (!from || !to) {
    console.error('사용: node scripts/asyncapi-messages.mjs <asyncapi.yaml> <나갈 파일.json> [json|avro]');
    process.exit(2);
  }
  writeFileSync(to, JSON.stringify(messagesAsOperations(parse(readFileSync(from, 'utf8')), kind), null, 2));
}
