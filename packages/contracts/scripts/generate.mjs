// 계약 원본에서 Zod 스키마와 TypeScript 타입을 만든다(openspec 변경 add-contracts-package, design.md 결정 2·3·9·10).
// 사용: node scripts/generate.mjs        → 임시 폴더에 다 만든 뒤에만 src/gen/을 바꿔 넣는다(실패하면 src/gen/은 그대로)
//       generateAll(폴더)                → 그 폴더에 만든다(차이 검사가 임시 폴더에 쓴다)
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from 'orval';
import { parse } from 'yaml';
import { toOpenApi } from './asyncapi-to-openapi.mjs';
import { closeAdditionalProperties } from './close-additional-properties.mjs';
import { schemaExtension } from './schema-extensions.mjs';

const API = fileURLToPath(new URL('../../../docs/api/', import.meta.url));
export const OPENAPI = join(API, 'openapi.yaml');
export const ASYNCAPI = join(API, 'asyncapi.yaml');
export const GEN = fileURLToPath(new URL('../src/gen', import.meta.url));

// orval의 generate()는 기본으로 검증·생성 오류를 로그로만 남기고 끝난다. 규격을 어긴 계약이 조용히 넘어가지 않게
// 오류를 던지게 하고, 경고도 실패로 본다(결정 6). 로그는 경고 이상만 낸다
const STRICT = { throwOnError: true, failOnWarnings: true, logLevel: 'warn' };

/**
 * 결정 9의 두 번째 절반: { not: {} }에서 나온 `.catchall(zod.never())`는 정의 밖 칸을 거절하지만, Zod 4는 그 타입을
 * `{ [x: string]: never; … }`로 추론해 정의한 칸까지 never가 되어 입력 타입을 쓸 수 없다. 같은 거절을 하면서 타입이 맞는
 * `.strict()`로 바꾼다(z.toJSONSchema 결과도 additionalProperties: false). 이 표기는 결정 9의 바꾸기에서만 나온다.
 * @param {string} text 생성된 파일 내용
 */
export function strictifyClosedObjects(text) {
  return text.replaceAll('.catchall(zod.never())', '.strict()');
}

function eachFile(dir, fn) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) eachFile(p, fn);
    else fn(p);
  }
}

/**
 * @param {string} out 만들 폴더(없으면 만든다)
 * @param {{ openapi?: string, asyncapi?: string }} [from] 계약 원본(기본은 docs/api/의 둘)
 */
export async function generateAll(out, { openapi = OPENAPI, asyncapi = ASYNCAPI } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'contracts-input-'));
  try {
    // 생성기에 넣는 계약 사본: additionalProperties: false를 같은 뜻의 { not: {} }로 바꾼다(결정 9)
    const rest = join(work, 'openapi.json');
    writeFileSync(rest, JSON.stringify(closeAdditionalProperties(parse(readFileSync(openapi, 'utf8'))), null, 2));
    // AsyncAPI 메시지 본문을 OpenAPI 구성 요소로 옮긴 임시 문서(결정 3)
    const events = join(work, 'asyncapi.openapi.json');
    writeFileSync(events, JSON.stringify(closeAdditionalProperties(toOpenApi(parse(readFileSync(asyncapi, 'utf8')))), null, 2));
    await generate({
      input: { target: rest },
      output: { target: join(out, 'openapi', 'operations.ts'), client: 'zod', mode: 'tags', schemas: { path: join(out, 'openapi', 'model'), type: 'zod' }, override: { zod: { schemaExtension } } },
    }, process.cwd(), STRICT);
    await generate({
      input: { target: events },
      output: { target: join(out, 'asyncapi', 'operations.ts'), client: 'zod', mode: 'single', schemas: { path: join(out, 'asyncapi', 'model'), type: 'zod' }, override: { zod: { schemaExtension } } },
    }, process.cwd(), STRICT);
    // 옮긴 문서에는 작업(paths)이 없어 작업 파일은 머리말뿐이다. 내보내지 않으므로 지운다
    rmSync(join(out, 'asyncapi', 'operations.ts'), { force: true });
    eachFile(out, (p) => {
      const text = readFileSync(p, 'utf8');
      const fixed = strictifyClosedObjects(text);
      if (fixed !== text) writeFileSync(p, fixed);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const fresh = mkdtempSync(join(tmpdir(), 'contracts-gen-'));
  try {
    await generateAll(fresh);
    rmSync(GEN, { recursive: true, force: true });
    cpSync(fresh, GEN, { recursive: true });
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}
