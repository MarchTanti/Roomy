/**
 * Barrel for the storage helpers.
 *
 * `getPhotoStore()` is the entry point for new code — it picks the local or
 * Supabase store and exposes one API. The individual modules stay exported for
 * the few places that need the low-level pieces (tests, the upload route's
 * error handling).
 */

export {
  getPhotoStore,
  setPhotoStoreForTesting,
  resetPhotoStore,
  PhotoStoreError,
} from './store';
export type { PhotoStore } from './store';

export { imageKey, parseImageKey, isValidImageKey } from './keys';
export type { ParsedImageKey } from './keys';

export {
  processUpload,
  assertNoExif,
  readDimensions,
  ImageProcessingError,
} from './process-image';
export type { ProcessedImage, ProcessOptions, ProcessedContentType } from './process-image';

export { signedUrlFor, signedUrlsFor, SignedUrlError, _resetStorageClient } from './signed-url';
export type { SignedUrl } from './signed-url';

export { uploadRoomPhoto, UploadError, _resetUploadStorageClient } from './upload-room-photo';
export type { UploadedPhoto, UploadOptions } from './upload-room-photo';

export { downloadRoomPhoto, DownloadError, _resetDownloadStorageClient } from './download';

export { removeRoomPhoto, DeleteError } from './delete';