# In-app image viewing

Open an image from the Code Editor file tree to view it in an editor tab. Image
tabs are read-only: they never decode binary bytes as text or expose formatting
and saving. Restored tabs retain their file identity and reload the image through
the workspace client; image data is not stored in editor-session persistence.

Chat attachment thumbnails open an image modal. Agent replies can provide
Markdown image syntax (`![Preview](renders/preview.png)`) or a normal image link
(`[Preview](renders/preview.png)`); both open the image inside the app. Markdown
images have an explicit **Open image** action. Linked images use the Artifacts
panel so the conversation stays accessible. Attachment modals close with their
Close button or Escape and restore focus to the originating control.

The shared viewer provides Fit, Actual size, zoom in/out, pixel dimensions, and
Reload for files an agent updates. PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, and SVG
are supported when the browser can decode them. Transparent backgrounds use a
checkerboard. Invalid images and failed reads show explicit errors.

Workspace image reads use `fsReadDataUrl` through the typed CrewCode client on
desktop, direct web, and Hub. Local images are bounded to the registered workspace,
including resolved filesystem links. SSH workspaces use the existing SFTP binary
reader on the workspace host. Absolute SSH reply paths resolve against that
host's workspace path; client-local paths are never substituted. Image reads use
the 25 MB attachment ceiling; other binary previews retain their 2 MB ceiling.

HTTP(S) image URLs and bounded base64 image Markdown sources can also open in the
viewer. Network images load only when opened, with no referrer. SSH loopback URLs
retain the explicit port-forwarding guidance. SVG files render only as inert
`img` resources; generated HTML/SVG code fences retain the separate opaque artifact
sandbox. No renderer script policy or native capability is added for images.
