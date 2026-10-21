import { describe, expect, it } from 'vitest';

import { LibraryOperationError, messageForPublicError, toMessage } from '../../src/renderer/error-utils';
import { catalogs, createTranslator } from '../../src/renderer/i18n';
import { createPublicError, publicErrorSchema, type PublicErrorReason } from '../../src/shared/protocol/errors';

describe('presentation embedded thumbnail feedback', () => {
  it('preserves the unavailable-thumbnail code through the public IPC error schema', () => {
    const error = createPublicError('PRESENTATION_THUMBNAIL_UNAVAILABLE');
    expect(publicErrorSchema.parse(JSON.parse(JSON.stringify(error)))).toEqual(error);
    expect(messageForPublicError(error, 'zh-CN')).toContain('内嵌封面');
    expect(messageForPublicError(error, 'en')).toContain('embedded thumbnail');
    expect(messageForPublicError(error, 'en')).not.toContain('unexpected error');
  });

  it.each(['zh-CN', 'en'] as const)('explains embedded-cover failure in %s without converter setup advice', (locale) => {
    const error = new LibraryOperationError({
      code: 'INTERNAL_ERROR',
      message: 'raw internal error',
      reason: 'PRESENTATION_THUMBNAIL_UNAVAILABLE' as PublicErrorReason,
    });
    const message = toMessage(error, 'fallback', locale);
    const preview = createTranslator(catalogs[locale])('preview.presentationThumbnailUnavailable');
    for (const text of [message, preview]) {
      expect(text).toContain(locale === 'zh-CN' ? '内嵌封面' : 'embedded thumbnail');
      expect(text).not.toMatch(/LibreOffice|soffice|SERPENT_LIBREOFFICE_PATH/);
    }
  });

  it.each(['zh-CN', 'en'] as const)('maps legacy stored dependency errors to the current failure hint in %s', (locale) => {
    const error = createPublicError('LIBREOFFICE_REQUIRED');
    expect(publicErrorSchema.parse(JSON.parse(JSON.stringify(error)))).toEqual(error);
    const message = messageForPublicError(error, locale);
    expect(message).toContain(locale === 'zh-CN' ? '内嵌封面' : 'embedded thumbnail');
    expect(message).not.toMatch(/LibreOffice|soffice|SERPENT_LIBREOFFICE_PATH/);
  });
});
