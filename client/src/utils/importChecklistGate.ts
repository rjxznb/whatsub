/**
 * Two-layer gate for the pre-import checklist:
 *   - localStorage:   永久关闭("以后不再提示")
 *   - sessionStorage: 本次会话已经看过(关闭窗口后清空,下次冷启动会再弹)
 *
 * sessionStorage 在 Tauri WebView 里随窗口销毁而清空——即用户「关掉
 * 软件再开」就会重新触发提示,匹配产品意图。
 */

const SKIP_FOREVER_KEY = 'whatsub.importChecklist.skippedForever';
const SHOWN_THIS_SESSION_KEY = 'whatsub.importChecklist.shownThisSession';

export function shouldShowImportChecklist(): boolean {
  try {
    if (localStorage.getItem(SKIP_FOREVER_KEY) === '1') return false;
    if (sessionStorage.getItem(SHOWN_THIS_SESSION_KEY) === '1') return false;
  } catch {
    // localStorage / sessionStorage 不可用时(隐私模式之类)就当作"显示"
    return true;
  }
  return true;
}

export function markImportChecklistShown(skipForever: boolean): void {
  try {
    sessionStorage.setItem(SHOWN_THIS_SESSION_KEY, '1');
    if (skipForever) localStorage.setItem(SKIP_FOREVER_KEY, '1');
  } catch {
    // 失败就算了,顶多下次再弹一次
  }
}
