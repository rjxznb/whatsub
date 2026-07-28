import { describe, expect, it } from 'vitest';
import { authCommandErrorToChinese, authReasonToChinese } from './authError';

describe('auth error mapping', () => {
  it('maps OTP business reasons to Chinese guidance', () => {
    expect(authReasonToChinese('wrong_code')).toBe('\u9a8c\u8bc1\u7801\u9519\u8bef');
    expect(authReasonToChinese('too_many_attempts')).toBe(
      '\u5c1d\u8bd5\u6b21\u6570\u8fc7\u591a\uff0c\u8bf7\u91cd\u65b0\u83b7\u53d6\u9a8c\u8bc1\u7801',
    );
  });

  it('maps known transport failures to Chinese guidance', () => {
    expect(authCommandErrorToChinese('auth_connect_failed')).toBe(
      '\u65e0\u6cd5\u8fde\u63a5\u767b\u5f55\u670d\u52a1\u5668\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u6216\u4ee3\u7406\u540e\u91cd\u8bd5\u3002',
    );
    expect(authCommandErrorToChinese('auth_result_uncertain')).toBe(
      '\u767b\u5f55\u7ed3\u679c\u672a\u786e\u8ba4\uff0c\u8bf7\u518d\u6b21\u5c1d\u8bd5\uff1b\u5982\u679c\u9a8c\u8bc1\u7801\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u83b7\u53d6\u3002',
    );
    expect(authCommandErrorToChinese('auth_protocol_error')).toBe(
      '\u767b\u5f55\u670d\u52a1\u5668\u8fd4\u56de\u5f02\u5e38\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
    );
  });

  it('does not expose unknown transport error details', () => {
    expect(authCommandErrorToChinese('error sending request for url (secret-url)')).not.toContain(
      'secret-url',
    );
  });

  it('returns the verify fallback for a non-stringifiable error value', () => {
    expect(authCommandErrorToChinese(Object.create(null), 'verify')).toBe(
      '\u767b\u5f55\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
    );
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'returns the verify fallback for inherited key %s',
    (error) => {
      expect(authCommandErrorToChinese(error, 'verify')).toBe(
        '\u767b\u5f55\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
      );
    },
  );
});
