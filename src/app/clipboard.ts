export interface ClipboardCopyOptions {
  verify?: boolean;
}

function copyWithSelection(text: string): boolean {
  if (!document.body || typeof document.execCommand !== 'function') return false;
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.inset = '0 auto auto -9999px';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
  }
  return copied;
}

async function clipboardMatches(text: string): Promise<boolean | null> {
  if (!navigator.clipboard?.readText) return null;
  try {
    return await navigator.clipboard.readText() === text;
  } catch {
    return null;
  }
}

export async function copyTextToClipboard(text: string, options: ClipboardCopyOptions = {}): Promise<void> {
  let wroteWithClipboardApi = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      wroteWithClipboardApi = true;
    } catch {
      wroteWithClipboardApi = false;
    }
  }

  if (!wroteWithClipboardApi) {
    if (!copyWithSelection(text)) throw new Error('浏览器拒绝写入剪贴板，剪贴板未更新');
    if (options.verify && await clipboardMatches(text) === false) throw new Error('剪贴板内容校验不一致，剪贴板未更新');
    return;
  }

  if (!options.verify) return;
  const matches = await clipboardMatches(text);
  if (matches === true) return;
  if (matches === null) {
    copyWithSelection(text);
    return;
  }

  if (!copyWithSelection(text)) throw new Error('剪贴板内容校验不一致，剪贴板未更新');
  const fallbackMatches = await clipboardMatches(text);
  if (fallbackMatches === false) throw new Error('剪贴板内容校验不一致，剪贴板未更新');
}
