export function isThreadHidden(thread: { readonly hiddenAt?: string | null | undefined }): boolean {
  return thread.hiddenAt != null;
}
