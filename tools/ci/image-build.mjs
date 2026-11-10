#!/usr/bin/env node
// 이미지 빌드 잡의 본체(docs/devops.md §3.1 build-image.yml ①, BUILD_ORDER BSL-050).
// 플랫폼 하나를 BuildKit(docker-container 빌더, 이미지 다이제스트 고정)으로 빌드해 OCI 묶음과 다이제스트를 만들고,
// 같은 이미지를 이 기계에 실어 네트워크 없이 스모크한다(tools/ci/image-smoke.mjs). 레지스트리에 올리지 않는다(게시는 wbs 0.1.5).
// 쓰는 법: node tools/ci/image-build.mjs --dockerfile <경로> --image <이름> --platform linux/amd64|linux/arm64 --out <폴더> [--no-smoke]
//   결과: <폴더>/<이름>-<arch>.oci.tar, <폴더>/<이름>-<arch>.digest(sha256:… 한 줄)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** 빌더(BuildKit) 이미지. 다이제스트로 고정한다(moby/buildkit v0.34.1 여러 플랫폼 목록, 2026-11-03 확인) */
export const BUILDKIT_IMAGE = 'moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c';
/** 이 스크립트가 만들고 쓰는 빌더 이름 */
export const BUILDER = 'peaket-oci';
/** 받는 플랫폼과 그 Node 아키텍처 이름(process.arch) */
export const PLATFORMS = { 'linux/amd64': { arch: 'amd64', nodeArch: 'x64' }, 'linux/arm64': { arch: 'arm64', nodeArch: 'arm64' } };

const IMAGE_NAME = /^[a-z0-9._-]{1,64}$/;

/**
 * 명령줄 인자. 빠졌거나 틀리면 던진다(이미지 이름은 소문자·숫자·.·_·- 1~64자, 플랫폼은 PLATFORMS 가운데 하나)
 * @param {string[]} argv
 * @returns {{ dockerfile: string, image: string, platform: keyof typeof PLATFORMS, out: string, smoke: boolean }}
 */
export function parseImageArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      dockerfile: { type: 'string' },
      image: { type: 'string' },
      platform: { type: 'string' },
      out: { type: 'string' },
      'no-smoke': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 0) throw new Error(`모르는 인자: ${positionals.join(' ')}`);
  for (const k of /** @type {const} */ (['dockerfile', 'image', 'platform', 'out'])) {
    if (!values[k]) throw new Error(`--${k}가 필요하다`);
  }
  const image = /** @type {string} */ (values.image);
  const platform = /** @type {string} */ (values.platform);
  if (!IMAGE_NAME.test(image)) throw new Error(`이미지 이름이 틀렸다(소문자·숫자·.·_·- 1~64자): ${image}`);
  if (!Object.hasOwn(PLATFORMS, platform)) throw new Error(`플랫폼은 ${Object.keys(PLATFORMS).join('·')} 가운데 하나다: ${platform}`);
  return {
    dockerfile: /** @type {string} */ (values.dockerfile),
    image,
    platform: /** @type {keyof typeof PLATFORMS} */ (platform),
    out: /** @type {string} */ (values.out),
    smoke: !values['no-smoke'],
  };
}

/**
 * OCI 묶음을 만드는 docker buildx build 인자(빌드 맥락은 저장소 뿌리 '.')
 * @param {{ dockerfile: string, image: string, platform: string, ociFile: string, metadataFile: string }} o
 * @returns {string[]}
 */
export function ociBuildArgs(o) {
  return [
    'buildx',
    'build',
    '--builder',
    BUILDER,
    '--platform',
    o.platform,
    '-f',
    o.dockerfile,
    // 출처 증명·SBOM은 게시 잡이 붙인다(빌드 잡은 그 권한이 없다, docs/devops.md §4.2)
    '--provenance=false',
    '--sbom=false',
    '--metadata-file',
    o.metadataFile,
    '--output',
    `type=oci,dest=${o.ociFile}`,
    '.',
  ];
}

