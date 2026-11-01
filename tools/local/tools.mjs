#!/usr/bin/env node
// 로컬·CI 클러스터 도구를 고정 판으로 받는다(docs/infra.md §3, openspec 변경 add-local-cluster-and-relay-deployment).
// - 판과 SHA-256은 이 표에 고정한다. 받은 바이트의 해시가 다르면 쓰지 않고 실패한다(docs/devops.md §4.5 '서드파티 액션 탈취'와 같은 생각)
// - 받는 곳은 각 프로젝트의 공식 배포 주소(https)뿐이다. 받아 둔 파일은 쓸 때마다 해시를 다시 본다
// - 받은 도구는 저장소 안 .cache/peaket-tools(커밋하지 않는다)나 PEAKET_TOOLS_DIR에 둔다
// 쓰는 법: node tools/local/tools.mjs [kind|kubectl|helm ...]  → 받은 실행 파일 경로를 찍는다
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_ROOT = process.env.PEAKET_TOOLS_DIR || join(REPO, '.cache', 'peaket-tools');

const KIND = 'https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-';
const KUBECTL = 'https://dl.k8s.io/release/v1.35.8/bin/';
const HELM = 'https://get.helm.sh/helm-v3.22.1-';

// 해시: kind는 GitHub 릴리스 자산 다이제스트, kubectl은 dl.k8s.io의 .sha256, helm은 get.helm.sh의 .sha256sum(2026-11-01 받음).
// 압축으로 받는 helm은 푼 실행 파일의 해시(innerSha256)도 고정한다. 받아 둔 실행 파일은 이것과 견준다(옆 파일을 믿지 않는다, 코드 리뷰 2026-11-01)
export const TOOLS = {
  kind: {
    version: 'v0.33.0',
    bin: 'kind',
    assets: {
      'linux-x64': { url: `${KIND}linux-amd64`, sha256: 'aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d' },
      'linux-arm64': { url: `${KIND}linux-arm64`, sha256: '20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2' },
      'win32-x64': { url: `${KIND}windows-amd64`, sha256: '4b22adaa135368c5a465d56bbd8e520cbea87272a06ca00b6078e7b81515c9fc' },
      'darwin-x64': { url: `${KIND}darwin-amd64`, sha256: '5a99f26f57246dc9319dd294803313197a0f34d33c525b3ea8b655db5916ece0' },
      'darwin-arm64': { url: `${KIND}darwin-arm64`, sha256: '0c8c7dbe5e23594a198b786c4bc13dacc101fa6196b0cb0b23a1ca44e61f4b4f' },
    },
  },
  kubectl: {
    version: 'v1.35.8',
    bin: 'kubectl',
    assets: {
      'linux-x64': { url: `${KUBECTL}linux/amd64/kubectl`, sha256: '874d5e72dbb819f43cff16bcd1e4f8bac5b7f2361fe1e55049b0a6c676fb0cbf' },
      'linux-arm64': { url: `${KUBECTL}linux/arm64/kubectl`, sha256: 'cc749967b62f4422260bc9c0aa7a7c55f45175ae38cb8d95767b5d2b7e04c1fd' },
      'win32-x64': { url: `${KUBECTL}windows/amd64/kubectl.exe`, sha256: 'f675d70224b42b84e0442e8d7644efbe440e4451a4b02bdc5d95823a96316ba8' },
      'darwin-x64': { url: `${KUBECTL}darwin/amd64/kubectl`, sha256: '35c964c16432ea65eda6600d6ff4fea040d5eafcb6ad410297ba67d49b618148' },
      'darwin-arm64': { url: `${KUBECTL}darwin/arm64/kubectl`, sha256: 'b8be50ae0c6665b646fb009f904a52cad30806deee19ab3b4fe5af2d68bd82eb' },
    },
  },
  helm: {
    version: 'v3.22.1',
    bin: 'helm',
    assets: {
      'linux-x64': { url: `${HELM}linux-amd64.tar.gz`, archive: 'tar.gz', inner: 'linux-amd64/helm', sha256: '896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea', innerSha256: '46aeab5e043f62d01f7c168823b392cabc1cea3807b67906296290483791be43' },
      'linux-arm64': { url: `${HELM}linux-arm64.tar.gz`, archive: 'tar.gz', inner: 'linux-arm64/helm', sha256: '4c29e286b279d170fa048ddfc3e4e83dcd069ca9c52102766ba672d7149e694d', innerSha256: '2bd1b649ef89175bc0ae1e0fa7de7e0583a5b0401de9896b644b8acbcae1ba64' },
      'win32-x64': { url: `${HELM}windows-amd64.zip`, archive: 'zip', inner: 'windows-amd64/helm.exe', sha256: '32ce9f4509b81782c9740898c43946e1f97c4d93ec5d10222c9b6eeec21ea043', innerSha256: '2e514121444e19b90c79bd7b0067cc0a97cfa45c34b885b604c1403ac9825c72' },
      'darwin-x64': { url: `${HELM}darwin-amd64.tar.gz`, archive: 'tar.gz', inner: 'darwin-amd64/helm', sha256: 'cf850a81b908f8eef0331e6b18776da2767bcac639ca84472311dad20008495c', innerSha256: '4c5c990c6cab11ecb184922a9337f0df1543c60f52e99c37342896643ef253aa' },
      'darwin-arm64': { url: `${HELM}darwin-arm64.tar.gz`, archive: 'tar.gz', inner: 'darwin-arm64/helm', sha256: 'e73da8a0b0d5193774fdff17ce6319c7436bb22ee229b45fd64f3c40368c753a', innerSha256: 'b9fa0498b0eef0a2ff912c98fd6bbaba1b9e2c7a6e42063e406f1e4676272db9' },
    },
  },
};

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** 이 플랫폼에서 받을 자산. 표에 없으면 던진다 */
export function pickAsset(name, platform = process.platform, arch = process.arch, tools = TOOLS) {
  const t = tools[name];
  if (!t) throw new Error(`모르는 도구: ${name}`);
  const a = t.assets[`${platform}-${arch}`];
  if (!a) throw new Error(`지원하지 않는 플랫폼: ${name} ${platform}-${arch}`);
  return a;
}

