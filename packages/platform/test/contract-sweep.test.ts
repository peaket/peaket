// 계약 전체 대조(D-T38, 코드 리뷰 2026-11-01): 계약의 모든 작업에서 성공 응답과 JSON 요청 본문을 계약 Zod(@peaket/contracts 생성물)
// → contractSchema로 바꾼 문서를 비교기(tools/ci/service-openapi.mjs)에 넣는다. 서비스가 README대로 계약 Zod로 문서를 달면
// D-T38이 거짓 실패하지 않는다는 뜻이다. 남는 차이는 생성 Zod가 계약과 실제로 다른 곳뿐이어야 한다(아래 KNOWN).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { z } from 'zod';
import { contractSchema } from '../src/index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\\/g, '/');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
type Doc = { paths: Record<string, Record<string, any>>; components: Record<string, Record<string, any>> };

/**
 * 생성 Zod가 계약과 실제로 다른 곳(이 시험이 찾은 것, 계약 패키지에서 고친다). 비교기가 이것을 잡는 것도 함께 지킨다.
 * BAS-040에서 비웠다: orval 8.45가 allOf 안의 읽기 전용 칸(HomeLayout.updatedAt·updatedBy)을 요청 본문 Zod에서 빼지 않던 것은
 * 홈 구성 저장 본문을 요청용 HomeLayoutInput 하나로 바꿔 없앴다(요청 본문은 allOf로 잇지 않는다, docs/api/guidelines.md §1)
 */
const KNOWN: string[] = [];

test('DT38_계약의모든작업을_계약Zod로만든문서는_비교기에서계약과같다', { timeout: 60_000 }, async () => {
  const { compareService, readContract } = await import(`${ROOT}tools/ci/service-openapi.mjs`);
  const dir = `${ROOT}packages/contracts/src/gen/openapi/`;
  const gen: Record<string, z.ZodType> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) Object.assign(gen, await import(`${dir}${f}`));
  const byName = new Map(Object.entries(gen).map(([k, v]) => [k.toLowerCase(), v]));
  const contract: Doc = readContract(ROOT);
  const diffs: string[] = [];
  let replaced = 0;
  for (const [path, item] of Object.entries(contract.paths)) {
    for (const m of ['get', 'put', 'post', 'delete', 'patch']) {
      if (!item[m]) continue;
      const key = `${m.toUpperCase()} ${path}`;
      // 생성 이름은 작업 이름(operationId)에서 온다(CreateEventHoldBody, docs/api/guidelines.md §10 '작업 이름')
      const prefix = norm(String(item[m].operationId));
      const emitted: Doc = JSON.parse(JSON.stringify(contract));
      const op = emitted.paths[path][m];
      let did = false;
      const body = byName.get(`${prefix}body`);
      if (body && op.requestBody) {
        if (op.requestBody.$ref) op.requestBody = structuredClone(emitted.components.requestBodies[op.requestBody.$ref.split('/').pop()]);
        if (op.requestBody.content?.['application/json']) {
          op.requestBody.content['application/json'].schema = contractSchema(body, { io: 'input' });
          did = true;
        }
      }
      const resp = byName.get(`${prefix}response`);
      const ok = Object.keys(op.responses ?? {}).filter((s) => /^2/.test(s));
      if (resp && ok.length === 1) {
        let r = op.responses[ok[0]];
        if (r.$ref) r = op.responses[ok[0]] = structuredClone(emitted.components.responses[r.$ref.split('/').pop()]);
        if (r.content?.['application/json']) {
          r.content['application/json'].schema = contractSchema(resp);
          did = true;
        }
      }
      if (!did) continue;
      replaced++;
      for (const d of compareService({ contract, emitted, owns: [key] }) as string[]) if (!d.includes('맡는 목록에 없다')) diffs.push(d);
    }
  }
  expect(replaced).toBeGreaterThan(150);
  expect(diffs).toEqual(KNOWN);
});
