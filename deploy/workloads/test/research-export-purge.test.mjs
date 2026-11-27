// F-04-19 research_export_denial purge CronJob 정적 시험(동결 로컬, LCH-330).
// 정본: deploy/jobs/research-export-purge.yaml, deploy/jobs/README.md, migrations/0041_research_export_purge.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '..', '..', 'jobs', 'research-export-purge.yaml');
const raw = readFileSync(FILE, 'utf8');
const job = parse(raw);
const container = job.spec.jobTemplate.spec.template.spec.containers[0];
const script = [container.command, container.args].flat().join('\n');

test('CronJob은 매일 04:15 UTC에 겹치지 않고 300초 안에 끝나며 3개 기록만 남긴다', () => {
  assert.equal(job.apiVersion, 'batch/v1');
  assert.equal(job.kind, 'CronJob');
  assert.equal(job.metadata.name, 'research-export-purge');
  assert.equal(job.spec.schedule, '15 4 * * *');
  assert.equal(job.spec.timeZone, 'Etc/UTC');
  assert.equal(job.spec.concurrencyPolicy, 'Forbid');
  assert.equal(job.spec.startingDeadlineSeconds, 600);
  assert.equal(job.spec.successfulJobsHistoryLimit, 3);
  assert.equal(job.spec.failedJobsHistoryLimit, 3);
  assert.equal(job.spec.jobTemplate.spec.backoffLimit, 2);
  assert.equal(job.spec.jobTemplate.spec.activeDeadlineSeconds, 300);
  assert.equal(job.spec.jobTemplate.spec.template.spec.restartPolicy, 'OnFailure');
});

test('명령은 ops_research_purger로 SET ROLE하고 90일 purge 함수만 부른다', () => {
  assert.match(script, /SET ROLE ops_research_purger/);
  assert.match(script, /SELECT public\.research_export_denial_purge\(\)/);
  assert.match(script, /ON_ERROR_STOP=1/);
  assert.doesNotMatch(script, /SET ROLE ops_app/);
  assert.doesNotMatch(script, /ops-svc-secrets/);
});

test('DSN은 Secret에서만 받고 ops_app 자격 증명을 쓰지 않는다', () => {
  const env = Object.fromEntries(container.env.map((e) => [e.name, e]));
  assert.equal(env.PEAKET_RESEARCH_PURGE_DATABASE_URL.valueFrom.secretKeyRef.name, 'ops-research-purge-secrets');
  assert.equal(env.PEAKET_RESEARCH_PURGE_DATABASE_URL.valueFrom.secretKeyRef.key, 'PEAKET_RESEARCH_PURGE_DATABASE_URL');
  assert.equal(env.PEAKET_RESEARCH_PURGE_DATABASE_URL.value, undefined);
  assert.doesNotMatch(raw, /postgres(?:ql)?:\/\//);
  assert.doesNotMatch(raw, /PEAKET_DATABASE_URL/);
});

test('Pod는 토큰을 마운트하지 않고 비루트·읽기 전용·권한 상승 금지로 돈다', () => {
  const pod = job.spec.jobTemplate.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
});
