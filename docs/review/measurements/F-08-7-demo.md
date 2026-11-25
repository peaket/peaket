# F-08-7 데모 재현 측정(촬영 전 자리)

- **상태**: 2026-11-25에 촬영하지 않았다. 이 파일은 `node tools/local/demo.mjs play --scenarios S1,S7 --video --measure docs/review/measurements/F-08-7-demo.md`가 촬영 뒤 덮어쓸 자리다. 지금은 측정값이 없다.
- **왜 비었나**: 무대를 띄우지 않았고, 데모 S1이 알려진 잔여 문제(대기실 `GET /v1/events/{id}` 404, 월렛 QR 미확인)로 막혀 있다. 자세한 상태와 대본은 [F-08-7-demo-script.md](F-08-7-demo-script.md)에 있다.
- **통과로 세지 않는다**: 이 파일이 비어 있는 동안 A1~A4는 미통과·미확인이다. 촬영 뒤 `demo.mjs`가 쓴 결과(커밋·날짜·도구 판·콜드 스타트·시나리오별 결과)로 바꾼다.
