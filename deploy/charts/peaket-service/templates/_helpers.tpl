{{/* 이름·이미지·공통 라벨 */}}
{{- define "peaket.name" -}}
{{- required "name(서비스 이름)이 필요하다" .Values.name -}}
{{- end -}}

{{- define "peaket.image" -}}
{{- $repo := required "image.repository가 필요하다" .Values.image.repository -}}
{{- if .Values.image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" .Values.image.digest) -}}{{- fail "image.digest는 sha256:<64자리 16진수>여야 한다" -}}{{- end -}}
{{ $repo }}@{{ .Values.image.digest }}
{{- else -}}
{{- $env := required "env.PEAKET_ENV가 필요하다" .Values.env.PEAKET_ENV -}}
{{- if not (has $env (list "local" "ci")) -}}{{- fail "image.tag는 PEAKET_ENV local·ci에서만 쓴다. 다른 환경은 image.digest로 고정한다" -}}{{- end -}}
{{ $repo }}:{{ required "image.digest나 image.tag가 필요하다" .Values.image.tag }}
{{- end -}}
{{- end -}}

{{- define "peaket.labels" -}}
app.kubernetes.io/name: {{ include "peaket.name" . }}
app.kubernetes.io/part-of: peaket
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* 서비스 파드 템플릿(Deployment와 Rollout이 함께 쓴다). 파드 라벨·어노테이션·계정·종료 유예·컨테이너(프로브·진단·볼륨)를 담는다.
    우선순위 클래스는 값이 있을 때만 넣는다(빈 값이면 칸을 만들지 않는다, docs/devops.md §5.2) */}}
{{- define "peaket.servicePodTemplate" -}}
{{- $name := include "peaket.name" . }}
{{- $leases := include "peaket.leaderLeases" . | fromJsonArray }}
{{- /* 법정 seq 단일 writer(IR-13): 자동 확장·카나리·영속 볼륨 없이는 한 파드만 쥐게 할 수 없다 */}}
{{- if and .Values.service.legalAccessSeq.enabled .Values.service.autoscaling.enabled }}{{ fail "service.legalAccessSeq.enabled이면 service.autoscaling.enabled를 켤 수 없다(법정 seq 단일 writer, IR-13)" }}{{ end }}
{{- if and .Values.service.legalAccessSeq.enabled .Values.service.rollout.enabled }}{{ fail "service.legalAccessSeq.enabled이면 service.rollout.enabled를 켤 수 없다(법정 seq 단일 writer, IR-13)" }}{{ end }}
{{- if and .Values.service.legalAccessSeq.enabled (not .Values.service.persistence.enabled) }}{{ fail "service.legalAccessSeq.enabled이면 service.persistence.enabled가 필요하다(ReadWriteOnce PVC, IR-13)" }}{{ end }}
metadata:
  labels:
    {{- include "peaket.labels" . | nindent 4 }}
    app.kubernetes.io/component: service
  # 로컬 관측 최소의 Prometheus가 관리 포트 /metrics를 긁는다(docs/observability.md §3 '로컬 관측 최소와 템플릿 대시보드').
  # 운영은 PodMonitor로 수집하므로(ADR-0076) 이 주석은 쓰지 않을 뿐 해가 없다
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "{{ .Values.managementPort }}"
    prometheus.io/path: /metrics
