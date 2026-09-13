export type ReelPlatform = 'instagram' | 'tiktok';
export type Reel = { platform: ReelPlatform; shortcode: string; url: string };
export type ReelFailure =
  | 'unavailable'
  | 'authentication_required'
  | 'rate_limited'
  | 'too_large'
  | 'unsupported_media'
  | 'photos_unavailable'
  | 'too_many_photos'
  | 'timeout'
  | 'cancelled'
  | 'extractor_failed';
export class ReelError extends Error {
  constructor(
    readonly category: ReelFailure,
    readonly size?: { bytes: number; atLeast?: boolean; downloadLimit?: number },
  ) {
    super(category);
  }
}
export const reelFailure = (error: unknown): ReelFailure =>
  error instanceof ReelError ? error.category : 'extractor_failed';
export type DownloadedVideo = {
  kind: 'video';
  path: string;
  bytes: number;
  duration: number;
  hasAudio: boolean;
  url: string;
};
export type DownloadedPhotos = {
  kind: 'photos';
  files: { path: string; name: string }[];
  bytes: number;
  url: string;
};
export type DownloadedReel = DownloadedVideo | DownloadedPhotos;
export type ReelStage =
  | 'admission'
  | 'download'
  | 'extraction'
  | 'inspection'
  | 'compression'
  | 'source_check'
  | 'upload';
export type ReelDownloader = {
  withDownloadedReel: <T>(
    input: {
      reel: Reel;
      signal: AbortSignal;
      maximumBytes: number;
      onStage?: (stage: ReelStage) => void;
    },
    consume: (media: DownloadedReel) => Promise<T>,
  ) => Promise<T>;
};
export type ReelScope = { guildId: string; channelId: string };
export type ReelClaim = { key: string; owner: string };
export type ReelOutcome =
  | ReelFailure
  | 'sent'
  | 'source_unavailable'
  | 'claim_lost'
  | 'permission_denied'
  | 'uncertain'
  | 'store_unavailable';
export type ReelStatus = 'processing' | 'publishing' | 'sent' | 'failed' | 'uncertain';
export type ReelStore = {
  getEnabled: (scope: ReelScope) => Promise<boolean>;
  setEnabled: (scope: ReelScope, enabled: boolean) => Promise<void>;
  claim: (scope: ReelScope & { messageId: string; shortcode: string }) => Promise<ReelClaim | null>;
  transition: (
    claim: ReelClaim,
    from: ReelStatus,
    to: ReelStatus,
    outcome?: ReelOutcome,
    deliveredMessageId?: string,
  ) => Promise<boolean>;
};
