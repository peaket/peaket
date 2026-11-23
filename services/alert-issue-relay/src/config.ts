// 티켓 중계 환경 값(기능 F-01-6, OPS-110; 계획 docs/review/plans/F-01-6.md §5 '환경 값').
// 모두 필수이고 하나라도 비면 시작하지 않는다(듣기 전에 던진다). 개인 키 파일은 읽어 PEM을 확인한다.
// - PEAKET_ALERT_RELAY_TOKEN: Alertmanager → 중계 웹훅 공유 토큰(빈 값 안 됨)
// - PEAKET_GITHUB_API_URL: GitHub REST 기본 주소(https://api.github.com 또는 시험의 가짜 주소)
// - PEAKET_GITHUB_APP_ID·PEAKET_GITHUB_INSTALLATION_ID: GitHub 앱과 설치 ID(JWT iss·설치 토큰 경로)
// - PEAKET_GITHUB_PRIVATE_KEY_FILE: GitHub 앱 개인 키(PEM) 파일 경로
// - PEAKET_GITHUB_REPOSITORY: 경보 티켓을 여는 저장소(owner/name)
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface AlertIssueRelayConfig {
  relayToken: string;
  githubApiUrl: string;
  appId: string;
  installationId: string;
  privateKey: KeyObject;
  owner: string;
  repository: string;
}

export class RelayConfigError extends Error {
  override name = 'RelayConfigError';
}

const REQUIRED = [
  'PEAKET_ALERT_RELAY_TOKEN',
  'PEAKET_GITHUB_API_URL',
  'PEAKET_GITHUB_APP_ID',
  'PEAKET_GITHUB_INSTALLATION_ID',
  'PEAKET_GITHUB_PRIVATE_KEY_FILE',
  'PEAKET_GITHUB_REPOSITORY',
] as const;

export function loadAlertIssueRelayConfig(env: Record<string, string | undefined>): AlertIssueRelayConfig {
  for (const name of REQUIRED) if (!env[name]) throw new RelayConfigError(`${name}이 없다(티켓 중계 환경 값, 비밀 관리에서 넣는다)`);
  const apiUrl = env.PEAKET_GITHUB_API_URL!;
  try {
    new URL(apiUrl);
  } catch {
    throw new RelayConfigError('PEAKET_GITHUB_API_URL이 URL이 아니다');
  }
  const repo = env.PEAKET_GITHUB_REPOSITORY!;
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (!m) throw new RelayConfigError('PEAKET_GITHUB_REPOSITORY는 owner/name 꼴이어야 한다');
  const keyFile = env.PEAKET_GITHUB_PRIVATE_KEY_FILE!;
  let pem: string;
  try {
    pem = readFileSync(keyFile, 'utf8');
  } catch {
    throw new RelayConfigError('PEAKET_GITHUB_PRIVATE_KEY_FILE을 읽지 못했다(GitHub 앱 개인 키 PEM)');
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new RelayConfigError('PEAKET_GITHUB_PRIVATE_KEY_FILE이 PEM 개인 키가 아니다');
  }
  return {
    relayToken: env.PEAKET_ALERT_RELAY_TOKEN!,
    githubApiUrl: apiUrl,
    appId: env.PEAKET_GITHUB_APP_ID!,
    installationId: env.PEAKET_GITHUB_INSTALLATION_ID!,
    privateKey,
    owner: m[1]!,
    repository: m[2]!,
  };
}
