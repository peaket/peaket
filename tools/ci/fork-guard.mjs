#!/usr/bin/env node
// 비밀이 필요한 단계의 포크 PR 건너뛰기 표시(docs/devops.md §4.5 '신뢰하지 않는 코드에 비밀 노출', 기술 검토 낮음-010, BUILD_ORDER FND-110).
// 포크에서 온 PR에는 GitHub가 비밀을 주지 않는다(pull_request_target은 쓰지 않는다). 그런 단계는 실패하지 않고 '건너뜀'을 눈에 보이게 남기고
// 조직 안 PR·develop에서 돈다. 조직 안 PR이나 푸시에서 비밀이 빠졌으면 설정 실수라 건너뛰지 않고 실패한다.
// 쓰는 법(단계 하나):
//   - id: guard
//     env: { LOCALSTACK_AUTH_TOKEN: ${{ secrets.LOCALSTACK_AUTH_TOKEN }} }
//     run: node tools/ci/fork-guard.mjs --job <잡 이름> --needs LOCALSTACK_AUTH_TOKEN
//   - if: steps.guard.outputs.run == 'true'
//     run: …
// 비밀 값은 읽지 않고 있는지만 본다. 사건 파일(GITHUB_EVENT_PATH)에서 PR의 저장소 이름을 읽는다(식에 넣지 않는다, §4.5 '워크플로 명령 주입')
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PR_EVENTS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment']);

/** 돌릴지 정한다. 포크 PR이면 건너뛰고, 그 밖에서 비밀이 빠졌으면 던진다 */
export function decide({ eventName, event, env, needs }) {
  if (needs.length === 0) return { run: true, reason: 'no-secrets-needed' };
  const pr = PR_EVENTS.has(eventName) ? event?.pull_request : undefined;
  if (pr) {
    const head = pr.head?.repo?.full_name;
    const base = pr.base?.repo?.full_name;
    // 지워진 포크는 head.repo가 null이다
    if (!head || head !== base) return { run: false, reason: 'fork' };
  }
  const missing = needs.filter((n) => !env[n]);
  if (missing.length) throw new Error(`비밀이 없다: ${missing.join(', ')}(조직 안 PR·푸시에서는 환경 비밀이 있어야 한다)`);
  return { run: true, reason: 'secrets-present' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { job: { type: 'string', default: '' }, needs: { type: 'string', default: '' } } });
  const needs = values.needs.split(',').map((s) => s.trim()).filter(Boolean);
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  let d;
  try {
    d = decide({ eventName, event, env: process.env, needs });
  } catch (e) {
    console.log(`::error::${values.job}: ${e.message}`);
    process.exit(1);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${d.run}\n`);
  if (!d.run) {
    console.log(`::notice title=포크 PR 건너뜀::${values.job}는 비밀(${needs.join(', ')})이 필요해 포크 PR에서 건너뛰었다. 조직 안 PR과 develop에서 돈다`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ⏭️ 건너뜀(포크 PR, 비밀 없음): ${values.job} — ${needs.join(', ')}\n`);
  } else {
    console.log(`${values.job}: 돈다(${d.reason})`);
  }
}