/**
 * 스모크용으로 같은 빌드를 이 기계의 Docker에 싣는 인자(캐시로 다시 만든다)
 * @param {{ dockerfile: string, platform: string, tag: string }} o
 * @returns {string[]}
 */
export function loadBuildArgs(o) {
  return ['buildx', 'build', '--builder', BUILDER, '--platform', o.platform, '-f', o.dockerfile, '--provenance=false', '--sbom=false', '--load', '-t', o.tag, '.'];
}

/**
 * 스모크 실행 인자: 네트워크 없이, 스모크 스크립트를 읽기 전용으로 붙여 그 이미지의 node로 돌린다. 네이티브 모듈 열기는 앱이 도는 이미지 사용자로 본다
 * @param {{ tag: string, platform: string, smokeScript: string, nodeArch: string }} o
 * @returns {string[]}
 */
export function smokeRunArgs(o) {
  return ['run', '--rm', '--network', 'none', '--platform', o.platform, '-v', `${o.smokeScript}:/smoke.mjs:ro`, o.tag, 'node', '/smoke.mjs', o.nodeArch];
}

/**
 * 이미지 안 소스 관리 메타데이터 검사 인자(ASVS 13.4.1, ADR-0263 결정 9·13 ⑦): 이미지 사용자가 못 읽는 폴더(/root 등)도 보도록 이 검사만 루트로 띄운다
 * @param {{ tag: string, platform: string, smokeScript: string }} o
 * @returns {string[]}
 */
export function scmRunArgs(o) {
  return ['run', '--rm', '--network', 'none', '--platform', o.platform, '--user', '0:0', '-v', `${o.smokeScript}:/smoke.mjs:ro`, o.tag, 'node', '/smoke.mjs', '--scm', '/'];
}

/**
 * tar(ustar) 묶음의 일반 파일들. 앞의 './'는 뗀다
 * @param {Buffer} bytes
 * @returns {Map<string, Buffer>}
 */
