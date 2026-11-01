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
