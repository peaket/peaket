// 표본 배정 작업 실행 파일(BAT-197, 계획 §3.1 3).
// 실행: PEAKET_DATABASE_URL=... PEAKET_ANALYTICS_CLICKHOUSE_URL=... node dist/bot-review-assign.js --event <uuid> [--kind PASSED_SAMPLE|HUMAN_BASELINE]
// 후보 원장에서 뽑아 섞은 배치를 만들고 결과를 JSON 한 줄로 낸다. 같은 회차·종류에 두 번 돌려도 배치 하나다.
import 'reflect-metadata';
import { createDatabase, systemClock } from '@peaket/platform';
import { AssignBotReviewSamples, DrizzleBotReviewStore } from './modules/bot-review/index.js';
import type { ReviewKind } from './modules/bot-review/index.js';
import { botReviewSourceFromEnv } from './bot-review-wiring.js';

function argOf(name: string): string | undefined {
  const args = process.argv.slice(2);
  const withEquals = args.find((a) => a.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

const eventId = argOf('event');
if (!eventId) throw new Error('--event <회차 ID>가 필요하다');
const kindText = argOf('kind') ?? 'PASSED_SAMPLE';
if (kindText !== 'PASSED_SAMPLE' && kindText !== 'HUMAN_BASELINE') throw new Error('--kind는 PASSED_SAMPLE·HUMAN_BASELINE 가운데 하나다');
const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');

const database = createDatabase({ url, applicationName: 'ops-svc-bot-review-assign' });
try {
  const source = botReviewSourceFromEnv(process.env);
  if (source.warning) console.warn(JSON.stringify({ level: 'warn', kind: 'bot-review-assign', msg: source.warning }));
  const result = await new AssignBotReviewSamples({
    store: new DrizzleBotReviewStore(database, systemClock),
    source: source.source,
    now: () => systemClock.now(),
  }).run({ eventId, reviewKind: kindText as ReviewKind });
  console.log(JSON.stringify({ kind: 'bot-review-assign', eventId, reviewKind: kindText, ...result }));
} finally {
  await database.close();
}
