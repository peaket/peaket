// 이미지 빌드 잡 본체(tools/ci/image-build.mjs) 시험(docs/devops.md §3.1 build-image.yml ①, D-T32 ①, BUILD_ORDER BSL-050).
// Docker·BuildKit은 부르지 않는다: 인자 목록과 OCI 묶음(tar) 다이제스트 읽기만 본다. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './git-fixture.mjs';
import { BUILDER, BUILDKIT_IMAGE, PLATFORMS, loadBuildArgs, ociBuildArgs, ociManifestDigest, parseImageArgs, scmRunArgs, smokeRunArgs } from './image-build.mjs';

const VALID = ['--dockerfile', 'services/v0-monolith/Dockerfile', '--image', 'v0-monolith', '--platform', 'linux/arm64', '--out', 'out/images'];
const without = (flag) => {
  const i = VALID.indexOf(flag);
  return [...VALID.slice(0, i), ...VALID.slice(i + 2)];
};
const withValue = (flag, value) => VALID.map((v, i) => (VALID[i - 1] === flag ? value : v));
const after = (args, flag) => {
  const i = args.indexOf(flag);
  assert.ok(i >= 0, `${flag}가 없다: ${args.join(' ')}`);
  return args[i + 1];
};
/** 레지스트리에 올리거나 이 기계의 Docker에 싣는 인자가 없다 */
const noPush = (args) => {
  assert.equal(args.includes('--push'), false, '--push');
  assert.equal(args.some((a) => /type=registry|push=true/.test(a)), false, `레지스트리 출력: ${args.join(' ')}`);
};

