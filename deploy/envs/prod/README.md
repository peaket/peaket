# deploy/envs/prod

아직 운영 승격 값이 없다. `main`에 출시 태그가 붙은 뒤 릴리스 봇이 여는 운영 승격 PR이 `<서비스>.yaml`을 채운다(docs/devops.md §5.3).

- 운영 입장 정책은 거부(Deny) 모드이고, 허용 레지스트리는 PEAKET ECR(`<ECR_ACCOUNT>.dkr.ecr.ap-northeast-2.amazonaws.com/`)뿐이다(D-T33 ②).
- `gitops-check`는 `image.digest`가 없는 값(태그만 있는 값)을 실패로 본다. 폴더가 비었으면 '아직 승격 없음' 한 줄로 건너뛰고 성공한다(D-T32 ③, GV-04).
- 운영 오버레이의 메시 필수(D-T28)는 `deploy/platform/mesh`의 앰비언트 라벨·STRICT PeerAuthentication으로 본다.
