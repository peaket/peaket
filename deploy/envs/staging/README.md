# deploy/envs/staging

아직 스테이징 승격 값이 없다. 측정 캠페인에서 고정한 다이제스트 묶음을 이 폴더에 적는 단계가 생기면 채운다(docs/devops.md §5.1).

- 스테이징 입장 정책은 거부(Deny) 모드이고, 허용 레지스트리는 PEAKET ECR(`<ECR_ACCOUNT>.dkr.ecr.ap-northeast-2.amazonaws.com/`)뿐이다(D-T33 ②).
- `gitops-check`는 값 파일이 없으면 `signature` 검사를 '아직 승격 없음'으로 건너뛰고 성공한다(까닭을 남긴다).
