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
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
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

{{/* 관리 포트 프로브(docs/architecture.md §5 '프로브 규칙'): 준비는 /ready(의존성을 부르지 않는다), 생존은 /livez 10초·5초·6번 */}}
{{- define "peaket.probes" -}}
readinessProbe:
  httpGet: { path: /ready, port: management }
  periodSeconds: 5
  timeoutSeconds: 2
  failureThreshold: 2
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
{{- else if not (has $kind (list "secret" "configMap" "emptyDir")) -}}
{{- fail (printf "%s: 볼륨 %v의 종류 %s는 받지 않는다(secret·configMap·emptyDir, local·ci의 hostPath만)" $where .name $kind) -}}
{{- end -}}
{{- end -}}
{{- toYaml .volumes -}}
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
