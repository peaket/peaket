#!/usr/bin/env node
// CODEOWNERS 검사(ADR-0165, ADR-0167, openspec 변경 add-repo-skeleton).
// - 규칙 줄마다 경로 하나와 주인 하나 이상이 있다
// - 주인은 모두 같은 조직의 팀(@<조직>/<팀>)이고, 팀은 teams.json 목록에 있다
// - 첫 규칙 줄은 기본값 `*`이다(GitHub는 맞는 줄 가운데 마지막 줄을 쓰므로 넓은 줄이 앞에 와야 한다)
// - 같은 경로가 두 번 나오지 않는다
// 쓰는 법: node tools/ci/check-codeowners.mjs [--codeowners .github/CODEOWNERS] [--teams infra/stacks/global/github/teams.json]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    codeowners: { type: 'string', default: '.github/CODEOWNERS' },
    teams: { type: 'string', default: 'infra/stacks/global/github/teams.json' },
  },
});

const errors = [];
const slugs = new Set(JSON.parse(readFileSync(values.teams, 'utf8')).teams.map((t) => t.slug));
const lines = readFileSync(values.codeowners, 'utf8').split(/\r?\n/);

const seen = new Map();
const orgs = new Set();
let rules = 0;
lines.forEach((raw, i) => {
  const line = raw.replace(/\s+#.*$/, '').trim();
  if (line === '' || line.startsWith('#')) return;
  const where = `${values.codeowners}:${i + 1}`;
  const [pattern, ...owners] = line.split(/\s+/);
  rules += 1;
  if (rules === 1 && pattern !== '*') errors.push(`${where}: 첫 규칙 줄은 기본값 '*'이어야 한다(지금 '${pattern}')`);
  if (seen.has(pattern)) errors.push(`${where}: 경로 '${pattern}'가 ${seen.get(pattern)}줄에도 있다`);
  seen.set(pattern, i + 1);
  if (owners.length === 0) errors.push(`${where}: '${pattern}'에 주인이 없다`);
  for (const owner of owners) {
    const m = /^@([A-Za-z0-9-]+)\/([a-z0-9-]+)$/.exec(owner);
    if (!m) {
      errors.push(`${where}: 주인 '${owner}'는 팀 표기(@<조직>/<팀>)가 아니다`);
      continue;
    }
    orgs.add(m[1]);
    if (!slugs.has(m[2])) errors.push(`${where}: 팀 '${m[2]}'가 ${values.teams}에 없다`);
  }
});

if (rules === 0) errors.push(`${values.codeowners}: 규칙 줄이 없다`);
if (orgs.size > 1) errors.push(`${values.codeowners}: 조직 이름이 여럿이다(${[...orgs].join(', ')})`);

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  console.error(`CODEOWNERS 검사 실패: ${errors.length}건`);
  process.exit(1);
}
console.log(`CODEOWNERS 검사 통과: 규칙 ${rules}줄, 팀 ${slugs.size}개, 조직 ${[...orgs].join(', ')}`);