spec:
  serviceAccountName: {{ $name }}
  {{- /* 리더를 뽑는 파드만 Lease API를 부르므로 토큰을 붙인다(BUILD_ORDER PRF-202) */}}
  automountServiceAccountToken: {{ if $leases }}true{{ else }}false{{ end }}
  {{- with .Values.service.priorityClassName }}
  priorityClassName: {{ . | quote }}
  {{- end }}
  {{- with .Values.service.nodeSelector }}
  nodeSelector: {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.service.tolerations }}
  tolerations: {{- toYaml . | nindent 4 }}
  {{- end }}
  terminationGracePeriodSeconds: {{ .Values.service.terminationGracePeriodSeconds }}
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: app
      image: {{ include "peaket.image" . }}
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      command: {{- toYaml .Values.service.command | nindent 8 }}
      ports:
        {{- /* 스트림 작업자는 앱 포트가 없다: 관리 포트(지표·상태) 하나뿐이다(docs/streaming.md §2.3, worker.enabled) */}}
        {{- if not .Values.worker.enabled }}
        - { name: http, containerPort: {{ .Values.service.port }} }
        {{- end }}
        - { name: management, containerPort: {{ .Values.managementPort }} }
        {{- range .Values.service.extraPorts }}
        - { name: {{ .name }}, containerPort: {{ int .port }} }
        {{- end }}
      env:
        {{- include "peaket.commonEnv" . | nindent 8 }}
        {{- if not .Values.worker.enabled }}
        - name: PORT
          value: {{ .Values.service.port | quote }}
        {{- end }}
        {{- range $k, $v := .Values.service.env }}
        {{- if ne $k "NODE_OPTIONS" }}
        - name: {{ $k }}
          value: {{ $v | quote }}
        {{- end }}
        {{- end }}
        {{- include "peaket.diagnoseEnv" (dict "root" $ "resources" .Values.service.resources "extra" .Values.service.env.NODE_OPTIONS "containerEnv" .Values.service.env "where" "service") | nindent 8 }}
      {{- if .Values.secretEnvFrom }}
      envFrom:
        - secretRef: { name: {{ .Values.secretEnvFrom }} }
      {{- end }}
      {{- if .Values.probes.enabled }}
      {{- include "peaket.probes" . | nindent 6 }}
      {{- end }}
      lifecycle:
        preStop:
          sleep: { seconds: {{ .Values.service.preStopSleepSeconds }} }
      resources: {{- toYaml .Values.service.resources | nindent 8 }}
      securityContext: {{- include "peaket.containerSecurity" . | nindent 8 }}
      volumeMounts:
        - { name: tmp, mountPath: /tmp }
        {{- include "peaket.diagnoseMounts" . | nindent 8 }}
        {{- include "peaket.schemaIdsMount" . | nindent 8 }}
        {{- with .Values.service.volumeMounts }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
  volumes:
    - { name: tmp, emptyDir: { sizeLimit: 64Mi } }
    {{- include "peaket.diagnoseVolumes" (dict "resources" .Values.service.resources "where" "service") | nindent 4 }}
    {{- include "peaket.schemaIdsVolume" . | nindent 4 }}
    {{- with .Values.service.volumes }}
    {{- include "peaket.volumes" (dict "volumes" . "env" $.Values.env.PEAKET_ENV "where" "service.volumes") | nindent 4 }}
    {{- end }}
{{- end -}}

{{/* 두 Deployment가 함께 받는 환경 변수. PEAKET_POD는 파드 이름(Lease 보유자·소비자 그룹 이름, R-224·R-225) */}}
{{- define "peaket.commonEnv" -}}
- name: PEAKET_POD
  valueFrom: { fieldRef: { fieldPath: metadata.name } }
- name: POD_NAMESPACE
  valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
- name: OTEL_SERVICE_NAME
  value: {{ include "peaket.name" . | quote }}
- name: PEAKET_MANAGEMENT_PORT
  value: {{ .Values.managementPort | quote }}
{{- if .Values.schemaIds.enabled }}
- name: PEAKET_SCHEMA_IDS_FILE
  value: "/etc/peaket/schema-ids/schema-ids.json"
{{- end }}
{{- range $k, $v := .Values.env }}
{{- if ne $k "NODE_OPTIONS" }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/* 메모리 한도 글(512Mi·1Gi)을 Mi 정수로. 진단 수집의 V8 힙 상한·/diag 크기가 쓴다. 다른 꼴은 렌더를 멈춘다 */}}
{{- define "peaket.memoryMi" -}}
{{- $raw := toString (required (printf "%s.resources.limits.memory가 필요하다(V8 힙 상한·/diag 크기, ADR-0070)" .where) .limit) -}}
{{- if regexMatch "^[1-9][0-9]*Mi$" $raw -}}
{{- trimSuffix "Mi" $raw | atoi -}}
{{- else if regexMatch "^[1-9][0-9]*Gi$" $raw -}}
{{- mul (trimSuffix "Gi" $raw | atoi) 1024 -}}
{{- else -}}
{{- fail (printf "%s.resources.limits.memory는 <정수>Mi나 <정수>Gi로 적는다(%s)" .where $raw) -}}
{{- end -}}
{{- end -}}