function tarFiles(bytes) {
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  const text = (/** @type {number} */ start, /** @type {number} */ len) => {
    const raw = bytes.subarray(start, start + len);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? len : end).toString('utf8');
  };
  /** @type {string | undefined} */
  let longName;
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    let name = text(offset, 100);
    const magic = text(offset + 257, 6);
    if (magic.startsWith('ustar')) {
      const prefix = text(offset + 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('OCI 묶음의 tar 머리가 깨졌다');
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const data = bytes.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error('OCI 묶음이 중간에 끊겼다');
    if (type === 'L') longName = data.toString('utf8').replace(/\0+$/, '');
    else if (type === 'x') {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (path) longName = path[1];
    } else if (type === '0' || type === '\0') {
      files.set((longName ?? name).replace(/^\.\//, ''), data);
      longName = undefined;
    } else longName = undefined;
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * OCI 묶음(tar)의 index.json이 가리키는 이미지 매니페스트 하나의 다이제스트. 매니페스트가 하나가 아니거나,
 * 그 blob이 묶음에 없거나 SHA-256이 다이제스트와 다르면 던진다
 * @param {Buffer} tarBytes
 * @returns {string}
 */
export function ociManifestDigest(tarBytes) {
  const files = tarFiles(tarBytes);
  const indexBytes = files.get('index.json');
  if (!indexBytes) throw new Error('OCI 묶음에 index.json이 없다');
  /** @type {{ manifests?: Array<{ digest?: unknown, mediaType?: unknown }> }} */
  let index;
  try {
    index = JSON.parse(indexBytes.toString('utf8'));
  } catch {
    throw new Error('OCI 묶음의 index.json이 JSON이 아니다');
  }
  const manifests = Array.isArray(index.manifests) ? index.manifests : [];
  if (manifests.length !== 1) throw new Error(`OCI 묶음의 매니페스트가 하나가 아니다(${manifests.length}개)`);
  const mediaType = manifests[0]?.mediaType;
  // 출처 증명·SBOM을 켜면 묶음이 이미지 인덱스를 가리킨다. 빌드 잡은 플랫폼 이미지 하나만 낸다(인덱스는 게시 잡이 만든다)
  if (mediaType === 'application/vnd.oci.image.index.v1+json' || mediaType === 'application/vnd.docker.distribution.manifest.list.v2+json') {
    throw new Error('OCI 묶음이 이미지 인덱스를 가리킨다(빌드 잡은 플랫폼 이미지 하나만 낸다)');
  }
  const digest = manifests[0]?.digest;
  const m = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(digest) : null;
  if (!m) throw new Error('OCI 묶음의 매니페스트 다이제스트가 sha256:<64자리>가 아니다');
  const blob = files.get(`blobs/sha256/${m[1]}`);
  if (!blob) throw new Error('OCI 묶음에 매니페스트 blob이 없다');
  if (createHash('sha256').update(blob).digest('hex') !== m[1]) throw new Error('OCI 묶음의 매니페스트 blob이 다이제스트와 다르다');
  return `sha256:${m[1]}`;
}

const docker = (/** @type {string[]} */ args, /** @type {'inherit' | 'pipe'} */ stdio = 'inherit') =>
  execFileSync('docker', args, { stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });

/**
 * 이미 있는 빌더가 이 스크립트가 고정한 BuildKit 이미지의 docker-container 빌더인가(docker buildx inspect 출력)
 * @param {string} inspectText
 */
export function builderUsesPinnedImage(inspectText) {
  const driver = /^Driver:\s*(\S+)/m.exec(inspectText)?.[1];
  const images = [...inspectText.matchAll(/^Driver Options:.*\bimage="([^"]+)"/gm)].map((m) => m[1]);
  return driver === 'docker-container' && images.length > 0 && images.every((i) => i === BUILDKIT_IMAGE);
}

function ensureBuilder() {
  let inspect;
  try {
    inspect = docker(['buildx', 'inspect', BUILDER], 'pipe');
  } catch {
    inspect = undefined;
  }
  // 이름이 같아도 고정한 BuildKit 이미지가 아니면(오래된 빌더) 지우고 다시 만든다(2026-11-03 코드 리뷰)
  if (inspect !== undefined && builderUsesPinnedImage(inspect)) return;
  if (inspect !== undefined) docker(['buildx', 'rm', BUILDER]);
  docker(['buildx', 'create', '--name', BUILDER, '--driver', 'docker-container', '--driver-opt', `image=${BUILDKIT_IMAGE}`]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseImageArgs(process.argv.slice(2));
  const { arch, nodeArch } = PLATFORMS[o.platform];
  mkdirSync(o.out, { recursive: true });
  const ociFile = join(o.out, `${o.image}-${arch}.oci.tar`);
  const metadataFile = join(o.out, `${o.image}-${arch}.metadata.json`);
  ensureBuilder();
  docker(ociBuildArgs({ dockerfile: o.dockerfile, image: o.image, platform: o.platform, ociFile, metadataFile }));
  const digest = ociManifestDigest(readFileSync(ociFile));
  const meta = JSON.parse(readFileSync(metadataFile, 'utf8'));
  if (meta['containerimage.digest'] && meta['containerimage.digest'] !== digest) {
    throw new Error(`빌더가 알린 다이제스트(${meta['containerimage.digest']})와 OCI 묶음의 다이제스트(${digest})가 다르다`);
  }
  writeFileSync(join(o.out, `${o.image}-${arch}.digest`), `${digest}\n`);
  console.log(`이미지 ${o.image} ${o.platform}: ${digest}`);
  if (o.smoke) {
    const tag = `peaket-smoke/${o.image}:${arch}`;
    docker(loadBuildArgs({ dockerfile: o.dockerfile, platform: o.platform, tag }));
    const smokeScript = resolve(dirname(fileURLToPath(import.meta.url)), 'image-smoke.mjs');
    docker(smokeRunArgs({ tag, platform: o.platform, smokeScript, nodeArch }));
    docker(scmRunArgs({ tag, platform: o.platform, smokeScript }));
  }
}
