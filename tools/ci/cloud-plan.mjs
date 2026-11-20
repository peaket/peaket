#!/usr/bin/env node
// BAT-086 클라우드 데모 값 검사 입구(tools/ci). 본체는 tools/local/demo/cloud-plan.mjs다.
// `node tools/ci/cloud-plan.mjs --check`로 deploy/demo/cloud-plan.yaml의 산술·필수 항목을 본다(실제 실행 없음).
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const body = resolve(import.meta.dirname, '..', 'local', 'demo', 'cloud-plan.mjs');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.argv = [process.argv[0], body, ...process.argv.slice(2)];
  await import(pathToFileURL(body).href);
}
