# Chat backgrounds and adaptive colors

CrewCode can show a custom image behind the welcome surface of every fresh solo chat. The fresh-chat welcome content sits on a responsive, light- or dark-mode-aware frosted surface so its identity, prompt suggestions, and supporting copy stay readable without obscuring the surrounding image. **Show in regular solo chats** keeps that image behind the conversation after the first message; left-aligned, content-sized agent bubbles preserve message contrast without hiding the image or stretching across the regular-density reading column. Thinking and work-log blocks are also content-sized and use mode-aware frosted surfaces. They may expand only as far as the established chat reading width when their contents need more room. The sticky loader container stays transparent, while its compact loading visual receives a matching frosted capsule and drops the decorative yellow text glow so it remains crisp over the image. Crew and terminal panes are not changed.

Choose, replace, or remove the image in **Settings → Appearance → Chat background**. CrewCode accepts PNG, JPG, WebP, and GIF files up to 2 MB, centers the image, and crops it to fill the available chat canvas. A contrast overlay keeps welcome copy and suggestions readable.

**Match CrewCode colors** derives a compact light or dark palette from a downsampled copy of the image in the renderer. New uploads enable this option after successful analysis. The derived palette changes app surface, border, accent, sidebar, and chat-bubble tokens, but does not overwrite the user's selected named theme. Turning the option off or removing the background restores that named theme.

The image and derived palette are stored in renderer-local settings. They remain specific to the current device/browser profile: neither is written into a workspace, transcript, Brain continuity data, or an SSH host. Color analysis uses the browser canvas locally and makes no network request.

SVG is intentionally not accepted because uploaded SVG can contain active markup. Reduced-motion preferences disable the wallpaper entrance animation.
