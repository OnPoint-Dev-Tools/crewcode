type GrabGuestAction = 'arm' | 'awaitClick' | 'extractHover' | 'setOverlayVisible' | 'cancel' | 'teardown'

interface GrabGuestScriptOptions {
  action: GrabGuestAction
  opId?: string
  visible?: boolean
}

export function buildGrabGuestScript(options: GrabGuestScriptOptions): string {
  return `(() => {
    const options = ${JSON.stringify(options)};
    const runtimeKey = '__crewcodeGrabRuntime';

    function clampRect(rect) {
      return {
        x: Number(rect.x || 0),
        y: Number(rect.y || 0),
        width: Math.max(0, Number(rect.width || 0)),
        height: Math.max(0, Number(rect.height || 0)),
      };
    }

    function sanitizeText(value, max = 1200) {
      const text = String(value || '').replace(/\\s+/g, ' ').trim();
      return text.length > max ? text.slice(0, max) + '…' : text;
    }

    function sanitizeHtml(value, max = 4000) {
      const scriptPattern = new RegExp('<script\\b[^<]*(?:(?!<\\/script>)<[^<]*)*<\\/script>', 'gi');
      const stylePattern = new RegExp('<style\\b[^<]*(?:(?!<\\/style>)<[^<]*)*<\\/style>', 'gi');
      const html = String(value || '')
        .replace(scriptPattern, '')
        .replace(stylePattern, '');
      return html.length > max ? html.slice(0, max) + '…' : html;
    }

    function isSecretLike(name, value) {
      return /(token|secret|password|pass|auth|key|cookie|session)/i.test(name)
        || /(bearer\\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]{12,})/i.test(String(value || ''));
    }

    function getSafeAttributes(element) {
      const out = {};
      const allowed = new Set(['id', 'class', 'name', 'type', 'role', 'href', 'src', 'alt', 'title', 'aria-label', 'placeholder', 'value', 'data-testid']);
      for (const attr of Array.from(element.attributes || [])) {
        const name = attr.name;
        if (!allowed.has(name) && !name.startsWith('data-')) continue;
        out[name] = isSecretLike(name, attr.value) ? '[redacted]' : sanitizeText(attr.value, 240);
      }
      return out;
    }

    function reactComponentName(element) {
      const key = Object.keys(element).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
      if (!key) return '';
      let fiber = element[key];
      let guard = 0;
      while (fiber && guard < 30) {
        const type = fiber.type || fiber.elementType;
        if (type && typeof type !== 'string') {
          const name = type.displayName || type.name || (type.render && (type.render.displayName || type.render.name));
          if (name && name !== 'Symbol(react.fragment)') return name;
        }
        fiber = fiber.return;
        guard++;
      }
      return '';
    }

    function describeTarget(element) {
      const rect = element.getBoundingClientRect();
      const size = Math.round(rect.width) + '×' + Math.round(rect.height);
      return {
        component: reactComponentName(element),
        selector: selectorPart(element),
        size,
      };
    }

    function selectorPart(element) {
      const tag = (element.tagName || 'div').toLowerCase();
      if (element.id) return tag + '#' + CSS.escape(element.id);
      const classes = Array.from(element.classList || []).slice(0, 3).map(name => '.' + CSS.escape(name)).join('');
      const siblings = element.parentElement
        ? Array.from(element.parentElement.children).filter(child => child.tagName === element.tagName)
        : [];
      const needsNth = siblings.length > 1;
      const nth = needsNth && element.parentElement
        ? ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')'
        : '';
      return tag + classes + nth;
    }

    function selectorPath(element) {
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && parts.length < 6) {
        parts.unshift(selectorPart(current));
        if (current.id) break;
        current = current.parentElement;
      }
      return parts.join(' > ');
    }

    function rectToPayload(rect) {
      return clampRect({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    }

    function computedStyles(element) {
      const style = window.getComputedStyle(element);
      const keys = ['display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'border', 'borderRadius'];
      const out = {};
      for (const key of keys) out[key] = sanitizeText(style[key] || '', 160);
      return out;
    }

    function nearbyText(element) {
      const nodes = [];
      const push = (value) => {
        const next = sanitizeText(value, 200);
        if (next && !nodes.includes(next)) nodes.push(next);
      };
      push(element.innerText || element.textContent || '');
      const parent = element.parentElement;
      if (parent) {
        for (const child of Array.from(parent.children)) {
          if (child === element) continue;
          push(child.innerText || child.textContent || '');
          if (nodes.length >= 6) break;
        }
      }
      return nodes.slice(0, 6);
    }

    function ancestorPath(element) {
      const out = [];
      let current = element;
      while (current && current.nodeType === 1 && out.length < 8) {
        out.unshift(selectorPart(current));
        current = current.parentElement;
      }
      return out;
    }

    function buildPayload(element) {
      const rect = element.getBoundingClientRect();
      const viewport = rectToPayload(rect);
      return {
        page: {
          url: window.location.href,
          title: document.title,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          capturedAt: new Date().toISOString(),
        },
        target: {
          tagName: (element.tagName || '').toLowerCase(),
          selector: selectorPath(element),
          textSnippet: sanitizeText(element.innerText || element.textContent || ''),
          htmlSnippet: sanitizeHtml(element.outerHTML || ''),
          attributes: getSafeAttributes(element),
          rectViewport: viewport,
          rectPage: {
            x: viewport.x + window.scrollX,
            y: viewport.y + window.scrollY,
            width: viewport.width,
            height: viewport.height,
          },
          computedStyles: computedStyles(element),
        },
        nearbyText: nearbyText(element),
        ancestorPath: ancestorPath(element),
      };
    }

    function createRuntime() {
      const overlay = document.createElement('div');
      overlay.setAttribute('data-crewcode-grab-overlay', 'true');
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.pointerEvents = 'none';
      overlay.style.zIndex = '2147483646';

      const highlight = document.createElement('div');
      highlight.style.position = 'fixed';
      highlight.style.border = '1px solid #285a48';
      highlight.style.background = 'rgba(40, 90, 72, 0.12)';
      highlight.style.pointerEvents = 'none';
      highlight.style.boxSizing = 'border-box';
      highlight.style.borderRadius = '4px';
      highlight.style.display = 'none';

      const tooltip = document.createElement('div');
      tooltip.style.position = 'fixed';
      tooltip.style.maxWidth = '320px';
      tooltip.style.padding = '5px 8px';
      tooltip.style.border = '1px solid #1c2f2f';
      tooltip.style.background = '#0f120f';
      tooltip.style.color = '#e3f0e8';
      tooltip.style.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      tooltip.style.lineHeight = '1.5';
      tooltip.style.borderRadius = '5px';
      tooltip.style.whiteSpace = 'nowrap';
      tooltip.style.overflow = 'hidden';
      tooltip.style.textOverflow = 'ellipsis';
      tooltip.style.pointerEvents = 'none';
      tooltip.style.display = 'none';

      const badge = document.createElement('div');
      badge.textContent = 'grab active';
      badge.style.position = 'fixed';
      badge.style.top = '12px';
      badge.style.right = '12px';
      badge.style.padding = '6px 9px';
      badge.style.border = '1px solid #1c2f2f';
      badge.style.background = '#0f120f';
      badge.style.color = '#e3f0e8';
      badge.style.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      badge.style.borderRadius = '6px';
      badge.style.pointerEvents = 'none';
      badge.style.display = 'none';

      overlay.appendChild(highlight);
      overlay.appendChild(tooltip);
      overlay.appendChild(badge);
      document.documentElement.appendChild(overlay);

      const runtime = {
        overlay,
        highlight,
        tooltip,
        badge,
        visible: true,
        armed: false,
        hovered: null,
        resolvePending: null,
        installed: false,
        moveHandler: null,
        clickHandler: null,
        ensureVisible() {
          overlay.style.display = runtime.visible ? 'block' : 'none';
          badge.style.display = runtime.visible && runtime.armed ? 'block' : 'none';
        },
        updateHighlight(element) {
          runtime.hovered = element;
          if (!element || !runtime.visible) {
            highlight.style.display = 'none';
            tooltip.style.display = 'none';
            return;
          }
          const rect = element.getBoundingClientRect();
          highlight.style.display = 'block';
          highlight.style.left = rect.left + 'px';
          highlight.style.top = rect.top + 'px';
          highlight.style.width = rect.width + 'px';
          highlight.style.height = rect.height + 'px';
          runtime.updateTooltip(element, rect);
        },
        updateTooltip(element, rect) {
          const info = describeTarget(element);
          // Build with textContent (never innerHTML) — selector/component come from page DOM.
          const span = (text, color) => {
            const node = document.createElement('span');
            node.textContent = text;
            node.style.color = color;
            return node;
          };
          tooltip.textContent = '';
          if (info.component) {
            tooltip.appendChild(span('<' + info.component + '>', '#6fcaa0'));
            tooltip.appendChild(document.createTextNode(' '));
            tooltip.appendChild(span(info.selector, '#7c8c84'));
          } else {
            tooltip.appendChild(span(info.selector, '#e3f0e8'));
          }
          tooltip.appendChild(document.createTextNode(' '));
          tooltip.appendChild(span(info.size, '#7c8c84'));
          tooltip.style.display = 'block';
          // Measure after content set, then place above the element unless it would clip the top.
          const tipRect = tooltip.getBoundingClientRect();
          const margin = 4;
          let top = rect.top - tipRect.height - margin;
          if (top < margin) top = Math.min(rect.bottom + margin, window.innerHeight - tipRect.height - margin);
          let left = rect.left;
          if (left + tipRect.width > window.innerWidth - margin) left = window.innerWidth - tipRect.width - margin;
          tooltip.style.left = Math.max(margin, left) + 'px';
          tooltip.style.top = Math.max(margin, top) + 'px';
        },
        install() {
          if (runtime.installed) return;
          runtime.moveHandler = (event) => {
            if (!runtime.armed) return;
            const target = document.elementFromPoint(event.clientX, event.clientY);
            if (target instanceof Element && !overlay.contains(target)) runtime.updateHighlight(target);
          };
          runtime.clickHandler = (event) => {
            if (!runtime.armed) return;
            const target = event.target;
            if (!(target instanceof Element) || overlay.contains(target)) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            const payload = buildPayload(target);
            const resolvePending = runtime.resolvePending;
            runtime.resolvePending = null;
            runtime.armed = false;
            runtime.updateHighlight(null);
            runtime.ensureVisible();
            resolvePending?.(payload);
          };
          document.addEventListener('mousemove', runtime.moveHandler, true);
          document.addEventListener('click', runtime.clickHandler, true);
          runtime.installed = true;
        },
        arm() {
          runtime.install();
          runtime.armed = true;
          runtime.ensureVisible();
        },
        awaitClick() {
          runtime.arm();
          return new Promise((resolve) => {
            runtime.resolvePending = resolve;
          });
        },
        extractHover() {
          return runtime.hovered ? buildPayload(runtime.hovered) : null;
        },
        setOverlayVisible(visible) {
          runtime.visible = !!visible;
          runtime.ensureVisible();
          if (!runtime.visible) {
            highlight.style.display = 'none';
            tooltip.style.display = 'none';
          } else runtime.updateHighlight(runtime.hovered);
          return { ok: true };
        },
        cancel() {
          runtime.armed = false;
          runtime.updateHighlight(null);
          runtime.ensureVisible();
          const resolvePending = runtime.resolvePending;
          runtime.resolvePending = null;
          resolvePending?.(null);
          return { ok: true };
        },
        teardown() {
          runtime.cancel();
          if (runtime.installed) {
            document.removeEventListener('mousemove', runtime.moveHandler, true);
            document.removeEventListener('click', runtime.clickHandler, true);
          }
          overlay.remove();
          delete window[runtimeKey];
          return { ok: true };
        },
      };

      return runtime;
    }

    const existingRuntime = window[runtimeKey];
    const runtime = existingRuntime || (options.action === 'arm' || options.action === 'awaitClick'
      ? (window[runtimeKey] = createRuntime())
      : null);

    switch (options.action) {
      case 'arm':
        return runtime.arm(), { ok: true };
      case 'awaitClick':
        return runtime.awaitClick(options.opId || '');
      case 'extractHover':
        return runtime ? runtime.extractHover() : null;
      case 'setOverlayVisible':
        return runtime ? runtime.setOverlayVisible(options.visible !== false) : { ok: true };
      case 'cancel':
        return runtime ? runtime.cancel() : { ok: true };
      case 'teardown':
        return runtime ? runtime.teardown() : { ok: true };
      default:
        return { ok: false, error: 'unknown action' };
    }
  })();`
}
