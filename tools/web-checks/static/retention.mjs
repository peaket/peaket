// 정적 자산 보존 규칙(docs/frontend.md §5.18, docs/devops.md §6.6, BUILD_ORDER HOT-390).
// 배포는 해시 이름 자산을 30일 또는 최근 5빌드 동안 남겨 옛 탭이 404를 보지 않게 한다.
// 이 파일은 배포 스크립트가 쓸 순수 계산만 둔다(실제 S3 수명 주기는 배포 단계 몫).

export const RETENTION_DAYS = 30;
export const RETENTION_BUILDS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const timeOf = (at) => {
  const t = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(String(at));
  if (!Number.isFinite(t)) throw new TypeError(`빌드 시각이 올바르지 않다: ${String(at)}`);
  return t;
};

const filesOf = (build) => {
  const files = Array.isArray(build.files) ? build.files : [];
  return files.map((f) => (typeof f === 'string' ? f : f?.path)).filter((p) => typeof p === 'string' && p.length > 0);
};

/**
 * 빌드 목록에서 남길 빌드·파일과 지울 파일을 고른다.
 * - 최근 5빌드이거나 지금에서 30일 안(경계 포함)인 빌드를 남긴다.
 * - 남긴 빌드 하나라도 쓰는 파일은 남긴다(해시 이름이 같으면 옛 탭도 그 파일을 쓴다).
 * @param {Array<{ id: string, at: string | number | Date, files?: Array<string | { path: string }> }>} builds
 * @param {number} now
 */
export function retentionPlan(builds, now = Date.now()) {
  if (!Array.isArray(builds)) throw new TypeError('빌드 목록이 배열이 아니다');
  const seen = new Set();
  const rows = builds.map((b) => {
    if (!b || typeof b.id !== 'string' || b.id.length === 0) throw new TypeError('빌드 ID가 없다');
    if (seen.has(b.id)) throw new TypeError(`빌드 ID가 겹친다: ${b.id}`);
    seen.add(b.id);
    return { id: b.id, at: timeOf(b.at), files: filesOf(b) };
  });
  const sorted = rows.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  const newest = new Set(sorted.slice(0, RETENTION_BUILDS).map((b) => b.id));
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  const keep = sorted.filter((b) => newest.has(b.id) || b.at >= cutoff);
  const keepIds = new Set(keep.map((b) => b.id));
  const drop = sorted.filter((b) => !keepIds.has(b.id));
  const keepFiles = [...new Set(keep.flatMap((b) => b.files))].sort();
  const keepFileSet = new Set(keepFiles);
  const deleteFiles = [...new Set(drop.flatMap((b) => b.files))].filter((p) => !keepFileSet.has(p)).sort();
  return {
    keepBuilds: keep.map((b) => b.id),
    deleteBuilds: drop.map((b) => b.id),
    keepFiles,
    deleteFiles,
  };
}
