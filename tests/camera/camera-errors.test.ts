import { describe, expect, it } from 'vitest';
import { createCameraError, errorName, isOverconstrainedError, mapCameraError } from '../../src/camera/camera-errors';
import { AppError } from '../../src/contracts';
import { domError } from './camera-fakes';

const VIETNAMESE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

describe('mapCameraError (F2)', () => {
  it.each([
    { name: 'NotAllowedError', code: 'CAMERA_PERMISSION_DENIED' },
    { name: 'SecurityError', code: 'CAMERA_PERMISSION_DENIED' },
    { name: 'NotFoundError', code: 'CAMERA_NOT_FOUND' },
    { name: 'DevicesNotFoundError', code: 'CAMERA_NOT_FOUND' },
    { name: 'NotReadableError', code: 'CAMERA_IN_USE' },
    { name: 'TrackStartError', code: 'CAMERA_IN_USE' },
    { name: 'AbortError', code: 'CAMERA_FAILED' },
    { name: 'OverconstrainedError', code: 'CAMERA_FAILED' },
    { name: 'constructor', code: 'CAMERA_FAILED' },
  ])('$name → $code, giữ lỗi gốc trong detail', ({ name, code }) => {
    const cause = domError(name);
    const mapped = mapCameraError(cause);
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.code).toBe(code);
    expect(mapped.detail).toBe(cause);
  });

  it('giá trị lạ (chuỗi, null, undefined, số, {}) → CAMERA_FAILED; AppError có sẵn được giữ nguyên', () => {
    for (const value of ['lỗi', null, undefined, 42, {}]) expect(mapCameraError(value).code).toBe('CAMERA_FAILED');
    const original = createCameraError('CAMERA_IN_USE');
    expect(mapCameraError(original)).toBe(original);
  });

  it.each(['UNSUPPORTED_BROWSER', 'CAMERA_PERMISSION_DENIED', 'CAMERA_NOT_FOUND', 'CAMERA_IN_USE', 'CAMERA_FAILED'] as const)(
    'thông điệp %s bằng tiếng Việt và nêu việc cần làm',
    (code) => {
      const { message } = createCameraError(code);
      expect(message).toMatch(VIETNAMESE);
      expect(message).toMatch(/Hãy/);
    },
  );

  it('isOverconstrainedError và errorName chỉ dựa vào name dạng chuỗi', () => {
    expect(isOverconstrainedError(domError('OverconstrainedError'))).toBe(true);
    expect(isOverconstrainedError(domError('ConstraintNotSatisfiedError'))).toBe(true);
    expect(isOverconstrainedError(domError('NotAllowedError'))).toBe(false);
    expect([errorName({ name: 7 }), errorName('x'), errorName(null)]).toEqual(['', '', '']);
  });
});