{{/* 진단 수집(RB-31, ADR-0070 결정 1, docs/devops.md D-T18 ①)의 환경 변수. 서비스·릴레이 컨테이너가 받는다.
    NODE_OPTIONS: SIGUSR1 인스펙터 끄기, 치명 오류 보고서를 /diag에(환경 변수·네트워크 칸 없음), V8 힙 상한은 메모리 한도의 heapPercent(기본 75%) [가정].
    값으로 받은 NODE_OPTIONS(env·서비스/릴레이 env)는 안전 옵션 앞에 둔다(같은 옵션은 뒤의 것이 이긴다). 안전 옵션을 끄는 값(--no-…·--inspect…)은 렌더를 멈춘다(ADR-0303 결정 3, 리뷰 SEC-02).
    Node는 옵션 이름의 '_'를 '-'로 읽으므로 밑줄 꼴(--inspect_brk·--no_report_exclude_env 등)도 같이 막는다(보안 다시 보기 SR-01).
    local·ci 밖(staging·prod·demo)은 증거 버킷 diagnose.bucket이 있어야 하고, 흉내 S3 주소 diagnose.s3Endpoint는 local·ci에서만 받는다(리뷰 SEC-06·SEC-01).
    local·ci 밖에서는 SDK가 읽는 주소 바꾸기 값(AWS_ENDPOINT_URL·AWS_ENDPOINT_URL_<서비스>)과 공유 설정 파일(AWS_CONFIG_FILE)을 env·컨테이너 env에 두지 못한다(SR-02).
    주석은 Downward API 파일로, 메모리 한도는 resourceFieldRef로 받는다.
    인자: dict "root" 차트 "resources" 컨테이너 자원 "extra" 덧붙일 NODE_OPTIONS "containerEnv" 컨테이너 env "where" 값 이름 */}}
{{- define "peaket.diagnoseEnv" -}}
{{- $root := .root -}}
{{- $limitMi := include "peaket.memoryMi" (dict "limit" (dig "limits" "memory" "" .resources) "where" .where) | atoi -}}
{{- $percent := int $root.Values.diagnose.heapPercent -}}
{{- if or (lt $percent 10) (gt $percent 90) -}}{{- fail "diagnose.heapPercent는 10~90이다" -}}{{- end -}}
{{- $heapMi := div (mul $limitMi $percent) 100 -}}
{{- $env := toString ($root.Values.env.PEAKET_ENV | default "") -}}
{{- $testEnv := has $env (list "local" "ci") -}}
{{- if not $testEnv -}}
{{- $_ := required (printf "diagnose.bucket(진단 증거 버킷)이 필요하다(PEAKET_ENV %s, local·ci 밖은 버킷이 없으면 서비스가 시작하지 않는다, RB-31)" $env) $root.Values.diagnose.bucket -}}
{{- if $root.Values.diagnose.s3Endpoint -}}{{- fail (printf "diagnose.s3Endpoint(흉내 S3 주소)는 PEAKET_ENV local·ci에서만 쓴다(%s, 증거는 전용 버킷으로만 보낸다)" $env) -}}{{- end -}}
{{- range $source, $vars := dict "env" ($root.Values.env | default dict) (printf "%s.env" $.where) ($.containerEnv | default dict) -}}
{{- range $k, $v := $vars -}}
{{- if or (hasPrefix "AWS_ENDPOINT_URL" $k) (eq $k "AWS_CONFIG_FILE") -}}
{{- fail (printf "%s.%s는 PEAKET_ENV local·ci에서만 쓴다(%s, AWS 요청 주소를 바꾼다. 증거·키 요청은 정한 주소로만 보낸다)" $source $k $env) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $opts := list -}}
{{- with $root.Values.env.NODE_OPTIONS }}{{ $opts = append $opts (toString .) }}{{ end -}}
{{- with .extra }}{{ $opts = append $opts (toString .) }}{{ end -}}
{{- range $opts -}}
{{- if regexMatch "(^|\\s)--(no-disable-sigusr1|no-report-exclude-env|no-report-exclude-network|no-report-on-fatalerror|inspect)(=|-|\\s|$)" (replace "_" "-" .) -}}
{{- fail (printf "%s.env·env의 NODE_OPTIONS에 진단 안전 옵션을 끄는 값이 있다(%s, --no-disable-sigusr1·--no-report-*·--inspect…는 받지 않는다)" $.where .) -}}
{{- end -}}
{{- end -}}
{{- $opts = concat $opts (list "--disable-sigusr1" "--report-on-fatalerror" "--report-exclude-env" "--report-exclude-network" "--report-directory=/diag" (printf "--max-old-space-size=%d" $heapMi)) -}}
- name: NODE_OPTIONS
  value: {{ join " " $opts | quote }}
