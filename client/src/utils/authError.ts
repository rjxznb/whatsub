const authReasonMessages: Record<string, string> = {
  invalid_email: '\u90ae\u7bb1\u683c\u5f0f\u4e0d\u5bf9',
  invalid_input: '\u90ae\u7bb1\u6216\u9a8c\u8bc1\u7801\u65e0\u6548\uff0c\u8bf7\u91cd\u65b0\u83b7\u53d6\u9a8c\u8bc1\u7801\u540e\u518d\u8bd5',
  invalid_json: '\u8bf7\u6c42\u683c\u5f0f\u6709\u8bef\uff0c\u8bf7\u91cd\u8bd5',
  no_code: '\u8bf7\u5148\u83b7\u53d6\u9a8c\u8bc1\u7801',
  wrong_code: '\u9a8c\u8bc1\u7801\u9519\u8bef',
  too_many_attempts: '\u5c1d\u8bd5\u6b21\u6570\u8fc7\u591a\uff0c\u8bf7\u91cd\u65b0\u83b7\u53d6\u9a8c\u8bc1\u7801',
  rate_limited: '\u8bf7\u6c42\u8fc7\u5feb\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5',
};

const authCommandErrorMessages: Record<string, string> = {
  auth_connect_failed: '\u65e0\u6cd5\u8fde\u63a5\u767b\u5f55\u670d\u52a1\u5668\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u6216\u4ee3\u7406\u540e\u91cd\u8bd5\u3002',
  auth_result_uncertain: '\u767b\u5f55\u7ed3\u679c\u672a\u786e\u8ba4\uff0c\u8bf7\u518d\u6b21\u5c1d\u8bd5\uff1b\u5982\u679c\u9a8c\u8bc1\u7801\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u83b7\u53d6\u3002',
  auth_protocol_error: '\u767b\u5f55\u670d\u52a1\u5668\u8fd4\u56de\u5f02\u5e38\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
};

export function authReasonToChinese(reason?: string): string {
  return authReasonMessages[reason ?? ''] ?? '\u767b\u5f55\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002';
}

export function authCommandErrorToChinese(
  error: unknown,
  operation?: 'send' | 'verify',
): string {
  const message = error instanceof Error ? error.message : String(error);
  return authCommandErrorMessages[message]
    ?? (operation === 'send'
      ? '\u53d1\u9001\u9a8c\u8bc1\u7801\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002'
      : '\u767b\u5f55\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002');
}
