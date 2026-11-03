#!/usr/bin/env node
// 야간 축소 성능 비교의 준비 명령(docs/devops.md §3.3 '축소 성능 시험의 판정', D-T40). 저장소 뿌리에서 nightly.py가 부른다.
//   node loadtest/nightly/prepare.mjs [--aa] [--new-patch <패치 파일>]
// - kind 클러스터를 올리고(node tools/local/cluster.mjs up --v0-only, 이미 있으면 그대로) 새 판(지금 작업 트리)을 네임스페이스 v0에 올린다(cluster.mjs v0).
// - 기준판: 가장 최근 출시 태그(v<숫자>…)의 커밋을 따로 빌드해 v0-base에 올린다(DB v0_base, Valkey DB 1, tools/local/cluster.mjs deployV0Base).
//   출시 태그가 아직 없거나 --aa면 새 판과 같은 이미지를 올린다(A/A: 같은 판끼리 번갈아 재는 잡음 폭 측정, D-T40 ①).
// - --new-patch(D-T40 ②, 시험용): 지금 커밋에 그 패치를 얹은 이미지를 새 판으로 바꿔 올린다(예: loadtest/nightly/test/delay-30ms.patch).
// - 마지막 줄에 {"base_url": …, "new_url": …}(두 판 입구의 클러스터 안 주소)를 낸다. 실행 명령(k6-run.mjs)이 그 주소로 판을 고른다
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { V0_BASE_NAMESPACE, V0_IMAGES, V0_NAMESPACE, deployV0Base, loadImage, redeployV0App, v0Layout } from '../../tools/local/cluster.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 출시 태그 꼴(docs/devops.md §2, v<주>.<부>.<수>) */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
// 진행 글은 표준 오류로 낸다. 표준 출력의 마지막 줄은 nightly.py가 읽는 JSON이다
const say = (m) => process.stderr.write(`${m}\n`);
const node = (args) => execFileSync(process.execPath, args, { cwd: REPO, stdio: ['ignore', process.stderr, process.stderr] });

function parse(argv) {
  const o = { aa: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--aa') o.aa = true;
    else if (argv[i] === '--new-patch' && argv[i + 1] && !argv[i + 1].startsWith('--')) o.patch = resolve(REPO, argv[++i]);
    else throw new Error(`모르는 인자: ${argv[i]}`);
  }
  if (o.aa && o.patch) throw new Error('--aa와 --new-patch는 함께 쓰지 않는다');
  return o;
}

/** 가장 최근 출시 태그(없으면 null) */
function latestReleaseTag() {
  let tags = '';
  try {
    tags = execFileSync('git', ['-C', REPO, 'tag', '--list', 'v*', '--sort=-v:refname', '--merged', 'HEAD'], { encoding: 'utf8' });
  } catch {
    return null;
  }
  return tags.split(/\r?\n/).find((t) => RELEASE_TAG.test(t.trim()))?.trim() ?? null;
}

/** 커밋 하나(와 패치)를 임시 작업 폴더로 꺼내 v0 앱 이미지를 만든다 */
function buildAt(ref, image, patch) {
  const dir = mkdtempSync(join(tmpdir(), 'nightly-src-'));
  const wt = join(dir, 'src');
  try {
    execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', wt, ref], { stdio: ['ignore', process.stderr, process.stderr] });
    if (patch) execFileSync('git', ['-C', wt, 'apply', '--whitespace=nowarn', patch], { stdio: ['ignore', process.stderr, process.stderr] });
    execFileSync('docker', ['build', '-f', join(wt, 'services', 'v0-monolith', 'Dockerfile'), '-t', image, wt], { stdio: ['ignore', process.stderr, process.stderr] });
  } finally {
    try {
      execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    } catch {
      // 지우지 못하면 아래에서 폴더를 지우고 worktree 목록을 정리한다
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    try {
      execFileSync('git', ['-C', REPO, 'worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      // 다음 실행이 다시 정리한다
    }
  }
}

async function main() {
  const o = parse(process.argv.slice(2));
  say('== 클러스터와 새 판(v0, 지금 작업 트리)');
  // v0가 쓰는 것만 올린다(Kafka·AWS 흉내 서버 없이). CPU 4개 러너에 시스템 파드·두 판·발생기(CPU 1개)를 함께 놓는다(2026-11-03 러너 A/A 실행에서 발생기가 자리를 잡지 못했다)
  node(['tools/local/cluster.mjs', 'up', '--v0-only']);
  node(['tools/local/cluster.mjs', 'v0']);
  if (o.patch) {
    say(`== 새 판에 패치를 얹는다(${o.patch})`);
    const img = 'peaket/v0-monolith:new-patched';
    buildAt('HEAD', img, o.patch);
    await loadImage(img);
    await redeployV0App(img);
  }
  const tag = o.aa ? null : latestReleaseTag();
  let baseImage = V0_IMAGES.app;
  if (tag) {
    say(`== 기준판: 출시 태그 ${tag}`);
    baseImage = 'peaket/v0-monolith:base';
    buildAt(tag, baseImage);
    await loadImage(baseImage);
  } else {
    say(o.aa ? '== 기준판: 새 판과 같은 이미지(A/A, --aa)' : '== 기준판: 출시 태그가 아직 없어 새 판과 같은 이미지(이 밤은 A/A 실행이다)');
  }
  await deployV0Base(baseImage);
  process.stdout.write(`${JSON.stringify({ base_url: v0Layout(V0_BASE_NAMESPACE).gatewayUrl, new_url: v0Layout(V0_NAMESPACE).gatewayUrl })}\n`);
}

main().catch((e) => {
  say(`loadtest/nightly/prepare.mjs: ${e.message}`);
  process.exit(1);
});