test('DT32_빌더이미지는_다이제스트로고정하고_빌더이름과플랫폼둘을둔다', () => {
  assert.match(BUILDKIT_IMAGE, /^moby\/buildkit:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  assert.equal(BUILDER, 'peaket-oci');
  assert.deepEqual(Object.keys(PLATFORMS).sort(), ['linux/amd64', 'linux/arm64']);
  assert.deepEqual(PLATFORMS['linux/amd64'], { arch: 'amd64', nodeArch: 'x64' });
  assert.deepEqual(PLATFORMS['linux/arm64'], { arch: 'arm64', nodeArch: 'arm64' });
});

test('DT32_명령줄인자_Dockerfile·이미지·플랫폼·출력폴더를읽고_스모크는기본으로켠다', () => {
  assert.deepEqual(parseImageArgs(VALID), { dockerfile: 'services/v0-monolith/Dockerfile', image: 'v0-monolith', platform: 'linux/arm64', out: 'out/images', smoke: true });
  assert.equal(parseImageArgs([...VALID, '--no-smoke']).smoke, false);
  assert.equal(parseImageArgs(withValue('--platform', 'linux/amd64')).platform, 'linux/amd64');
  // 이미지 이름 경계: 소문자·숫자·.·_·- 64자까지
  for (const image of ['pg-simulator', 'example_svc.v2', 'a'.repeat(64), '0']) assert.equal(parseImageArgs(withValue('--image', image)).image, image);
});

test('DT32_명령줄인자_빠졌거나틀리면던진다', () => {
  assert.doesNotThrow(() => parseImageArgs(VALID));
  for (const flag of ['--dockerfile', '--image', '--platform', '--out']) assert.throws(() => parseImageArgs(without(flag)), undefined, `${flag} 없음`);
  for (const image of ['V0-Monolith', 'peaket/v0-monolith', 'ghcr.io/peaket/x', '', 'a'.repeat(65), 'v0 monolith', '../x', 'v0:tag', 'v0@sha256']) {
    assert.throws(() => parseImageArgs(withValue('--image', image)), undefined, `이미지 이름 ${JSON.stringify(image)}`);
  }
  for (const platform of ['linux/386', 'linux/arm/v7', 'windows/amd64', 'amd64', 'linux/amd64,linux/arm64', '']) {
    assert.throws(() => parseImageArgs(withValue('--platform', platform)), undefined, `플랫폼 ${platform}`);
  }
  // 모르는 인자(예: 올리기)는 받지 않는다
  assert.throws(() => parseImageArgs([...VALID, '--push']));
  assert.throws(() => parseImageArgs([...VALID, '--registry', 'ghcr.io']));
  assert.throws(() => parseImageArgs([...VALID, '--output', 'type=registry']));
  // 값 없이 끝난 인자
  assert.throws(() => parseImageArgs([...without('--out'), '--out']), undefined, '--out 값 없음');
  assert.throws(() => parseImageArgs([...without('--platform'), '--platform']), undefined, '--platform 값 없음');
});

test('DT32_OCI묶음빌드인자_고정빌더·플랫폼·Dockerfile·출처증명과SBOM끔·OCI파일로만내고_올리지도싣지도않는다', () => {
  for (const platform of ['linux/amd64', 'linux/arm64']) {
    const o = { dockerfile: 'services/v0-monolith/Dockerfile', image: 'v0-monolith', platform, ociFile: `out/v0-monolith-${PLATFORMS[platform].arch}.oci.tar`, metadataFile: 'out/metadata.json' };
    const a = ociBuildArgs(o);
    assert.ok(a.every((x) => typeof x === 'string'));
    assert.deepEqual(a.slice(0, 2), ['buildx', 'build']);
    assert.equal(after(a, '--builder'), 'peaket-oci');
    assert.equal(after(a, '--platform'), platform);
    assert.equal(after(a, '-f'), o.dockerfile);
    // 출처 증명과 SBOM은 게시 잡이 붙인다(빌드 잡에는 서명 신원이 없다)
    assert.ok(a.includes('--provenance=false'));
    assert.ok(a.includes('--sbom=false'));
    assert.equal(after(a, '--metadata-file'), o.metadataFile);
    assert.equal(after(a, '--output'), `type=oci,dest=${o.ociFile}`);
    // 출력은 OCI 파일 하나뿐이다(이미지 저장소·레지스트리로 가는 두 번째 출력이 없다)
    assert.equal(a.filter((x) => x === '--output' || x === '-o' || x.startsWith('--output=')).length, 1, a.join(' '));
    // 출처 증명·SBOM을 다른 모양(--attest, --provenance=mode=max 등)으로 다시 켜지 않는다
    assert.deepEqual(a.filter((x) => /^--(attest|provenance|sbom)(=|$)/.test(x)).sort(), ['--provenance=false', '--sbom=false']);
    // 빌드 맥락은 저장소 뿌리
    assert.equal(a.at(-1), '.');
    noPush(a);
    assert.equal(a.includes('--load'), false);
  }
});

test('DT32_스모크용싣기인자_같은빌더·플랫폼·Dockerfile로_이기계에만싣는다', () => {
  const o = { dockerfile: 'services/pg-simulator/Dockerfile', platform: 'linux/arm64', tag: 'peaket-smoke/pg-simulator:arm64' };
  const a = loadBuildArgs(o);
  assert.deepEqual(a.slice(0, 2), ['buildx', 'build']);
  assert.equal(after(a, '--builder'), 'peaket-oci');
  assert.equal(after(a, '--platform'), 'linux/arm64');
  assert.equal(after(a, '-f'), o.dockerfile);
  assert.ok(a.includes('--load'));
  assert.equal(after(a, '-t'), o.tag);
  assert.equal(a.at(-1), '.');
  noPush(a);
});

test('DT32_스모크실행인자_네트워크없이·스모크스크립트읽기전용·그이미지의node로그아키텍처를본다', () => {
  const script = '/home/runner/work/peaket/peaket/tools/ci/image-smoke.mjs';
  assert.deepEqual(smokeRunArgs({ tag: 'peaket-smoke/v0-monolith:arm64', platform: 'linux/arm64', smokeScript: script, nodeArch: 'arm64' }), [
    'run', '--rm', '--network', 'none', '--platform', 'linux/arm64', '-v', `${script}:/smoke.mjs:ro`, 'peaket-smoke/v0-monolith:arm64', 'node', '/smoke.mjs', 'arm64',
  ]);
  // 네이티브 모듈 열기는 이미지 사용자로(--user를 주지 않는다), 소스 관리 폴더 검사만 루트로 이미지 안 전체를 본다(ASVS 13.4.1, devops §4.4 '리뷰 뒤 더한 규칙' ⑦)
  assert.deepEqual(scmRunArgs({ tag: 'peaket-smoke/v0-monolith:arm64', platform: 'linux/arm64', smokeScript: script }), [
    'run', '--rm', '--network', 'none', '--platform', 'linux/arm64', '--user', '0:0', '-v', `${script}:/smoke.mjs:ro`, 'peaket-smoke/v0-monolith:arm64', 'node', '/smoke.mjs', '--scm', '/',
  ]);
  assert.equal(smokeRunArgs({ tag: 't:x64', platform: 'linux/amd64', smokeScript: script, nodeArch: 'x64' }).at(-1), 'x64');
});

// --- OCI 묶음(이미지 레이아웃을 담은 tar) ---

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const blob = (value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return { bytes, hex: sha256(bytes), size: bytes.length };
};
/** 플랫폼 이미지 하나: 설정·층(1MB 넘게 해 tar 블록 넘기기를 본다)·매니페스트 blob */
function image(seed) {
  const config = blob({ architecture: 'arm64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] }, seed });
  const layer = blob(randomBytes(1_100_000));
  const manifest = blob({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${config.hex}`, size: config.size },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${layer.hex}`, size: layer.size }],
  });
  const descriptor = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${manifest.hex}`, size: manifest.size, platform: { architecture: 'arm64', os: 'linux' } };
  return { config, layer, manifest, descriptor };
}
/**
 * OCI 이미지 레이아웃 폴더를 시스템 tar로 묶는다(oci-layout, index.json, blobs/sha256/<hex>).
 * blobs는 [hex, bytes] 목록이다(해시와 다른 내용을 넣어 볼 수 있게)
 */
function ociArchive(manifests, blobs) {
  const dir = tempDir('oci-');
  const root = join(dir, 'layout');
  mkdirSync(join(root, 'blobs', 'sha256'), { recursive: true });
  writeFileSync(join(root, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  writeFileSync(join(root, 'index.json'), JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests }));
  for (const [hex, bytes] of blobs) writeFileSync(join(root, 'blobs', 'sha256', hex), bytes);
  // 큰 blob 뒤에 index.json이 오게 묶는다. 드라이브 문자(C:)를 원격 주소로 읽는 tar가 있어 상대 경로만 준다
  const r = spawnSync('tar', ['-cf', '../image.oci.tar', 'blobs', 'index.json', 'oci-layout'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(join(dir, 'image.oci.tar'));
}
const blobsOf = (img) => [img.config, img.layer, img.manifest].map((b) => [b.hex, b.bytes]);

test('DT32_OCI묶음다이제스트_index.json이가리키는매니페스트하나의다이제스트를_blob해시로확인해돌려준다', () => {
  const img = image('a');
  const tar = ociArchive([img.descriptor], blobsOf(img));
  assert.equal(ociManifestDigest(tar), `sha256:${img.manifest.hex}`);
  // 이름 주석이 붙은 설명자도 같다(buildx의 OCI 출력)
  const named = ociArchive([{ ...img.descriptor, annotations: { 'org.opencontainers.image.ref.name': 'latest' } }], blobsOf(img));
  assert.equal(ociManifestDigest(named), `sha256:${img.manifest.hex}`);
});

test('DT32_OCI묶음다이제스트_매니페스트가하나가아니거나_blob이없거나_해시가다르면던진다', () => {
  const a = image('a');
  const b = image('b');
  assert.equal(ociManifestDigest(ociArchive([a.descriptor], blobsOf(a))), `sha256:${a.manifest.hex}`, '정상 묶음은 읽는다');
  assert.throws(() => ociManifestDigest(ociArchive([], blobsOf(a))), undefined, '매니페스트 0개');
  assert.throws(() => ociManifestDigest(ociArchive([a.descriptor, b.descriptor], [...blobsOf(a), ...blobsOf(b)])), undefined, '매니페스트 2개');
  assert.throws(() => ociManifestDigest(ociArchive([a.descriptor], [[a.config.hex, a.config.bytes], [a.layer.hex, a.layer.bytes]])), undefined, '매니페스트 blob 없음');
  assert.throws(() => ociManifestDigest(ociArchive([a.descriptor], [[a.config.hex, a.config.bytes], [a.layer.hex, a.layer.bytes], [a.manifest.hex, b.manifest.bytes]])), undefined, '매니페스트 blob 해시가 다름');
  assert.throws(() => ociManifestDigest(Buffer.alloc(1024)), undefined, 'index.json 없음');
});

test('DT32_OCI묶음다이제스트_가리키는것이이미지매니페스트가아니라_이미지인덱스면던진다', () => {
  // 출처 증명이 켜지면 buildx는 이미지와 증명 매니페스트를 묶은 인덱스를 낸다. 빌드 잡의 다이제스트는 플랫폼 이미지 매니페스트 하나여야 한다
  const a = image('a');
  assert.equal(ociManifestDigest(ociArchive([a.descriptor], blobsOf(a))), `sha256:${a.manifest.hex}`, '이미지 매니페스트를 가리키면 읽는다');
  const index = blob({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [a.descriptor] });
  const descriptor = { mediaType: 'application/vnd.oci.image.index.v1+json', digest: `sha256:${index.hex}`, size: index.size };
  assert.throws(() => ociManifestDigest(ociArchive([descriptor], [...blobsOf(a), [index.hex, index.bytes]])), undefined, '인덱스를 가리킨다');
});

// 재현 시험(2026-11-03, 새 맥락 코드 리뷰 낮음-5): 이름이 같은 빌더가 이미 있으면 그 빌더의 BuildKit 이미지를 보지 않고 다시 썼다
test('DT32_이미있는빌더는_고정한BuildKit이미지일때만_다시쓴다(재현)', async () => {
  const { builderUsesPinnedImage } = await import('./image-build.mjs');
  const pinned = `Name:          peaket-oci\nDriver:        docker-container\nDriver Options:  image="${BUILDKIT_IMAGE}"\nNodes:\nName:      peaket-oci0\nStatus:    running\n`;
  assert.equal(builderUsesPinnedImage(pinned), true);
  assert.equal(builderUsesPinnedImage(pinned.replace(BUILDKIT_IMAGE, 'moby/buildkit:buildx-stable-1')), false);
  assert.equal(builderUsesPinnedImage(pinned.replace(/Driver Options:.*\n/, '')), false);
  assert.equal(builderUsesPinnedImage(pinned.replace('docker-container', 'docker')), false);
});
