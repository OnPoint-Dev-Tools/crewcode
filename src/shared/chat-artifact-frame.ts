export const CHAT_ARTIFACT_PROTOCOL = 'crewcode-artifact'
export const CHAT_ARTIFACT_PATH = '/crewcode-artifact-frame'
export const CHAT_ARTIFACT_MAX_CHARS = 2_000_000

// A separate document policy allows artifact scripts without allowing inline
// scripts in the trusted renderer. Header sandbox survives document.write().
export const CHAT_ARTIFACT_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https: http:; style-src 'unsafe-inline' https: http:; img-src data: blob: https: http:; font-src data: https: http:; connect-src https: http:; media-src data: blob: https: http:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const

// Content stays in the fragment: no artifact body is sent to the HTTP server,
// written to disk, or included in server access logs.
export const CHAT_ARTIFACT_FRAME_HTML = `<!doctype html><meta charset="utf-8"><script>
try {
  const html = decodeURIComponent(location.hash.slice(1));
  if (html.length > ${CHAT_ARTIFACT_MAX_CHARS}) throw new Error('Artifact exceeds the 2 MB preview limit');
  document.open(); document.write(html); document.close();
} catch (error) { document.body.textContent = String(error); }
</script>`

export function chatArtifactFrameUrl(html: string, base: string): string {
  if (html.length > CHAT_ARTIFACT_MAX_CHARS) throw new Error('Artifact exceeds the 2 MB preview limit')
  return `${base}#${encodeURIComponent(html)}`
}
