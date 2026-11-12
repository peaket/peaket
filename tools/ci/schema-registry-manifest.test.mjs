// Avro 스키마 등록 Job·ConfigMap 정본(BUILD_ORDER BAS-030, docs/api/avro/README.md §3, D-T39) 시험.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = join(REPO, 'deploy', 'charts', 'peaket-service', 'templates', 'schema-registry-job.yaml');

test('D-T39: 스키마 등록 Job은 ArgoCD PreSync 훅이고 주제별 ID를 ConfigMap schema-ids에 쓰며 등록 도구 이미지를 고정한다', () => {
  const text = readFileSync(TEMPLATE, 'utf8');
  assert.match(text, /argocd\.argoproj\.io\/hook:\s*PreSync/);
  assert.match(text, /kind:\s*ConfigMap[\s\S]*name:\s*schema-ids/);
  assert.match(text, /kind:\s*Job/);
  assert.match(text, /resources:\s*\["configmaps"\]/);
  assert.match(text, /verbs:\s*\["get",\s*"create",\s*"update",\s*"patch"\]/);
  assert.match(text, /schemaRegistry\.image/);
  assert.match(text, /PEAKET_SCHEMA_REGISTRY_URL/);
  assert.match(text, /register-avro\.mjs/);
  assert.match(text, /schema-ids\.json/);
});
