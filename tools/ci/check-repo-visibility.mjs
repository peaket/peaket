#!/usr/bin/env node
// 봇 저장소 비공개 검사(docs/devops.md §4.4 '리뷰 뒤 더한 규칙' ②, ADR-0263 결정 13, POL-026, ADR-0169). security-scan.yml iac-config가 부른다.
// 공개 모노레포(peaket)의 Trivy 결과 GIT-0001은 '받아들인 결과'로 두지만, 봇 시뮬레이터를 담는 peaket-bots는 공개하면 안 된다(POL-026).
// 그래서 infra/stacks/global/github/repositories.tf에서 peaket-bots 칸의 visibility가 글자 그대로 "private"인지 본다. 공개거나(public·internal),
// 변수로 적었거나, 칸·저장소·파일이 없으면 판정하지 못해 실패한다(닫힘 실패).
// 쓰는 법: node tools/ci/check-repo-visibility.mjs [--file <repositories.tf>]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runIfMain } from './entry.mjs';

const DEFAULT = fileURLToPath(new URL('../../infra/stacks/global/github/repositories.tf', import.meta.url));
/** 비공개여야 하는 저장소 */
export const PRIVATE_REPOSITORIES = Object.freeze(['peaket-bots']);

/**
 * 저장소 맵(locals의 "<이름>" = { … })에서 그 저장소 칸의 visibility 글자. 칸이 없거나 글자가 아니면 null
 * @param {string} text
 * @param {string} name
 */
export function repositoryVisibility(text, name) {
  const head = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*=\\s*\\{`).exec(text);
  if (!head) return null;
  let depth = 0;
  let end = -1;
  for (let i = head.index + head[0].length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const m = /^\s*visibility\s*=\s*"([a-z]+)"\s*(#.*)?$/m.exec(text.slice(head.index, end));
  return m ? m[1] : null;
}

/**
 * 저장소 리소스(resource "github_repository" …)마다 visibility가 맵 값을 그대로 쓰는가(visibility = each.value.visibility). 아니면 그 리소스 이름
 * @returns {string[]} 틀린 리소스
 */
export function resourceVisibilityProblems(text) {
  const out = [];
  const heads = [...text.matchAll(/resource\s+"github_repository"\s+"([\w-]+)"\s*\{/g)];
  if (heads.length === 0) return ['github_repository 리소스가 없다'];
  for (const h of heads) {
    let depth = 0;
    let end = -1;
    for (let i = h.index + h[0].length - 1; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const block = end < 0 ? '' : text.slice(h.index, end);
    const lines = [...block.matchAll(/^\s*visibility\s*=\s*(.+?)\s*(#.*)?$/gm)].map((m) => m[1]);
    if (lines.length !== 1 || lines[0] !== 'each.value.visibility') out.push(`리소스 github_repository.${h[1]}의 visibility는 맵 값 each.value.visibility를 그대로 쓴다: ${lines.length ? lines.join(', ') : '(없음)'}`);
  }
  return out;
}

function main(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: { file: { type: 'string', default: DEFAULT } } });
  let text;
  try {
    text = readFileSync(resolve(values.file), 'utf8');
  } catch (e) {
    console.log(`실패: 저장소 정의를 읽지 못했다(${values.file}): ${e.code ?? e.message}`);
    return 1;
  }
  let failed = 0;
  for (const name of PRIVATE_REPOSITORIES) {
    const v = repositoryVisibility(text, name);
    if (v === 'private') continue;
    failed++;
    console.log(`실패: 저장소 ${name}는 비공개(visibility = "private")여야 한다(POL-026): ${v === null ? '칸을 찾지 못했거나 글자로 적지 않았다' : `지금 ${v}`} (${values.file})`);
  }
  for (const p of resourceVisibilityProblems(text)) {
    failed++;
    console.log(`실패: ${p} (조건식·다른 값이면 맵의 private이 리소스에 닿지 않는다, POL-026) (${values.file})`);
  }
  if (!failed) console.log(`통과: 비공개여야 하는 저장소 ${PRIVATE_REPOSITORIES.join('·')}가 비공개다(저장소 리소스가 맵 값을 그대로 쓴다)`);
  return failed ? 1 : 0;
}

// 직접 실행 판별이 틀리면 통과가 아니라 실패로 끝낸다(ADR-0263 결정 13 ⑦)
await runIfMain(import.meta.url, () => main(process.argv.slice(2)));