- name: PEAKET_DIAG_ANNOTATIONS_FILE
  value: /etc/podinfo/annotations
- name: PEAKET_DIAG_DIR
  value: /diag
- name: PEAKET_MEMORY_LIMIT_BYTES
  valueFrom: { resourceFieldRef: { resource: limits.memory, divisor: "1" } }
{{- with $root.Values.diagnose.bucket }}
- name: PEAKET_DIAG_BUCKET
  value: {{ . | quote }}
{{- end }}
{{- with $root.Values.diagnose.s3Endpoint }}
- name: PEAKET_DIAG_S3_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- end -}}

{{/* 진단 수집의 볼륨: /diag(보고서·힙 스냅샷·처리 표시, 크기 한도는 메모리 한도의 두 배 [가정])와 주석 Downward API 파일. 인자: dict "resources" "where" */}}
{{- define "peaket.diagnoseVolumes" -}}
{{- $limitMi := include "peaket.memoryMi" (dict "limit" (dig "limits" "memory" "" .resources) "where" .where) | atoi -}}
- { name: diag, emptyDir: { sizeLimit: {{ printf "%dMi" (mul $limitMi 2) }} } }
- name: podinfo
  downwardAPI:
    items:
      - { path: annotations, fieldRef: { fieldPath: metadata.annotations } }
{{- end -}}

{{/* 진단 수집 볼륨을 붙일 자리 */}}
{{- define "peaket.diagnoseMounts" -}}
- { name: diag, mountPath: /diag }
- { name: podinfo, mountPath: /etc/podinfo, readOnly: true }
{{- end -}}

