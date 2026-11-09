#!/usr/bin/env node
// RB-35 런북 CLI 시작 파일(비상 Job에서 돈다, ADR-0239 결정 6·8): peaket-runbook draft|sign|run.
// 대기열 Redis에 묶음을 전달하고, 서명은 운영자의 KMS 비대칭 키로 한다. 키 재료는 이 프로세스에 들어오지 않는다.
import { readFileSync, writeFileSync } from 'node:fs';
import { KMSClient } from '@aws-sdk/client-kms';
import { createHotRedis, systemClock } from '@peaket/platform';
import { RedisBatchStore } from './modules/batch/index.js';
import { commanderKeysFromEnv, COMMANDER_KEYS_ENV, kmsRunbookSigner, RedisRb35Store, runRunbookCli } from './modules/rb35/index.js';

const LOCAL_ENVS = ['local', 'ci'];
const peaketEnv = process.env.PEAKET_ENV || 'prod';
const region = process.env.AWS_REGION ?? 'ap-northeast-2';
const endpoint = process.env.PEAKET_KMS_ENDPOINT;
if (endpoint && !LOCAL_ENVS.includes(peaketEnv)) throw new Error(`PEAKET_KMS_ENDPOINT는 ${LOCAL_ENVS.join('·')}에서만 쓴다`);
const kms = new KMSClient({ region, ...(endpoint ? { endpoint } : {}), maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_000, throwOnRequestTimeout: true } });

const clusterUrls = (process.env.PEAKET_QUEUE_REDIS_CLUSTER_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const url = process.env.PEAKET_QUEUE_REDIS_URL;
if (!url && clusterUrls.length === 0) throw new Error('PEAKET_QUEUE_REDIS_URL이나 PEAKET_QUEUE_REDIS_CLUSTER_URLS가 없다');
const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url });
const rawKeys = process.env[COMMANDER_KEYS_ENV];

try {
  const store = new RedisRb35Store(redis, new RedisBatchStore(redis));
  process.exitCode = await runRunbookCli(process.argv.slice(2), {
    store,
    clock: systemClock,
    keys: rawKeys ? commanderKeysFromEnv(rawKeys) : null,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, s) => writeFileSync(p, s, 'utf8'),
    print: (line) => process.stdout.write(`${line}\n`),
    kmsSign: kmsRunbookSigner(kms),
    ...(process.env.PEAKET_RUNBOOK_SIGNING_KEY ? { defaultSigningKey: process.env.PEAKET_RUNBOOK_SIGNING_KEY } : {}),
  });
} finally {
  await redis.close();
}
