// 배포 식별자(docs/frontend.md §2.5, docs/devops.md §6.6, BUILD_ORDER HOT-390).
// 출시 후보 커밋 SHA를 Next.js deploymentId로 쓴다. 값이 없으면 Next.js가 배포 식별자를 넣지 않는다.
// 화면과 서버의 배포 식별자가 다르면 Next.js가 새로고침해 옛 자산·새 자산이 섞이지 않게 한다.
export function deploymentIdOf(env = process.env) {
  const explicit = typeof env.PEAKET_DEPLOYMENT_ID === 'string' ? env.PEAKET_DEPLOYMENT_ID.trim() : '';
  if (explicit) return explicit;
  const sha = typeof env.GITHUB_SHA === 'string' ? env.GITHUB_SHA.trim() : '';
  return sha || undefined;
}