async function httpsDownload(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`받기 실패: ${url} HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * 도구 실행 파일 경로를 돌려준다. 없거나 해시가 다르면 받는다.
 * 압축 파일은 압축 파일의 해시를 본 뒤 풀고, 푼 실행 파일도 표의 해시(innerSha256)와 견준다.
 */
export async function ensureTool(name, o = {}) {
  const { root = DEFAULT_ROOT, tools = TOOLS, platform = process.platform, arch = process.arch, download = httpsDownload } = o;
  const t = tools[name];
  const a = pickAsset(name, platform, arch, tools);
  if (!a.url.startsWith('https://')) throw new Error(`https 주소만 받는다: ${a.url}`);
  const dir = join(root, `${name}-${t.version}`);
  const exe = join(dir, platform === 'win32' ? `${t.bin}.exe` : t.bin);
  // 받아 둔 실행 파일은 표에 고정한 해시와 견준다(압축은 푼 실행 파일의 해시)
  const want = a.archive ? a.innerSha256 : a.sha256;
  if (a.archive && !/^[0-9a-f]{64}$/.test(want ?? '')) throw new Error(`압축 도구에 푼 실행 파일 해시(innerSha256)가 없다: ${name}`);
  if (existsSync(exe) && sha256(readFileSync(exe)) === want) return exe;
  const bytes = await download(a.url);
  if (sha256(bytes) !== a.sha256) throw new Error(`해시가 맞지 않는다: ${a.url}`);
  mkdirSync(dir, { recursive: true });
  let body = bytes;
  if (a.archive) {
    const work = mkdtempSync(join(dir, 'unpack-'));
    try {
      const file = join(work, `a.${a.archive}`);
      writeFileSync(file, bytes);
      // Windows 10 이후의 시스템 tar(bsdtar)는 zip도 푼다. PATH 앞의 Git Bash tar(GNU)는 zip을 못 풀어 시스템 것을 콕 집는다.
      // 리눅스·맥은 tar.gz만 쓴다
      const tar = platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      execFileSync(tar, a.archive === 'zip' ? ['-xf', file, '-C', work] : ['-xzf', file, '-C', work], { stdio: 'ignore' });
      body = readFileSync(join(work, a.inner));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    if (sha256(body) !== want) throw new Error(`푼 실행 파일 해시가 맞지 않는다: ${a.url} ${a.inner}`);
  }
  const tmp = `${exe}.part`;
  writeFileSync(tmp, body);
  if (platform !== 'win32') chmodSync(tmp, 0o755);
  renameSync(tmp, exe);
  return exe;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TOOLS);
  for (const n of names) console.log(`${n} ${await ensureTool(n)}`);
}
