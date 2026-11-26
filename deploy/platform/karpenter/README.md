# Karpenter NodePool 설정(F-09-10, OPS-430)

- **정본**: `docs/infra-handover.md` §3.1 노드 풀, `docs/devops.md` §8.2(중단 예산)·§8.3(drift 정비 시간), `docs/infra.md` §5.
- **이 폴더가 하는 것**: `nodepools.yaml`의 NodePool 넷(`hotpath`·`general`·`data`·`observability`). 구매 방식·아키텍처·인스턴스 계열·AZ·중단 예산을 정적으로 적는다.
- **이 폴더가 하지 않는 것**: AWS 계정 자원(서브넷·보안 그룹·IAM 역할·AMI)은 Terraform(BAT-076)이 만든다. 이 저장소에는 그 스택이 아직 없다. 실제 클러스터 설치·노드 기동·비용 측정도 이 동결 트랙에서 하지 않는다(미실행).

## EC2NodeClass 계약

NodePool은 모두 `karpenter.k8s.aws/v1` `EC2NodeClass` 이름 `default`를 가리킨다. Terraform(BAT-076)이 다음을 만든다는 계약이다.

- `spec.role`: Karpenter 노드 IAM 역할
- `spec.subnetSelectorTerms`·`spec.securityGroupSelectorTerms`: 클러스터 discovery 태그
- `spec.amiSelectorTerms`: Amazon Linux 2023 arm64 AMI

`default`가 없으면 NodePool은 있어도 Karpenter가 노드를 만들지 못한다. 그때 노드가 모자라면 파드가 `Pending`에 남는다. 실제 설치 전에 Terraform 출력으로 이름·태그를 맞춘다.

## 남은 위험

- **풀 분리**: NodePool만으로 워크로드가 풀별로 갈리지 않는다. 지금 워크로드는 `karpenter.sh/capacity-type: on-demand`만 선택한다. `peaket.io/pool` 선택자는 측정 뒤 후속이다.
- **Spot**: 이 기능은 전부 온디맨드다. 정본이 허용하는 notify 워커·원본 적재 작업자 Spot은 워크로드 toleration 배선이 없어 켜지 않았다.
- **한도**: `data`·`observability`의 `limits`는 기존 ResourceQuota의 125%다. ResourceQuota 숫자 자체가 [가정]이므로 한도도 [가정]이다. `hotpath`·`general`은 정본에 한도 숫자가 없어 `limits`를 두지 않았다.
- **중단 예산**: 모든 풀에 drift 사유 `nodes: "0"`, UTC `0 21 * * *`, `duration: 22h`를 건다. Karpenter 예산 크론은 UTC만 받는다.
