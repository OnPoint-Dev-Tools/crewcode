/** Formats the browser can display without executing document content. */
export function isImageFile(path: string): boolean {
  return /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(path)
}
