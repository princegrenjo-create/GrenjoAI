/**
 * Attachment layer barrel.
 *
 * Consumers (IPC registration, chat wiring, tests) import from here, so the
 * internal file split can change without touching them.
 */
export { classifyFile, extractText, extractTextFromBytes, mimeTypeForFile } from './extract';
export type {
  Classification,
  ClassifyFileInput,
  ExtractTextBytesInput,
  ExtractTextInput,
  ExtractTextResult,
} from './extract';
export { imageDataUrl, probeImage, sniffImageMime, validateImage } from './images';
export type {
  ImageFormat,
  ImageHeader,
  ImageValidation,
  ImageValidationFailure,
  ImageValidationSuccess,
} from './images';
export { createAttachmentStore } from './store';
export type { AttachmentStore, AttachmentStoreOptions } from './store';
export { createAttachmentService } from './service';
export type {
  AttachmentPickerDialogs,
  AttachmentService,
  AttachmentServiceDeps,
  TranscriptionGateway,
} from './service';