{{/* 제한 파드 보안 기준(Restricted)에 맞춘 컨테이너 보안 설정 */}}
{{- define "peaket.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities: { drop: ["ALL"] }
seccompProfile: { type: RuntimeDefault }
{{- end -}}

{{/* 나가는 연결 안쪽 대상의 대역 하나를 검사한다. 전체·너무 넓은 대역과 링크 로컬(메타데이터 169.254.169.254로 가는 길)은 렌더를 멈춘다(docs/infra.md §9, 추천 적용 2026-11-09, BUILD_ORDER PRF-192, 코드 리뷰).
    넓이의 하한은 사설 대역 가운데 가장 넓은 값(IPv4 /8, IPv6 /7)이다. /8보다 넓은 IPv4는 여기서 멈추므로, 링크 로컬을 품는 대역은 첫 칸 169인 /8~/15까지만 더 보면 된다 */}}
{{- define "peaket.egressCidrCheck" -}}
{{- $cidr := toString . -}}
{{- if not (regexMatch "^[0-9a-fA-F:.]+/[0-9]+$" $cidr) -}}{{- fail (printf "service.networkPolicy.egress.internal.cidrs: 주소/길이로 적는다(%s)" $cidr) -}}{{- end -}}
{{- $bits := splitList "/" $cidr | last | atoi -}}
{{- if contains ":" $cidr -}}
{{- if lt $bits 7 -}}{{- fail (printf "service.networkPolicy.egress.internal.cidrs: 전체 대역이나 사설 대역보다 넓은 값은 받지 않는다(%s)" $cidr) -}}{{- end -}}
{{- if regexMatch "(?i)^(fe|(0*:)+ffff:)" $cidr -}}{{- fail (printf "service.networkPolicy.egress.internal.cidrs: IPv6 링크 로컬과 IPv4 사상 주소는 받지 않는다(%s)" $cidr) -}}{{- end -}}
{{- else -}}
{{- if lt $bits 8 -}}{{- fail (printf "service.networkPolicy.egress.internal.cidrs: 전체 대역이나 사설 대역보다 넓은 값은 받지 않는다(%s)" $cidr) -}}{{- end -}}
{{- if or (regexMatch "^0*169\\.0*254\\." $cidr) (and (regexMatch "^0*169\\." $cidr) (lt $bits 16)) -}}{{- fail (printf "service.networkPolicy.egress.internal.cidrs: 링크 로컬(169.254.0.0/16)에 겹친다. 꼭 필요한 호스트는 allowLinkLocalCidrs에 /32로 적는다(%s)" $cidr) -}}{{- end -}}
{{- end -}}
{{- end -}}

{{/* 링크 로컬을 일부러 여는 칸(EKS Pod Identity 에이전트 169.254.170.23 같은 값). 호스트 하나씩만 받고 메타데이터 주소는 받지 않는다 */}}
{{- define "peaket.egressLinkLocalCheck" -}}
{{- $cidr := toString . -}}
{{- if not (regexMatch "^169\\.254\\.[0-9]{1,3}\\.[0-9]{1,3}/32$" $cidr) -}}{{- fail (printf "service.networkPolicy.egress.internal.allowLinkLocalCidrs: 169.254.0.0/16 안의 호스트를 /32로 적는다(%s)" $cidr) -}}{{- end -}}
{{- if eq $cidr "169.254.169.254/32" -}}{{- fail "service.networkPolicy.egress.internal.allowLinkLocalCidrs: 메타데이터 주소 169.254.169.254는 열지 않는다" -}}{{- end -}}
{{- end -}}

{{/* 나가는 쪽 허용 규칙(docs/infra.md §9, BUILD_ORDER PRF-192). 인자는 service.networkPolicy.egress이고, 서비스 파드와 릴레이 파드가 같은 규칙을 받는다 */}}
{{- define "peaket.egressRules" -}}
# 이름 풀이는 클러스터 DNS만
- to:
    - namespaceSelector:
        matchLabels: { kubernetes.io/metadata.name: kube-system }
      podSelector:
        matchLabels: { k8s-app: kube-dns }
  ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
{{- range .internal }}
{{- /* 표준 NetworkPolicy는 to나 ports를 비우면 모두 허용이다. 그래서 빈 칸은 렌더를 멈춘다 */}}
{{- if not .ports }}{{ fail "service.networkPolicy.egress.internal: 칸마다 ports가 있어야 한다(비면 모든 포트가 열린다)" }}{{ end }}
{{- if not (or .cidrs .allowLinkLocalCidrs .namespaces .podLabels) }}{{ fail "service.networkPolicy.egress.internal: 칸마다 cidrs나 allowLinkLocalCidrs, namespaces·podLabels가 있어야 한다(비면 모든 대상이 열린다)" }}{{ end }}
{{- if and .cidrs (or .namespaces .podLabels) }}{{ fail "service.networkPolicy.egress.internal: cidrs와 namespaces·podLabels는 한 칸에 함께 쓰지 않는다" }}{{ end }}
{{- if and .allowLinkLocalCidrs (or .cidrs .namespaces .podLabels) }}{{ fail "service.networkPolicy.egress.internal: allowLinkLocalCidrs는 다른 대상과 한 칸에 함께 쓰지 않는다" }}{{ end }}
{{- range .cidrs }}{{ include "peaket.egressCidrCheck" . }}{{ end }}
{{- range .allowLinkLocalCidrs }}{{ include "peaket.egressLinkLocalCheck" . }}{{ end }}
{{- $blocks := concat (.cidrs | default list) (.allowLinkLocalCidrs | default list) }}
- to:
    {{- if $blocks }}
    {{- range $blocks }}
    - ipBlock: { cidr: {{ . | quote }} }
    {{- end }}
    {{- else }}
    {{- $peer := dict }}
    {{- if .namespaces }}{{ $_ := set $peer "namespaceSelector" (dict "matchExpressions" (list (dict "key" "kubernetes.io/metadata.name" "operator" "In" "values" .namespaces))) }}{{ end }}
    {{- if .podLabels }}{{ $_ := set $peer "podSelector" (dict "matchLabels" .podLabels) }}{{ end }}
    - {{ toYaml $peer | nindent 6 | trim }}
    {{- end }}
  ports:
    {{- range .ports }}
    - { protocol: TCP, port: {{ int . }} }
    {{- end }}
{{- end }}
{{- if .publicHttps }}
# 공인 주소의 443만(docs/infra.md §9 대역 정책). 사설·루프백·링크 로컬(메타데이터 169.254.169.254 포함)·CGNAT·멀티캐스트·예약 대역은 뺀다.
# 이름(FQDN)으로는 좁히지 못한다. 호스트 고정은 앱 설정이 하고 이름 단위 장치는 wbs 0.4.2에서 정한다
- to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          - 0.0.0.0/8
          - 10.0.0.0/8
          - 100.64.0.0/10
          - 127.0.0.0/8
          - 169.254.0.0/16
          - 172.16.0.0/12
          - 192.0.0.0/24
          - 192.0.2.0/24
          - 192.168.0.0/16
          - 198.18.0.0/15
          - 198.51.100.0/24
          - 203.0.113.0/24
          - 224.0.0.0/4
          - 240.0.0.0/4
    - ipBlock:
        cidr: "::/0"
        except:
          {{- /* IPv4 사상 대역(::ffff:0:0/96)은 넣지 못한다. API 서버가 ::/0의 부분 대역으로 보지 않아 정책 전체를 거절한다(서버 드라이런 2026-11-09). 그 주소는 IPv4로 나가 위 IPv4 규칙을 받는다.
                 6to4(2002::/16)·Teredo(2001::/32)·NAT64(64:ff9b::/96, 지역 64:ff9b:1::/48)는 주소 안에 IPv4가 실려 사설 IPv4로 가는 길이 될 수 있어 뺀다(추천 적용 2026-11-09, BUILD_ORDER PRF-192, 코드 리뷰) */}}
          - "::1/128"
          - "64:ff9b::/96"
          - "64:ff9b:1::/48"
          - "100::/64"
          - "2001::/32"
          - "2001:db8::/32"
          - "2002::/16"
          - "fc00::/7"
          - "fe80::/10"
          - "ff00::/8"
  ports:
    - { protocol: TCP, port: 443 }
{{- end }}
{{- end -}}

{{/* 관리 포트 프로브(docs/architecture.md §5 '프로브 규칙'): 준비는 /ready(의존성을 부르지 않는다) 5초·3초·6번 [가정](약 30초, 이벤트 루프 지연에 함께 빠지지 않게, D-T19),
    생존은 /livez 10초·5초·6번, 시작은 /livez 2초·30번. 준비 값은 BUILD_ORDER BAS-080에서 2초·2번을 고쳤다 */}}
{{- define "peaket.probes" -}}
readinessProbe:
  httpGet: { path: /ready, port: management }
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 6
livenessProbe:
  httpGet: { path: /livez, port: management }
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 6
startupProbe:
  httpGet: { path: /livez, port: management }
  periodSeconds: 2
  failureThreshold: 30
{{- end -}}

{{/* 서비스 파드가 잡는 리더 임대 이름 목록(BUILD_ORDER PRF-202, 목록은 PRF-215). service.leaderLease는 이름 하나(글)나 이름 목록을 받는다.
    빈 글·빈 목록이면 빈 목록이다. 이름은 DNS-1123 이름이고 겹치면 렌더를 멈춘다(합본 파드는 admission-ctrl·payment-entry-pause 둘을 잡는다, docs/verification.md §3.8 '합본의 v1 무대') */}}
{{- define "peaket.leaderLeases" -}}
{{- $raw := .Values.service.leaderLease -}}
{{- $names := list -}}
{{- if kindIs "string" $raw -}}
{{- if ne $raw "" -}}{{- $names = list $raw -}}{{- end -}}
{{- else if kindIs "slice" $raw -}}
{{- $names = $raw -}}
{{- else if $raw -}}
{{- fail "service.leaderLease는 이름 하나(글)나 이름 목록이다" -}}
{{- end -}}
{{- $seen := dict -}}
{{- range $names -}}
{{- if not (kindIs "string" .) -}}{{- fail "service.leaderLease의 이름은 글이다" -}}{{- end -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" .) -}}{{- fail (printf "service.leaderLease의 이름은 DNS-1123 이름이다(%s)" .) -}}{{- end -}}
{{- if hasKey $seen . -}}{{- fail (printf "service.leaderLease에 같은 이름이 두 번 있다(%s)" .) -}}{{- end -}}
{{- $_ := set $seen . true -}}
{{- end -}}
{{- toJson $names -}}
{{- end -}}

{{/* 값으로 받는 볼륨(service.volumes·outboxRelay.volumes, BUILD_ORDER PRF-215 코드 리뷰 S1). 칸마다 name과 종류 하나이고, 종류는 secret·configMap·emptyDir만 받는다.
    hostPath(노드 폴더)는 PEAKET_ENV local·ci에서만 받는다(합본 v1 무대의 좌석맵·묶음 결과 폴더). projected(서비스 계정 토큰을 붙일 수 있다)·PVC 등 그밖의 종류는 렌더를 멈춘다(ASVS v5.0.0-13.2.2).
    인자: dict "volumes" 목록 "env" PEAKET_ENV "where" 값 이름 */}}
{{- define "peaket.volumes" -}}
{{- $env := .env | default "" | toString -}}
{{- $where := .where -}}
{{- range .volumes -}}
{{- if not (kindIs "map" .) -}}{{- fail (printf "%s: 칸마다 name과 종류 하나를 적는다" $where) -}}{{- end -}}
{{- if not .name -}}{{- fail (printf "%s: 칸마다 name이 있어야 한다" $where) -}}{{- end -}}
{{- $kinds := keys (omit . "name") | sortAlpha -}}
{{- if ne (len $kinds) 1 -}}{{- fail (printf "%s: 볼륨 %v는 종류 하나만 적는다(%s)" $where .name (join "·" $kinds)) -}}{{- end -}}
{{- $kind := first $kinds -}}
{{- if eq $kind "hostPath" -}}
{{- if not (has $env (list "local" "ci")) -}}{{- fail (printf "%s: hostPath 볼륨 %v는 PEAKET_ENV local·ci에서만 쓴다(%s)" $where .name $env) -}}{{- end -}}
{{- else if not (has $kind (list "secret" "configMap" "emptyDir" "persistentVolumeClaim")) -}}
{{- fail (printf "%s: 볼륨 %v의 종류 %s는 받지 않는다(secret·configMap·emptyDir·persistentVolumeClaim, local·ci의 hostPath만)" $where .name $kind) -}}
{{- end -}}
{{- end -}}
{{- toYaml .volumes -}}
{{- end -}}

{{/* 스트림 작업자 모드(worker.enabled)가 받지 않는 값이면 렌더를 멈춘다(docs/streaming.md §2.2·§2.3, ASVS v5.0.0-13.4.5).
    앱 포트에 기대는 값(extraPorts·appFromPodLabels), 쿠버네티스 API 권한(leaderLease, 서비스 계정 토큰을 붙이게 된다), 자동 확장·카나리(복제 수 고정·롤링) */}}
{{- define "peaket.workerChecks" -}}
{{- if .Values.worker.enabled -}}
{{- if .Values.service.extraPorts -}}{{- fail "worker.enabled이면 service.extraPorts를 받지 않는다(작업자 컨테이너 포트는 관리 포트 하나다, docs/streaming.md §2.3)" -}}{{- end -}}
{{- if .Values.service.networkPolicy.appFromPodLabels -}}{{- fail "worker.enabled이면 service.networkPolicy.appFromPodLabels를 받지 않는다(앱 포트가 없고 들어오는 연결은 관측 네임스페이스 → 관리 포트뿐이다, docs/streaming.md §2.3)" -}}{{- end -}}
{{- if include "peaket.leaderLeases" . | fromJsonArray -}}{{- fail "worker.enabled이면 service.leaderLease를 받지 않는다(작업자에는 쿠버네티스 API 권한을 주지 않는다, docs/streaming.md §2.3)" -}}{{- end -}}
{{- if or .Values.service.autoscaling.enabled .Values.service.keda.enabled .Values.service.rollout.enabled -}}{{- fail "worker.enabled이면 service.autoscaling·keda·rollout을 켜지 않는다(복제 수를 고정하고 롤링으로 올린다, docs/streaming.md §2.2)" -}}{{- end -}}
{{- end -}}
{{- end -}}

{{/* 서비스 파드의 앱 포트 밖 포트(service.extraPorts, BUILD_ORDER PRF-215: 합본은 서비스마다 앱 포트가 다르다). 칸마다 name(소문자·숫자·-, 15자 안)·port(1~65535)이고
    앱 포트·관리 포트나 서로와 겹치면 렌더를 멈춘다 */}}
{{- define "peaket.extraPorts" -}}
{{- $used := dict (toString .Values.service.port) "service.port" (toString .Values.managementPort) "managementPort" -}}
{{- $names := dict "http" true "management" true -}}
{{- range .Values.service.extraPorts -}}
{{- if not (regexMatch "^[a-z]([-a-z0-9]{0,13}[a-z0-9])?$" (toString .name)) -}}{{- fail (printf "service.extraPorts의 name은 소문자·숫자·-로 15자 안이다(%v)" .name) -}}{{- end -}}
{{- $port := int .port -}}
{{- if or (lt $port 1) (gt $port 65535) -}}{{- fail (printf "service.extraPorts의 port는 1~65535다(%v)" .port) -}}{{- end -}}
{{- if hasKey $used (toString $port) -}}{{- fail (printf "service.extraPorts의 port %d가 %s와 겹친다" $port (get $used (toString $port))) -}}{{- end -}}
{{- if hasKey $names (toString .name) -}}{{- fail (printf "service.extraPorts의 name %s가 겹친다" .name) -}}{{- end -}}
{{- $_ := set $used (toString $port) (toString .name) -}}
{{- $_ := set $names (toString .name) true -}}
{{- end -}}
{{- end -}}

{{/* 생산자 스키마 ID 설정(ADR-0357 결정 4): schemaIds.enabled면 등록 Job이 쓴 ConfigMap schema-ids(키 schema-ids.json)를 /etc/peaket/schema-ids/에 읽기 전용으로 붙인다.
    환경 값 PEAKET_SCHEMA_IDS_FILE은 peaket.commonEnv가 준다. 앱·Outbox 릴레이 컨테이너가 함께 쓴다 */}}
{{- define "peaket.schemaIdsMount" -}}
{{- if .Values.schemaIds.enabled }}
- { name: schema-ids, mountPath: /etc/peaket/schema-ids, readOnly: true }
{{- end }}
{{- end -}}

{{- define "peaket.schemaIdsVolume" -}}
{{- if .Values.schemaIds.enabled }}
- name: schema-ids
  configMap: { name: {{ required "schemaIds.configMapName이 필요하다" .Values.schemaIds.configMapName }}, items: [{ key: schema-ids.json, path: schema-ids.json }] }
{{- end }}
{{- end -}}
