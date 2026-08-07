// Official CrewCode plugin browser helper. GENERATED from src/ — do not edit by hand.
// Runs inside sandboxed plugin iframes. It never exposes Electron APIs.
"use strict";
(() => {
  // src/create-api.ts
  var CREWCODE_PLUGIN_API_VERSION = "0.1";
  var RESERVED_NETWORK_MESSAGE = "crewcode.network.fetch is reserved in plugin API v0. Use an agentProvider runtime (http/sse-http/openai-compatible/websocket) for network access.";
  var RESERVED_SECRETS_MESSAGE = "crewcode.secrets.get is reserved in plugin API v0. Use a provider apiKeyEnv or local CLI auth instead.";
  function createCrewCodeApi(options = {}) {
    var _a, _b;
    const timeoutMs = (_a = options.timeoutMs) != null ? _a : 1e4;
    const targetOrigin = (_b = options.targetOrigin) != null ? _b : "*";
    const pending = /* @__PURE__ */ new Map();
    const contextListeners = /* @__PURE__ */ new Set();
    let seq = 0;
    let latestContext = null;
    const reportError = (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      window.parent.postMessage({ type: "crewcode:runtimeError", message: error.message, stack: error.stack }, targetOrigin);
    };
    window.addEventListener("error", (event) => {
      var _a2;
      return reportError((_a2 = event.error) != null ? _a2 : event.message);
    });
    window.addEventListener("unhandledrejection", (event) => reportError(event.reason));
    const request = (method, params) => {
      const id = `req-${++seq}`;
      window.parent.postMessage({ type: "crewcode:request", id, method, params }, targetOrigin);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error("CrewCode plugin request timed out"));
        }, timeoutMs);
      });
    };
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "crewcode:context") {
        latestContext = msg;
        for (const listener of contextListeners) listener(latestContext);
        return;
      }
      if (msg.type === "crewcode:response" && typeof msg.id === "string" && pending.has(msg.id)) {
        const callbacks = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) callbacks.resolve(msg.result);
        else callbacks.reject(new Error(typeof msg.error === "string" ? msg.error : "plugin request failed"));
      }
    });
    return {
      apiVersion: CREWCODE_PLUGIN_API_VERSION,
      request,
      onContext(listener) {
        contextListeners.add(listener);
        if (latestContext) listener(latestContext);
        return () => contextListeners.delete(listener);
      },
      getContext: () => latestContext,
      workspace: {
        listFiles: () => request("workspace:listFiles"),
        readFile: (sub) => request("workspace:readFile", { sub }),
        writeFile: (sub, text) => request("workspace:writeFile", { sub, text })
      },
      network: {
        fetch: () => Promise.reject(new Error(RESERVED_NETWORK_MESSAGE))
      },
      secrets: {
        get: () => Promise.reject(new Error(RESERVED_SECRETS_MESSAGE))
      }
    };
  }

  // src/browser-global.ts
  window.createCrewCodeApi = createCrewCodeApi;
  window.crewcode = createCrewCodeApi();
})();
