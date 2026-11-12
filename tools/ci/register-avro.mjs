#!/usr/bin/env node
// Avro 사건 스키마를 Schema Registry에 등록하고 주제 → 스키마 ID를 JSON으로 낸다(BUILD_ORDER BAS-030, docs/api/avro/README.md §3, D-T39).
// ArgoCD PreSync 등록 Job이 쓴다. CI는 운영 레지스트리에 닿지 않고, 로컬 레지스트리 컨테이너로만 시험한다.
// 쓰는 법: node tools/ci/register-avro.mjs --registry <url> --topic-map <json>
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerToRegistry } from './avro-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const registry = value('--registry');
const topicMapPath = value('--topic-map');
const root = value('--root', join(HERE, '..', '..', 'docs', 'api', 'avro'));
if (!registry || !topicMapPath) {
  console.error('쓰는 법: node tools/ci/register-avro.mjs --registry <url> --topic-map <json> [--root docs/api/avro]');
  process.exit(2);
}
const r = await registerToRegistry(root, registry, JSON.parse(readFileSync(topicMapPath, 'utf8')));
if (r.errors.length > 0) {
  for (const e of r.errors) console.error(`실패: ${e}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(r.ids, null, 2));
}
