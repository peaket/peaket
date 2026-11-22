// 월렛 입장용 기기 키·회전 QR·IndexedDB 저장(SCR-013, FR-012, POL-018, ADR-0025·0051, offline-gate §2·§3).
export { generateDeviceKey, importPublicKeyJwk, keyIdOfPublicKey, publicKeyJwkOf, signQrV1, verifyQrV1, type DeviceKey } from './device-key';
export { createQrFrame, msUntilNextQrFrame, qrClockText, qrFrameIndex, qrFrameStale, qrTimeSeconds, QR_FRAME_SECONDS, type QrFrame, type QrSigner } from './frame';
export { qrMatrix, type QrErrorCorrection } from './qr-matrix';
export {
  base45Decode,
  base45Encode,
  bytesToBase64Url,
  bytesToUuidV7,
  base64UrlToBytes,
  concatBytes,
  decodeQrV1,
  encodeQrV1,
  keyIdFromBase64Url,
  keyIdToBase64Url,
  qrV1Message,
  uint32BE,
  uint32FromBE,
  uuidV7ToBytes,
  QR_V1_BASE45_LENGTH,
  QR_V1_BYTES,
  QR_V1_HEADER,
  QR_V1_KEY_ID_BYTES,
  QR_V1_SIGNATURE_BYTES,
  QR_V1_TIME_BYTES,
  QR_V1_VERSION,
  type QrV1Fields,
  type QrV1Payload,
} from './qr-v1';
export {
  contractPublicKeyJwk,
  deviceKeyRegistrationAvailable,
  registerDeviceKey,
  walletScreenStateOf,
  type DeviceKeyRegistrationResult,
  type DeviceKeyRetryReason,
  type RegisterDeviceKeyInput,
  type WalletScreenState,
} from './register';
export {
  enrollDeviceKey,
  sendWithReauth,
  syncDeviceKeyRegistration,
  walletKeyStatusWithoutSending,
  type ReauthNotice,
  type SendWithReauthInput,
  type SyncOptions,
  type WalletKeyStatus,
} from './enrollment';
export {
  leaveForWalletReauth,
  resumeWalletReauth,
  takeWalletReauth,
  writeWalletReauth,
  WALLET_REAUTH_KEY,
  WALLET_REAUTH_PURPOSE,
  WALLET_REAUTH_TTL_MS,
  type LeaveForWalletReauthDeps,
  type ResumeWalletReauthDeps,
  type TabStorageLike,
  type WalletReauthMarker,
  type WalletReauthReason,
  type WalletReauthResume,
  type WalletReauthTake,
} from './reauth-return';
export { browserPlatformSignals, enrollPlatformOf, needsEnrollGuide, type EnrollPlatform, type PlatformSignals } from './platform';
export {
  deleteDeviceKey,
  loadDeviceKey,
  loadLastSyncedAt,
  loadPersistGranted,
  loadTicketSnapshot,
  requestPersistentStorage,
  saveDeviceKey,
  saveLastSyncedAt,
  saveTicketSnapshot,
  storagePersisted,
  WALLET_DB_NAME,
  walletDatabase,
  type DeviceKeyReason,
  type DeviceKeyRegistration,
  type StoredDeviceKey,
  type WalletTicketSnapshot,
} from './store';
export {
  isNetworkOnlyPath,
  isSkipWaitingMessage,
  isWalletCacheVersion,
  isWalletDocumentPath,
  isWalletOwnedCache,
  LEGACY_WALLET_CACHES,
  PUSH_SW_SCOPE,
  PUSH_SW_URL,
  runWalletKillSwitch,
  walletScopeLeaks,
  WALLET_SW_SCOPE,
  WALLET_SW_URL,
  rejectNoStore,
  rotateWalletCaches,
  staleWalletCaches,
  walletCacheName,
  WALLET_CACHE_PREFIX,
} from './sw-rules';
export { applyWaitingUpdate, holdQrLock, isUpdateHoldScreen, qrLockHeld, QR_LOCK_NAME, shouldOfferUpdate, WALLET_SCOPE_URL } from './update-hold';
export { DeviceQr, type DeviceQrProps, type DeviceQrSnapshot } from './ui/DeviceQr';
export { OfflineBanner, type OfflineBannerProps } from './ui/OfflineBanner';
// 갱신 토스트(ui/WalletUpdateToast)는 로더가 늦게 불러오므로 여기서 내보내지 않는다(첫 JS에 들지 않게)
export { WalletUpdateLoader } from './ui/WalletUpdateLoader';
