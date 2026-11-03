// 계약이 OpenAPI 규격을 어기면 생성이 조용히 넘어가지 않고 실패한다(design.md 결정 6).
// orval의 generate()는 기본으로 오류를 로그로만 남기고 끝나므로, 생성 스크립트가 그 오류를 실패로 바꿔야 한다.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ASYNCAPI, generateAll } from '../scripts/generate.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('중간085_규격을어긴계약이면_생성이실패한다', async () => {
  const work = mkdtempSync(join(tmpdir(), 'contracts-bad-'));
  dirs.push(work);
  const bad = join(work, 'openapi.yaml');
  // 응답 형식(Media Type)에 description은 OpenAPI 3.1에 없는 칸이다(결정 6의 ①과 같은 위반)
  writeFileSync(bad, [
    'openapi: 3.1.0',
    'info: { title: t, version: "1" }',
    'paths:',
    '  /v1/files/{fileId}:',
    '    get:',
    '      parameters: [{ name: fileId, in: path, required: true, schema: { type: string } }]',
    "      responses: { '200': { description: 파일, content: { text/csv: { schema: { type: string }, description: 잘못 } } } }",
    '',
  ].join('\n'));
  await expect(generateAll(join(work, 'out'), { openapi: bad, asyncapi: ASYNCAPI })).rejects.toThrow();
}, 60_000);
