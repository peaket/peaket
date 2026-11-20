# deploy/envs/demo

아직 데모 승격 값이 없다. 첫 출시 후보를 GHCR에 게시한 뒤 `promote` 워크플로가 이 폴더에 `<서비스>.yaml`(`name`·`image.digest`·`env.PEAKET_ENV: demo`·`diagnose.bucket`)을 만든다.

- `gitops-check`는 값 파일이 없으면 `signature` 검사를 '아직 승격 없음'으로 건너뛰고 성공한다(조용한 통과가 아니라 까닭을 남긴다, D-T32 ③).
- 데모 오버레이는 `ghcr.io/peaket/`의 서명된 다이제스트를 끌어오기 비밀 없이 받는다(D-T33 ①·③, docs/devops.md §5.1).
- 데모 입장 정책은 감사(Audit) 모드다(`deploy/policies/kyverno/envs/demo`).
