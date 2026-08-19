export async function copyTextToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('当前环境不支持剪贴板');
  }
  await navigator.clipboard.writeText(text);
}
