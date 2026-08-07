import { ViewPlugin, showDialog, EditorView, hoverTooltip, getDialog, showTooltip, keymap, showPanel } from '@codemirror/view';
import { ChangeSet, MapMode, Facet, EditorState, StateField, StateEffect, Prec } from '@codemirror/state';
import { language, highlightingFor, indentUnit, getIndentUnit } from '@codemirror/language';
import { Marked } from 'marked';
import { highlightCode } from '@lezer/highlight';
import { autocompletion, snippet, insertCompletionText } from '@codemirror/autocomplete';
import { setDiagnostics } from '@codemirror/lint';

let context = null;
function withContext(view, language, f) {
    let prev = context;
    try {
        context = { view, language };
        return f();
    }
    finally {
        context = prev;
    }
}
const marked = /*@__PURE__*/new Marked({
    walkTokens(token) {
        if (!context || token.type != "code")
            return;
        let lang = context.language && context.language(token.lang);
        if (!lang) {
            let viewLang = context.view.state.facet(language);
            if (viewLang && viewLang.name == token.lang)
                lang = viewLang;
        }
        if (!lang)
            return;
        let highlighter = { style: tags => highlightingFor(context.view.state, tags) };
        let result = "";
        highlightCode(token.text, lang.parser.parse(token.text), highlighter, (text, cls) => {
            result += cls ? `<span class="${cls}">${escHTML(text)}</span>` : escHTML(text);
        }, () => {
            result += "<br>";
        });
        token.escaped = true;
        token.text = result;
    }
});
function escHTML(text) {
    return text.replace(/[\n<&]/g, ch => ch == "\n" ? "<br>" : ch == "<" ? "&lt;" : "&amp;");
}
function docToHTML(value, defaultKind) {
    let kind = defaultKind, text = value;
    if (typeof text != "string") {
        kind = text.kind;
        text = text.value;
    }
    if (kind == "plaintext") {
        return escHTML(text);
    }
    else {
        return marked.parse(text, { async: false, });
    }
}

function toPosition(doc, pos) {
    let line = doc.lineAt(pos);
    return { line: line.number - 1, character: pos - line.from };
}
function fromPosition(doc, pos) {
    let line = doc.line(pos.line + 1);
    return line.from + pos.character;
}
function fromPositionChecked(doc, pos) {
    if (pos.line < 0 || pos.line >= doc.lines)
        return null;
    let line = doc.line(pos.line + 1);
    if (pos.character < 0 || pos.character > line.length)
        return null;
    return line.from + pos.character;
}

/**
A plugin that connects a given editor to a language server client.
*/
class LSPPlugin {
    /**
    @internal
    */
    constructor(
    /**
    The editor view that this plugin belongs to.
    */
    view, { client, uri, languageID }) {
        this.view = view;
        this.client = client;
        this.uri = uri;
        if (!languageID) {
            let lang = view.state.facet(language);
            languageID = lang ? lang.name : "";
        }
        client.workspace.openFile(uri, languageID, view);
        this.syncedDoc = view.state.doc;
        this.unsyncedChanges = ChangeSet.empty(view.state.doc.length);
    }
    /**
    Render a doc string from the server to HTML.
    */
    docToHTML(value, defaultKind = "plaintext") {
        let html = withContext(this.view, this.client.config.highlightLanguage, () => docToHTML(value, defaultKind));
        return this.client.config.sanitizeHTML ? this.client.config.sanitizeHTML(html) : html;
    }
    /**
    Convert a CodeMirror document offset into an LSP `{line,
    character}` object. Defaults to using the view's current
    document, but can be given another one.
    */
    toPosition(pos, doc = this.view.state.doc) {
        return toPosition(doc, pos);
    }
    /**
    Convert an LSP `{line, character}` object to a CodeMirror
    document offset.
    */
    fromPosition(pos, doc = this.view.state.doc) {
        return fromPosition(doc, pos);
    }
    /**
    Display an error in this plugin's editor.
    */
    reportError(message, err) {
        showDialog(this.view, {
            label: this.view.state.phrase(message) + ": " + (err.message || err),
            class: "cm-lsp-message cm-lsp-message-error",
            top: true
        });
    }
    /**
    Reset the [unsynced
    changes](https://codemirror.net/6/docs/ref/#lsp-client.LSPPlugin.unsyncedChanges). Should probably
    only be called by a [workspace](https://codemirror.net/6/docs/ref/#lsp-client.Workspace).
    */
    clear() {
        this.syncedDoc = this.view.state.doc;
        this.unsyncedChanges = ChangeSet.empty(this.view.state.doc.length);
    }
    /**
    @internal
    */
    update(update) {
        if (update.docChanged)
            this.unsyncedChanges = this.unsyncedChanges.compose(update.changes);
    }
    /**
    @internal
    */
    destroy() {
        this.client.workspace.closeFile(this.uri, this.view);
    }
    /**
    Get the LSP plugin associated with an editor, if any.
    */
    static get(view) {
        return view.plugin(lspPlugin);
    }
    /**
    Deprecated. Use
    [`LSPClient.plugin`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.plugin) instead.
    */
    static create(client, fileURI, languageID) {
        return client.plugin(fileURI, languageID);
    }
}
const lspPlugin = /*@__PURE__*/ViewPlugin.fromClass(LSPPlugin);

/**
Implementing your own workspace class can provide more control
over the way files are loaded and managed when interacting with
the language server. See
[`LSPClientConfig.workspace`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClientConfig.workspace).
*/
class Workspace {
    /**
    The constructor, as called by the client when creating a
    workspace.
    */
    constructor(
    /**
    The LSP client associated with this workspace.
    */
    client) {
        this.client = client;
    }
    /**
    Find the open file with the given URI, if it exists. The default
    implementation just looks it up in `this.files`.
    */
    getFile(uri) {
        return this.files.find(f => f.uri == uri) || null;
    }
    /**
    Called to request that the workspace open a file. The default
    implementation simply returns the file if it is open, null
    otherwise.
    */
    requestFile(uri) {
        return Promise.resolve(this.getFile(uri));
    }
    /**
    Called when the client for this workspace is connected. The
    default implementation calls
    [`LSPClient.didOpen`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.didOpen) on all open
    files.
    */
    connected() {
        for (let file of this.files)
            this.client.didOpen(file);
    }
    /**
    Called when the client for this workspace is disconnected. The
    default implementation does nothing.
    */
    disconnected() { }
    /**
    Called when a server-initiated change to a file is applied. The
    default implementation simply dispatches the update to the
    file's view, if the file is open and has a view.
    */
    updateFile(uri, update) {
        var _a;
        let file = this.getFile(uri);
        if (file)
            (_a = file.getView()) === null || _a === void 0 ? void 0 : _a.dispatch(update);
    }
    /**
    When the client needs to put a file other than the one loaded in
    the current editor in front of the user, for example in
    [`jumpToDefinition`](https://codemirror.net/6/docs/ref/#lsp-client.jumpToDefinition), it will call
    this function. It should make sure to create or find an editor
    with the file and make it visible to the user, or return null if
    this isn't possible.
    */
    displayFile(uri) {
        let file = this.getFile(uri);
        return Promise.resolve(file ? file.getView() : null);
    }
}
class DefaultWorkspaceFile {
    constructor(uri, languageId, version, doc, view) {
        this.uri = uri;
        this.languageId = languageId;
        this.version = version;
        this.doc = doc;
        this.view = view;
    }
    getView() { return this.view; }
}
class DefaultWorkspace extends Workspace {
    constructor() {
        super(...arguments);
        this.files = [];
        this.fileVersions = Object.create(null);
    }
    nextFileVersion(uri) {
        var _a;
        return this.fileVersions[uri] = ((_a = this.fileVersions[uri]) !== null && _a !== void 0 ? _a : -1) + 1;
    }
    syncFiles() {
        let result = [];
        for (let file of this.files) {
            let plugin = LSPPlugin.get(file.view);
            if (!plugin)
                continue;
            let changes = plugin.unsyncedChanges;
            if (!changes.empty) {
                result.push({ changes, file, prevDoc: file.doc });
                file.doc = file.view.state.doc;
                file.version = this.nextFileVersion(file.uri);
                plugin.clear();
            }
        }
        return result;
    }
    openFile(uri, languageId, view) {
        if (this.getFile(uri))
            throw new Error("Default workspace implementation doesn't support multiple views on the same file");
        let file = new DefaultWorkspaceFile(uri, languageId, this.nextFileVersion(uri), view.state.doc, view);
        this.files.push(file);
        this.client.didOpen(file);
    }
    closeFile(uri) {
        let file = this.getFile(uri);
        if (file) {
            this.files = this.files.filter(f => f != file);
            this.client.didClose(uri);
        }
    }
}

const lspTheme = /*@__PURE__*/EditorView.baseTheme({
    ".cm-lsp-documentation": {
        padding: "0 7px",
        "& p, & pre": {
            margin: "2px 0"
        }
    },
    ".cm-lsp-signature-tooltip": {
        padding: "2px 6px",
        borderRadius: "2.5px",
        position: "relative",
        maxWidth: "30em",
        maxHeight: "10em",
        overflowY: "scroll",
        "& .cm-lsp-documentation": {
            padding: "0",
            fontSize: "80%",
        },
        "& .cm-lsp-signature-num": {
            fontFamily: "monospace",
            position: "absolute",
            left: "2px", top: "4px",
            fontSize: "70%",
            lineHeight: "1.3"
        },
        "& .cm-lsp-signature": {
            fontFamily: "monospace",
            textIndent: "1em hanging",
        },
        "& .cm-lsp-active-parameter": {
            fontWeight: "bold"
        },
    },
    ".cm-lsp-signature-multiple": {
        paddingLeft: "1.5em"
    },
    ".cm-panel.cm-lsp-rename-panel": {
        padding: "2px 6px 4px",
        position: "relative",
        "& label": { fontSize: "80%" },
        "& [name=close]": {
            position: "absolute",
            top: "0", bottom: "0",
            right: "4px",
            backgroundColor: "inherit",
            border: "none",
            font: "inherit",
            padding: "0"
        }
    },
    ".cm-lsp-message button[type=submit]": {
        display: "block"
    },
    ".cm-lsp-reference-panel": {
        fontFamily: "monospace",
        whiteSpace: "pre",
        padding: "3px 6px",
        maxHeight: "120px",
        overflow: "auto",
        "& .cm-lsp-reference-file": {
            fontWeight: "bold",
        },
        "& .cm-lsp-reference": {
            cursor: "pointer",
            "&[aria-selected]": {
                backgroundColor: "#0077ee44"
            },
        },
        "& .cm-lsp-reference-line": {
            opacity: "0.7",
        },
    },
});

class Request {
    constructor(id, params, timeout) {
        this.id = id;
        this.params = params;
        this.timeout = timeout;
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}
const clientCapabilities = {
    general: {
        markdown: {
            parser: "marked",
        },
    },
    textDocument: {
        completion: {
            completionItem: {
                snippetSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                insertReplaceSupport: false,
            },
            completionList: {
                itemDefaults: ["commitCharacters", "editRange", "insertTextFormat"]
            },
            completionItemKind: { valueSet: [] },
            contextSupport: true,
        },
        hover: {
            contentFormat: ["markdown", "plaintext"]
        },
        formatting: {},
        rename: {},
        signatureHelp: {
            contextSupport: true,
            signatureInformation: {
                documentationFormat: ["markdown", "plaintext"],
                parameterInformation: { labelOffsetSupport: true },
                activeParameterSupport: true,
            },
        },
        definition: {},
        declaration: {},
        implementation: {},
        typeDefinition: {},
        references: {},
        diagnostic: {},
    },
    window: {
        showMessage: {}
    }
};
/**
A workspace mapping is used to track changes made to open
documents, so that positions returned by a request can be
interpreted in terms of the current, potentially changed document.
*/
class WorkspaceMapping {
    /**
    @internal
    */
    constructor(client) {
        this.client = client;
        /**
        @internal
        */
        this.mappings = new Map;
        this.startDocs = new Map;
        for (let file of client.workspace.files) {
            this.mappings.set(file.uri, ChangeSet.empty(file.doc.length));
            this.startDocs.set(file.uri, file.doc);
        }
    }
    /**
    @internal
    */
    addChanges(uri, changes) {
        let known = this.mappings.get(uri);
        if (known)
            this.mappings.set(uri, known.composeDesc(changes));
    }
    /**
    Get the changes made to the document with the given URI since
    the mapping was created. Returns null for documents that aren't
    open.
    */
    getMapping(uri) {
        let known = this.mappings.get(uri);
        if (!known)
            return null;
        let file = this.client.workspace.getFile(uri), view = file === null || file === void 0 ? void 0 : file.getView(), plugin = view && LSPPlugin.get(view);
        return plugin ? known.composeDesc(plugin.unsyncedChanges) : known;
    }
    mapPos(uri, pos, assoc = -1, mode = MapMode.Simple) {
        let changes = this.getMapping(uri);
        return changes ? changes.mapPos(pos, assoc, mode) : pos;
    }
    mapPosition(uri, pos, assoc = -1, mode = MapMode.Simple) {
        let start = this.startDocs.get(uri);
        if (!start)
            throw new Error("Cannot map from a file that's not in the workspace");
        let off = fromPosition(start, pos);
        let changes = this.getMapping(uri);
        return changes ? changes.mapPos(off, assoc, mode) : off;
    }
    /**
    Disconnect this mapping from the client so that it will no
    longer be notified of new changes. You must make sure to call
    this on every mapping you create, except when you use
    [`withMapping`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.withMapping), which will
    automatically schedule a disconnect when the given promise
    resolves or aborts.
    */
    destroy() {
        this.client.activeMappings = this.client.activeMappings.filter(m => m != this);
    }
}
const defaultNotificationHandlers = {
    "window/logMessage": (client, params) => {
        if (params.type == 1)
            console.error("[lsp] " + params.message);
        else if (params.type == 2)
            console.warn("[lsp] " + params.message);
    },
    "window/showMessage": (client, params) => {
        if (params.type > 3 /* Info */)
            return;
        let view;
        for (let f of client.workspace.files)
            if (view = f.getView())
                break;
        if (view)
            showDialog(view, {
                label: params.message,
                class: "cm-lsp-message cm-lsp-message-" + (params.type == 1 ? "error" : params.type == 2 ? "warning" : "info"),
                top: true
            });
    }
};
/**
An LSP client manages a connection to a language server. It should
be explicitly [connected](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.connect) before
use.
*/
class LSPClient {
    /**
    Create a client object.
    */
    constructor(
    /**
    @internal
    */
    config = {}) {
        var _a;
        this.config = config;
        /**
        @internal
        */
        this.transport = null;
        this.nextReqID = 0;
        this.requests = [];
        /**
        @internal
        */
        this.activeMappings = [];
        /**
        The capabilities advertised by the server. Will be null when not
        connected or initialized.
        */
        this.serverCapabilities = null;
        this.supportSync = -1;
        /**
        @internal
        */
        this.extensions = [];
        this.receiveMessage = this.receiveMessage.bind(this);
        this.initializing = new Promise((resolve, reject) => this.init = { resolve, reject });
        this.timeout = (_a = config.timeout) !== null && _a !== void 0 ? _a : 3000;
        this.workspace = config.workspace ? config.workspace(this) : new DefaultWorkspace(this);
        if (config.extensions)
            for (let ext of config.extensions) {
                if (Array.isArray(ext) || ext.extension)
                    this.extensions.push(ext);
                else if (ext.editorExtension)
                    this.extensions.push(ext.editorExtension);
            }
    }
    /**
    Whether this client is connected (has a transport).
    */
    get connected() { return !!this.transport; }
    /**
    Connect this client to a server over the given transport. Will
    immediately start the initialization exchange with the server,
    and resolve `this.initializing` (which it also returns) when
    successful.
    */
    connect(transport) {
        if (this.transport)
            this.transport.unsubscribe(this.receiveMessage);
        this.transport = transport;
        transport.subscribe(this.receiveMessage);
        let capabilities = clientCapabilities;
        if (this.config.extensions)
            for (let ext of this.config.extensions) {
                let { clientCapabilities } = ext;
                if (clientCapabilities)
                    capabilities = mergeCapabilities(capabilities, clientCapabilities);
            }
        this.requestInner("initialize", {
            processId: null,
            clientInfo: { name: "@codemirror/lsp-client" },
            rootUri: this.config.rootUri || null,
            capabilities
        }).promise.then(resp => {
            var _a;
            this.serverCapabilities = resp.capabilities;
            let sync = resp.capabilities.textDocumentSync;
            this.supportSync = sync == null ? 0 : typeof sync == "number" ? sync : (_a = sync.change) !== null && _a !== void 0 ? _a : 0;
            transport.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
            this.init.resolve(null);
        }, this.init.reject);
        this.workspace.connected();
        return this;
    }
    /**
    Disconnect the client from the server.
    */
    disconnect() {
        if (this.transport)
            this.transport.unsubscribe(this.receiveMessage);
        this.serverCapabilities = null;
        this.initializing = new Promise((resolve, reject) => this.init = { resolve, reject });
        this.workspace.disconnected();
    }
    /**
    Create a plugin for this client, to add to an editor
    configuration. This extension is necessary to use LSP-related
    functionality exported by this package. The returned extension
    will include the editor
    extensions included in this client's
    [configuration](https://codemirror.net/6/docs/ref/#lsp-client.LSPClientConfig.extensions).
    
    Creating an editor with this plugin will cause
    [`openFile`](https://codemirror.net/6/docs/ref/#lsp-client.Workspace.openFile) to be called on the
    workspace.
    
    By default, the language ID given to the server for this file is
    derived from the editor's language configuration via
    [`Language.name`](https://codemirror.net/6/docs/ref/#language.Language.name). You can pass in
    a specific ID as a third parameter.
    */
    plugin(fileURI, languageID) {
        return [
            lspPlugin.of({ client: this, uri: fileURI, languageID }),
            lspTheme,
            this.extensions
        ];
    }
    /**
    Send a `textDocument/didOpen` notification to the server.
    */
    didOpen(file) {
        this.notification("textDocument/didOpen", {
            textDocument: {
                uri: file.uri,
                languageId: file.languageId,
                text: file.doc.toString(),
                version: file.version
            }
        });
    }
    /**
    Send a `textDocument/didClose` notification to the server.
    */
    didClose(uri) {
        this.notification("textDocument/didClose", { textDocument: { uri } });
    }
    receiveMessage(msg) {
        var _a;
        const value = JSON.parse(msg);
        if ("id" in value && !("method" in value)) {
            let index = this.requests.findIndex(r => r.id == value.id);
            if (index < 0) {
                console.warn(`[lsp] Received a response for non-existent request ${value.id}`);
            }
            else {
                let req = this.requests[index];
                clearTimeout(req.timeout);
                this.requests.splice(index, 1);
                if (value.error)
                    req.reject(value.error);
                else
                    req.resolve(value.result);
            }
        }
        else if (!("id" in value)) {
            let handler = (_a = this.config.notificationHandlers) === null || _a === void 0 ? void 0 : _a[value.method];
            if (handler && handler(this, value.params))
                return;
            if (this.config.extensions)
                for (let ext of this.config.extensions) {
                    let { notificationHandlers } = ext;
                    let handler = notificationHandlers === null || notificationHandlers === void 0 ? void 0 : notificationHandlers[value.method];
                    if (handler && handler(this, value.params))
                        return;
                }
            let deflt = defaultNotificationHandlers[value.method];
            if (deflt)
                deflt(this, value.params);
            else if (this.config.unhandledNotification)
                this.config.unhandledNotification(this, value.method, value.params);
        }
        else {
            let resp = {
                jsonrpc: "2.0",
                id: value.id,
                error: { code: -32601 /* MethodNotFound */, message: "Method not implemented" }
            };
            this.transport.send(JSON.stringify(resp));
        }
    }
    /**
    Make a request to the server. Returns a promise that resolves to
    the response or rejects with a failure message. You'll probably
    want to use types from the `vscode-languageserver-protocol`
    package for the type parameters.
    
    The caller is responsible for
    [synchronizing](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.sync) state before the
    request and correctly handling state drift caused by local
    changes that happend during the request.
    */
    request(method, params) {
        if (!this.transport)
            return Promise.reject(new Error("Client not connected"));
        return this.initializing.then(() => this.requestInner(method, params).promise);
    }
    requestInner(method, params, mapped = false) {
        let id = ++this.nextReqID, data = {
            jsonrpc: "2.0",
            id,
            method,
            params: params
        };
        let req = new Request(id, params, setTimeout(() => this.timeoutRequest(req), this.timeout));
        this.requests.push(req);
        try {
            this.transport.send(JSON.stringify(data));
        }
        catch (e) {
            req.reject(e);
        }
        return req;
    }
    /**
    Send a notification to the server.
    */
    notification(method, params) {
        if (!this.transport)
            return;
        this.initializing.then(() => {
            let data = {
                jsonrpc: "2.0",
                method,
                params: params
            };
            this.transport.send(JSON.stringify(data));
        });
    }
    /**
    Cancel the in-progress request with the given parameter value
    (which is compared by identity).
    */
    cancelRequest(params) {
        let found = this.requests.find(r => r.params === params);
        if (found)
            this.notification("$/cancelRequest", { id: found.id });
    }
    /**
    @internal
    */
    hasCapability(name) {
        return this.serverCapabilities ? !!this.serverCapabilities[name] : null;
    }
    /**
    Create a [workspace mapping](https://codemirror.net/6/docs/ref/#lsp-client.WorkspaceMapping) that
    tracks changes to files in this client's workspace, relative to
    the moment where it was created. Make sure you call
    [`destroy`](https://codemirror.net/6/docs/ref/#lsp-client.WorkspaceMapping.destroy) on the mapping
    when you're done with it.
    */
    workspaceMapping() {
        let mapping = new WorkspaceMapping(this);
        this.activeMappings.push(mapping);
        return mapping;
    }
    /**
    Run the given promise with a [workspace
    mapping](https://codemirror.net/6/docs/ref/#lsp-client.WorkspaceMapping) active. Automatically
    release the mapping when the promise resolves or rejects.
    */
    withMapping(f) {
        let mapping = this.workspaceMapping();
        return f(mapping).finally(() => mapping.destroy());
    }
    /**
    Push any [pending changes](https://codemirror.net/6/docs/ref/#lsp-client.Workspace.syncFiles) in
    the open files to the server. You'll want to call this before
    most types of requests, to make sure the server isn't working
    with outdated information.
    */
    sync() {
        for (let { file, changes, prevDoc } of this.workspace.syncFiles()) {
            for (let mapping of this.activeMappings)
                mapping.addChanges(file.uri, changes);
            if (this.supportSync)
                this.notification("textDocument/didChange", {
                    textDocument: { uri: file.uri, version: file.version },
                    contentChanges: contentChangesFor(file, prevDoc, changes, this.supportSync == 2 /* Incremental */)
                });
        }
    }
    timeoutRequest(req) {
        let index = this.requests.indexOf(req);
        if (index > -1) {
            req.reject(new Error("Request timed out"));
            this.requests.splice(index, 1);
        }
    }
}
function contentChangesFor(file, startDoc, changes, supportInc) {
    if (!supportInc || file.doc.length < 1024 /* Sync.AlwaysIfSmaller */)
        return [{ text: file.doc.toString() }];
    let events = [];
    changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        events.push({
            range: { start: toPosition(startDoc, fromA), end: toPosition(startDoc, toA) },
            text: inserted.toString()
        });
    });
    return events.reverse();
}
function mergeCapabilities(base, add) {
    if (add == null)
        return base;
    if (typeof base != "object" || typeof add != "object")
        return add;
    let result = {};
    let baseProps = Object.keys(base), addProps = Object.keys(add);
    for (let prop of baseProps)
        result[prop] = addProps.indexOf(prop) > -1 ? mergeCapabilities(base[prop], add[prop]) : base[prop];
    for (let prop of addProps)
        if (baseProps.indexOf(prop) < 0)
            result[prop] = add[prop];
    return result;
}

// Convert from LSP's snippet syntax to @codemirror/autocompletion's
// one. Remove backslashes before `$}]`, which don't support backslash
// escapes in CodeMirror, and expand `$1` to `${1}`.
function lspToSnippet(text) {
    return text.replace(/\\([$}\\])|\$(\d+)/g, (_m, esc, field) => esc || `\${${field}}`);
}
/**
Register the [language server completion
source](https://codemirror.net/6/docs/ref/#lsp-client.serverCompletionSource) as an autocompletion
source.
*/
function serverCompletion(config = {}) {
    let result;
    if (config.override) {
        result = [autocompletion({ override: [serverCompletionSource] })];
    }
    else {
        let data = [{ autocomplete: serverCompletionSource }];
        result = [autocompletion(), EditorState.languageData.of(() => data)];
    }
    if (config.validFor)
        result.push(completionConfig.of({ validFor: config.validFor }));
    return result;
}
const completionConfig = /*@__PURE__*/Facet.define({
    combine: results => results.length ? results[0] : { validFor: null }
});
function getCompletions(plugin, pos, context, abort) {
    if (plugin.client.hasCapability("completionProvider") === false)
        return Promise.resolve(null);
    plugin.client.sync();
    let params = {
        position: plugin.toPosition(pos),
        textDocument: { uri: plugin.uri },
        context
    };
    if (abort)
        abort.addEventListener("abort", () => plugin.client.cancelRequest(params));
    return plugin.client.request("textDocument/completion", params);
}
// Look for non-alphanumeric prefixes in the completions, and return a
// regexp that matches them, to use in validFor
function prefixRegexp(items) {
    var _a;
    let step = Math.ceil(items.length / 50), prefixes = [];
    for (let i = 0; i < items.length; i += step) {
        let item = items[i], text = ((_a = item.textEdit) === null || _a === void 0 ? void 0 : _a.newText) || item.textEditText || item.insertText || item.label;
        if (!/^\w/.test(text)) {
            let prefix = /^[^\w]*/.exec(text)[0];
            if (prefixes.indexOf(prefix) < 0)
                prefixes.push(prefix);
        }
    }
    if (!prefixes.length)
        return /^\w*$/;
    return new RegExp("^(?:" + prefixes.map(RegExp.escape || (s => s.replace(/[^\w\s]/g, "\\$&"))).join("|") + ")?\\w*$");
}
function shouldTriggerCompletion(plugin, character) {
    var _a, _b;
    let triggers = (_b = (_a = plugin.client.serverCapabilities) === null || _a === void 0 ? void 0 : _a.completionProvider) === null || _b === void 0 ? void 0 : _b.triggerCharacters;
    if (triggers && triggers.indexOf(character) > -1)
        return "triggerCharacter";
    if (/[a-zA-Z_]/.test(character))
        return "identifier";
    return null;
}
function resultMapper(changes, extraEdits) {
    return (result, newChanges) => {
        changes = changes ? changes.composeDesc(newChanges) : newChanges;
        let options = result.options.slice();
        for (let { index, edits, text } of extraEdits)
            options[index] = Object.assign(Object.assign({}, options[index]), { apply: applyEdits(edits, text, changes) });
        return Object.assign(Object.assign({}, result), { options, map: resultMapper(changes, extraEdits) });
    };
}
function applyEdits(edits, text, mapped) {
    return (view, completion, from, to) => {
        let base = insertCompletionText(view.state, text, from, to);
        let changes = [];
        for (let { from, to, text } of edits) {
            if (mapped) {
                if (mapped.touchesRange(from, to))
                    continue;
                let len = to - from;
                from = mapped.mapPos(from, 1);
                to = from + len;
            }
            changes.push({ from, to, insert: text });
        }
        view.dispatch(base, { changes });
    };
}
// TypeScript defers auto-import edits until completionItem/resolve. Resolve only
// the accepted item so large completion lists don't create hundreds of requests.
function applyResolvedItem(plugin, item, fallbackText) {
    return (view, completion, from, to) => {
        const startDoc = view.state.doc;
        plugin.client.request("completionItem/resolve", item).then(resolved => {
            var _a;
            if (view.state.doc != startDoc)
                return;
            const text = ((_a = resolved.textEdit) === null || _a === void 0 ? void 0 : _a.newText) || resolved.insertText || fallbackText;
            const edits = [];
            for (let edit of resolved.additionalTextEdits || []) {
                const editFrom = fromPositionChecked(view.state.doc, edit.range.start);
                const editTo = fromPositionChecked(view.state.doc, edit.range.end);
                if (editFrom != null && editTo != null)
                    edits.push({ from: editFrom, to: editTo, text: edit.newText });
            }
            if (resolved.insertTextFormat == 2 /* Snippet */ && edits.length) {
                const transaction = view.state.update({ changes: edits });
                const mappedFrom = transaction.changes.mapPos(from, 1);
                const mappedTo = transaction.changes.mapPos(to, -1);
                view.dispatch(transaction);
                snippet(lspToSnippet(text))(view, completion, mappedFrom, mappedTo);
            }
            else if (resolved.insertTextFormat == 2 /* Snippet */) {
                snippet(lspToSnippet(text))(view, completion, from, to);
            }
            else {
                applyEdits(edits, text, null)(view, completion, from, to);
            }
        }, () => {
            if (view.state.doc == startDoc)
                applyEdits([], fallbackText, null)(view, completion, from, to);
        });
    };
}
/**
A completion source that requests completions from a language
server.
*/
const serverCompletionSource = context => {
    const plugin = context.view && LSPPlugin.get(context.view);
    if (!plugin)
        return null;
    let triggerChar = context.state.sliceDoc(context.pos - 1, context.pos);
    let triggerReason = context.explicit ? "invoked" : shouldTriggerCompletion(plugin, triggerChar);
    if (!triggerReason)
        return null;
    let completionContext = triggerReason == "triggerCharacter"
        ? { triggerKind: 2 /* TriggerCharacter */, triggerCharacter: triggerChar }
        : { triggerKind: 1 /* Invoked */ };
    return getCompletions(plugin, context.pos, completionContext, context).then(result => {
        var _a, _b;
        if (!result)
            return null;
        if (Array.isArray(result))
            result = { items: result };
        let { from, to } = completionResultRange(context, result);
        let defaultCommitChars = (_a = result.itemDefaults) === null || _a === void 0 ? void 0 : _a.commitCharacters;
        let config = context.state.facet(completionConfig);
        let extraEdits = [];
        return {
            from, to,
            options: result.items.map((item, i) => {
                var _a, _b, _c, _d;
                let text = ((_a = item.textEdit) === null || _a === void 0 ? void 0 : _a.newText) || item.textEditText || item.insertText || item.label;
                let option = {
                    label: item.filterText || item.label,
                    displayLabel: item.label,
                    type: item.kind && kindToType[item.kind],
                };
                let insertTextFormat = (_b = item.insertTextFormat) !== null && _b !== void 0 ? _b : (_c = result.itemDefaults) === null || _c === void 0 ? void 0 : _c.insertTextFormat;
                if (item.commitCharacters && item.commitCharacters != defaultCommitChars)
                    option.commitCharacters = item.commitCharacters;
                if (item.detail)
                    option.detail = item.detail;
                if (item.sortText)
                    option.sortText = item.sortText;
                const completionProvider = (_d = plugin.client.serverCapabilities) === null || _d === void 0 ? void 0 : _d.completionProvider;
                const canResolve = typeof completionProvider == "object" && completionProvider.resolveProvider;
                if (canResolve && item.data != null && item.detail != null && !item.additionalTextEdits) {
                    option.apply = applyResolvedItem(plugin, item, text);
                }
                else if (insertTextFormat == 2 /* Snippet */) {
                    option.apply = (view, c, from, to) => snippet(lspToSnippet(text))(view, c, from, to);
                }
                else if (item.additionalTextEdits) {
                    let edits = [];
                    for (let edit of item.additionalTextEdits) {
                        let from = fromPositionChecked(context.state.doc, edit.range.start);
                        let to = fromPositionChecked(context.state.doc, edit.range.end);
                        if (from != null && to != null)
                            edits.push({ from, to, text: edit.newText });
                    }
                    extraEdits.push({ index: i, text, edits });
                    option.apply = applyEdits(edits, text, null);
                }
                else if (option.label != text) {
                    option.apply = text;
                }
                if (item.documentation)
                    option.info = () => renderDocInfo(plugin, item.documentation);
                return option;
            }),
            commitCharacters: defaultCommitChars,
            validFor: result.isIncomplete ? undefined : ((_b = config.validFor) !== null && _b !== void 0 ? _b : prefixRegexp(result.items)),
            map: extraEdits.length ? resultMapper(null, extraEdits) : undefined
        };
    }, err => {
        if ("code" in err && err.code == -32800 /* RequestCancelled */)
            return null;
        throw err;
    });
};
function completionResultRange(cx, result) {
    var _a;
    if (!result.items.length)
        return { from: cx.pos, to: cx.pos };
    let defaultRange = (_a = result.itemDefaults) === null || _a === void 0 ? void 0 : _a.editRange, item0 = result.items[0];
    let range = defaultRange ? ("insert" in defaultRange ? defaultRange.insert : defaultRange)
        : item0.textEdit ? ("range" in item0.textEdit ? item0.textEdit.range : item0.textEdit.insert)
            : null;
    if (!range)
        return cx.state.wordAt(cx.pos) || { from: cx.pos, to: cx.pos };
    let line = cx.state.doc.lineAt(cx.pos);
    return { from: line.from + range.start.character, to: line.from + range.end.character };
}
function renderDocInfo(plugin, doc) {
    let elt = document.createElement("div");
    elt.className = "cm-lsp-documentation cm-lsp-completion-documentation";
    elt.innerHTML = plugin.docToHTML(doc);
    return elt;
}
const kindToType = {
    1: "text", // Text
    2: "method", // Method
    3: "function", // Function
    4: "class", // Constructor
    5: "property", // Field
    6: "variable", // Variable
    7: "class", // Class
    8: "interface", // Interface
    9: "namespace", // Module
    10: "property", // Property
    11: "keyword", // Unit
    12: "constant", // Value
    13: "constant", // Enum
    14: "keyword", // Keyword
    16: "constant", // Color
    20: "constant", // EnumMember
    21: "constant", // Constant
    22: "class", // Struct
    25: "type" // TypeParameter
};

/**
Create an extension that queries the language server for hover
tooltips when the user hovers over the code with their pointer,
and displays a tooltip when the server provides one.
*/
function hoverTooltips(config = {}) {
    return hoverTooltip(lspTooltipSource, {
        hideOn: tr => tr.docChanged,
        hoverTime: config.hoverTime
    });
}
function hoverRequest(plugin, pos) {
    if (plugin.client.hasCapability("hoverProvider") === false)
        return Promise.resolve(null);
    plugin.client.sync();
    return plugin.client.request("textDocument/hover", {
        position: plugin.toPosition(pos),
        textDocument: { uri: plugin.uri },
    });
}
function lspTooltipSource(view, pos) {
    const plugin = LSPPlugin.get(view);
    if (!plugin)
        return Promise.resolve(null);
    return hoverRequest(plugin, pos).then(result => {
        if (!result)
            return null;
        return {
            pos: result.range ? fromPosition(view.state.doc, result.range.start) : pos,
            end: result.range ? fromPosition(view.state.doc, result.range.end) : pos,
            create() {
                let elt = document.createElement("div");
                elt.className = "cm-lsp-hover-tooltip cm-lsp-documentation";
                elt.innerHTML = renderTooltipContent(plugin, result.contents);
                return { dom: elt };
            },
            above: true
        };
    });
}
function renderTooltipContent(plugin, value) {
    if (Array.isArray(value))
        return value.map(m => renderCode(plugin, m)).join("<br>");
    if (typeof value == "string" || typeof value == "object" && "language" in value)
        return renderCode(plugin, value);
    return plugin.docToHTML(value);
}
function renderCode(plugin, code) {
    if (typeof code == "string")
        return plugin.docToHTML(code, "markdown");
    let { language: language$1, value } = code;
    let lang = plugin.client.config.highlightLanguage && plugin.client.config.highlightLanguage(language$1 || "");
    if (!lang) {
        let viewLang = plugin.view.state.facet(language);
        if (viewLang && (!language$1 || viewLang.name == language$1))
            lang = viewLang;
    }
    if (!lang)
        return escHTML(value);
    let result = "";
    highlightCode(value, lang.parser.parse(value), { style: tags => highlightingFor(plugin.view.state, tags) }, (text, cls) => {
        result += cls ? `<span class="${cls}">${escHTML(text)}</span>` : escHTML(text);
    }, () => {
        result += "<br>";
    });
    return result;
}

function getFormatting(plugin, options) {
    return plugin.client.request("textDocument/formatting", {
        options,
        textDocument: { uri: plugin.uri },
    });
}
/**
This command asks the language server to reformat the document,
and then applies the changes it returns.
*/
const formatDocument = view => {
    const plugin = LSPPlugin.get(view);
    if (!plugin)
        return false;
    plugin.client.sync();
    plugin.client.withMapping(mapping => getFormatting(plugin, {
        tabSize: getIndentUnit(view.state),
        insertSpaces: view.state.facet(indentUnit).indexOf("\t") < 0,
    }).then(response => {
        if (!response)
            return;
        let changed = mapping.getMapping(plugin.uri);
        let changes = [];
        for (let change of response) {
            let from = mapping.mapPosition(plugin.uri, change.range.start);
            let to = mapping.mapPosition(plugin.uri, change.range.end);
            if (changed) {
                // Don't try to apply the changes if code inside of any of them was touched
                if (changed.touchesRange(from, to))
                    return;
                from = changed.mapPos(from, 1);
                to = changed.mapPos(to, -1);
            }
            changes.push({ from, to, insert: change.newText });
        }
        view.dispatch({
            changes,
            userEvent: "format"
        });
    }, err => {
        plugin.reportError("Formatting request failed", err);
    }));
    return true;
};
/**
A keymap that binds Shift-Alt-f to
[`formatDocument`](https://codemirror.net/6/docs/ref/#lsp-client.formatDocument).
*/
const formatKeymap = [
    { key: "Shift-Alt-f", run: formatDocument, preventDefault: true }
];

function getRename(plugin, pos, newName) {
    return plugin.client.request("textDocument/rename", {
        newName,
        position: plugin.toPosition(pos),
        textDocument: { uri: plugin.uri },
    });
}
/**
This command will, if the cursor is over a word, prompt the user
for a new name for that symbol, and ask the language server to
perform a rename of that symbol.

Note that this may affect files other than the one loaded into
this view. See the
[`Workspace.updateFile`](https://codemirror.net/6/docs/ref/#lsp-client.Workspace.updateFile)
method.
*/
const renameSymbol = view => {
    let wordRange = view.state.wordAt(view.state.selection.main.head);
    let plugin = LSPPlugin.get(view);
    if (!wordRange || !plugin || plugin.client.hasCapability("renameProvider") === false)
        return false;
    const word = view.state.sliceDoc(wordRange.from, wordRange.to);
    let panel = getDialog(view, "cm-lsp-rename-panel");
    if (panel) {
        let input = panel.dom.querySelector("[name=name]");
        input.value = word;
        input.select();
    }
    else {
        let { close, result } = showDialog(view, {
            label: view.state.phrase("New name"),
            input: { name: "name", value: word },
            focus: true,
            submitLabel: view.state.phrase("rename"),
            class: "cm-lsp-rename-panel",
        });
        result.then(form => {
            view.dispatch({ effects: close });
            if (form)
                doRename(view, form.elements.namedItem("name").value);
        });
    }
    return true;
};
function doRename(view, newName) {
    const plugin = LSPPlugin.get(view);
    const word = view.state.wordAt(view.state.selection.main.head);
    if (!plugin || !word)
        return false;
    plugin.client.sync();
    plugin.client.withMapping(mapping => getRename(plugin, word.from, newName).then(response => {
        if (!response)
            return;
        for (let uri in response.changes) {
            let lspChanges = response.changes[uri], file = plugin.client.workspace.getFile(uri);
            if (!lspChanges.length || !file)
                continue;
            plugin.client.workspace.updateFile(uri, {
                changes: lspChanges.map(change => ({
                    from: mapping.mapPosition(uri, change.range.start),
                    to: mapping.mapPosition(uri, change.range.end),
                    insert: change.newText
                })),
                userEvent: "rename"
            });
        }
    }, err => {
        plugin.reportError("Rename request failed", err);
    }));
}
/**
A keymap that binds F2 to [`renameSymbol`](https://codemirror.net/6/docs/ref/#lsp-client.renameSymbol).
*/
const renameKeymap = [
    { key: "F2", run: renameSymbol, preventDefault: true }
];

function getSignatureHelp(plugin, pos, context) {
    if (plugin.client.hasCapability("signatureHelpProvider") === false)
        return Promise.resolve(null);
    plugin.client.sync();
    return plugin.client.request("textDocument/signatureHelp", {
        context,
        position: plugin.toPosition(pos),
        textDocument: { uri: plugin.uri },
    });
}
const signaturePlugin = /*@__PURE__*/ViewPlugin.fromClass(class {
    constructor() {
        this.activeRequest = null;
        this.delayedRequest = 0;
    }
    update(update) {
        var _a;
        if (this.activeRequest) {
            if (update.selectionSet) {
                this.activeRequest.drop = true;
                this.activeRequest = null;
            }
            else if (update.docChanged) {
                this.activeRequest.pos = update.changes.mapPos(this.activeRequest.pos);
            }
        }
        const plugin = LSPPlugin.get(update.view);
        if (!plugin)
            return;
        const sigState = update.view.state.field(signatureState);
        let triggerCharacter = "";
        if (update.docChanged && update.transactions.some(tr => tr.isUserEvent("input.type"))) {
            const serverConf = (_a = plugin.client.serverCapabilities) === null || _a === void 0 ? void 0 : _a.signatureHelpProvider;
            const triggers = ((serverConf === null || serverConf === void 0 ? void 0 : serverConf.triggerCharacters) || []).concat(sigState && (serverConf === null || serverConf === void 0 ? void 0 : serverConf.retriggerCharacters) || []);
            if (triggers) {
                update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                    let ins = inserted.toString();
                    if (ins)
                        for (let ch of triggers) {
                            if (ins.indexOf(ch) > -1)
                                triggerCharacter = ch;
                        }
                });
            }
        }
        if (triggerCharacter) {
            this.startRequest(plugin, {
                triggerKind: 2 /* TriggerCharacter */,
                isRetrigger: !!sigState,
                triggerCharacter,
                activeSignatureHelp: sigState ? sigState.data : undefined
            });
        }
        else if (sigState && update.selectionSet) {
            if (this.delayedRequest)
                clearTimeout(this.delayedRequest);
            this.delayedRequest = setTimeout(() => {
                this.startRequest(plugin, {
                    triggerKind: 3 /* ContentChange */,
                    isRetrigger: true,
                    activeSignatureHelp: sigState.data,
                });
            }, 250);
        }
    }
    startRequest(plugin, context) {
        if (this.delayedRequest)
            clearTimeout(this.delayedRequest);
        let { view } = plugin, pos = view.state.selection.main.head;
        if (this.activeRequest)
            this.activeRequest.drop = true;
        let req = this.activeRequest = { pos, drop: false };
        getSignatureHelp(plugin, pos, context).then(result => {
            var _a;
            if (req.drop)
                return;
            if (result && result.signatures.length) {
                let cur = view.state.field(signatureState);
                let same = cur && sameSignatures(cur.data, result);
                let active = same && context.triggerKind == 3 ? cur.active : (_a = result.activeSignature) !== null && _a !== void 0 ? _a : 0;
                // Don't update at all if nothing changed
                if (same && sameActiveParam(cur.data, result, active))
                    return;
                view.dispatch({ effects: signatureEffect.of({
                        data: result,
                        active,
                        pos: same ? cur.tooltip.pos : req.pos
                    }) });
            }
            else if (view.state.field(signatureState)) {
                view.dispatch({ effects: signatureEffect.of(null) });
            }
        }, context.triggerKind == 1 /* Invoked */ ? err => plugin.reportError("Signature request failed", err) : undefined);
    }
    destroy() {
        if (this.delayedRequest)
            clearTimeout(this.delayedRequest);
        if (this.activeRequest)
            this.activeRequest.drop = true;
    }
});
function sameSignatures(a, b) {
    if (a.signatures.length != b.signatures.length)
        return false;
    return a.signatures.every((s, i) => s.label == b.signatures[i].label);
}
function sameActiveParam(a, b, active) {
    var _a, _b;
    return ((_a = a.signatures[active].activeParameter) !== null && _a !== void 0 ? _a : a.activeParameter) ==
        ((_b = b.signatures[active].activeParameter) !== null && _b !== void 0 ? _b : b.activeParameter);
}
class SignatureState {
    constructor(data, active, tooltip) {
        this.data = data;
        this.active = active;
        this.tooltip = tooltip;
    }
}
const signatureState = /*@__PURE__*/StateField.define({
    create() { return null; },
    update(sig, tr) {
        for (let e of tr.effects)
            if (e.is(signatureEffect)) {
                if (e.value) {
                    return new SignatureState(e.value.data, e.value.active, signatureTooltip(e.value.data, e.value.active, e.value.pos));
                }
                else {
                    return null;
                }
            }
        if (sig && tr.docChanged)
            return new SignatureState(sig.data, sig.active, Object.assign(Object.assign({}, sig.tooltip), { pos: tr.changes.mapPos(sig.tooltip.pos) }));
        return sig;
    },
    provide: f => showTooltip.from(f, sig => sig && sig.tooltip)
});
const signatureEffect = /*@__PURE__*/StateEffect.define();
function signatureTooltip(data, active, pos) {
    return {
        pos,
        above: true,
        create: view => drawSignatureTooltip(view, data, active)
    };
}
function drawSignatureTooltip(view, data, active) {
    var _a;
    let dom = document.createElement("div");
    dom.className = "cm-lsp-signature-tooltip";
    if (data.signatures.length > 1) {
        dom.classList.add("cm-lsp-signature-multiple");
        let num = dom.appendChild(document.createElement("div"));
        num.className = "cm-lsp-signature-num";
        num.textContent = `${active + 1}/${data.signatures.length}`;
    }
    let signature = data.signatures[active];
    let sig = dom.appendChild(document.createElement("div"));
    sig.className = "cm-lsp-signature";
    let activeFrom = 0, activeTo = 0;
    let activeN = (_a = signature.activeParameter) !== null && _a !== void 0 ? _a : data.activeParameter;
    let activeParam = activeN != null && signature.parameters ? signature.parameters[activeN] : null;
    if (activeParam && Array.isArray(activeParam.label)) {
        [activeFrom, activeTo] = activeParam.label;
    }
    else if (activeParam) {
        let found = signature.label.indexOf(activeParam.label);
        if (found > -1) {
            activeFrom = found;
            activeTo = found + activeParam.label.length;
        }
    }
    if (activeTo) {
        sig.appendChild(document.createTextNode(signature.label.slice(0, activeFrom)));
        let activeElt = sig.appendChild(document.createElement("span"));
        activeElt.className = "cm-lsp-active-parameter";
        activeElt.textContent = signature.label.slice(activeFrom, activeTo);
        sig.appendChild(document.createTextNode(signature.label.slice(activeTo)));
    }
    else {
        sig.textContent = signature.label;
    }
    if (signature.documentation) {
        let plugin = LSPPlugin.get(view);
        if (plugin) {
            let docs = dom.appendChild(document.createElement("div"));
            docs.className = "cm-lsp-signature-documentation cm-lsp-documentation";
            docs.innerHTML = plugin.docToHTML(signature.documentation);
        }
    }
    return { dom };
}
/**
Explicitly prompt the server to provide signature help at the
cursor.
*/
const showSignatureHelp = view => {
    let plugin = view.plugin(signaturePlugin);
    if (!plugin) {
        view.dispatch({ effects: StateEffect.appendConfig.of([signatureState, signaturePlugin]) });
        plugin = view.plugin(signaturePlugin);
    }
    let field = view.state.field(signatureState);
    if (!plugin || field === undefined)
        return false;
    let lspPlugin = LSPPlugin.get(view);
    if (!lspPlugin)
        return false;
    plugin.startRequest(lspPlugin, {
        triggerKind: 1 /* Invoked */,
        activeSignatureHelp: field ? field.data : undefined,
        isRetrigger: !!field
    });
    return true;
};
/**
If there is an active signature tooltip with multiple signatures,
move to the next one.
*/
const nextSignature = view => {
    let field = view.state.field(signatureState);
    if (!field)
        return false;
    if (field.active < field.data.signatures.length - 1)
        view.dispatch({ effects: signatureEffect.of({ data: field.data, active: field.active + 1, pos: field.tooltip.pos }) });
    return true;
};
/**
If there is an active signature tooltip with multiple signatures,
move to the previous signature.
*/
const prevSignature = view => {
    let field = view.state.field(signatureState);
    if (!field)
        return false;
    if (field.active > 0)
        view.dispatch({ effects: signatureEffect.of({ data: field.data, active: field.active - 1, pos: field.tooltip.pos }) });
    return true;
};
/**
A keymap that binds

- Ctrl-Shift-Space (Cmd-Shift-Space on macOS) to
  [`showSignatureHelp`](https://codemirror.net/6/docs/ref/#lsp-client.showSignatureHelp)

- Ctrl-Shift-ArrowUp (Cmd-Shift-ArrowUp on macOS) to
  [`prevSignature`](https://codemirror.net/6/docs/ref/#lsp-client.prevSignature)

- Ctrl-Shift-ArrowDown (Cmd-Shift-ArrowDown on macOS) to
  [`nextSignature`](https://codemirror.net/6/docs/ref/#lsp-client.nextSignature)

Note that these keys are automatically bound by
[`signatureHelp`](https://codemirror.net/6/docs/ref/#lsp-client.signatureHelp) unless you pass it
`keymap: false`.
*/
const signatureKeymap = [
    { key: "Mod-Shift-Space", run: showSignatureHelp },
    { key: "Mod-Shift-ArrowUp", run: prevSignature },
    { key: "Mod-Shift-ArrowDown", run: nextSignature },
];
/**
Returns an extension that enables signature help. Will bind the
keys in [`signatureKeymap`](https://codemirror.net/6/docs/ref/#lsp-client.signatureKeymap) unless
`keymap` is set to `false`.
*/
function signatureHelp(config = {}) {
    return [
        signatureState,
        signaturePlugin,
        config.keymap === false ? [] : Prec.high(keymap.of(signatureKeymap))
    ];
}

function getDefinition(plugin, pos) {
    return plugin.client.request("textDocument/definition", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(pos)
    });
}
function getDeclaration(plugin, pos) {
    return plugin.client.request("textDocument/declaration", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(pos)
    });
}
function getTypeDefinition(plugin, pos) {
    return plugin.client.request("textDocument/typeDefinition", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(pos)
    });
}
function getImplementation(plugin, pos) {
    return plugin.client.request("textDocument/implementation", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(pos)
    });
}
function jumpToOrigin(view, type) {
    const plugin = LSPPlugin.get(view);
    if (!plugin || plugin.client.hasCapability(type.capability) === false)
        return false;
    plugin.client.sync();
    plugin.client.withMapping(mapping => type.get(plugin, view.state.selection.main.head).then(response => {
        let loc = Array.isArray(response) ? response[0] : response;
        if (!loc)
            return;
        return (loc.uri == plugin.uri ? Promise.resolve(view) : plugin.client.workspace.displayFile(loc.uri)).then(target => {
            if (!target)
                return;
            let pos = mapping.getMapping(loc.uri) ? mapping.mapPosition(loc.uri, loc.range.start)
                : plugin.fromPosition(loc.range.start, target.state.doc);
            target.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: "select.definition" });
        });
    }, error => plugin.reportError("Find definition failed", error)));
    return true;
}
/**
Jump to the definition of the symbol at the cursor. To support
cross-file jumps, you'll need to implement
[`Workspace.displayFile`](https://codemirror.net/6/docs/ref/#lsp-client.Workspace.displayFile).
*/
const jumpToDefinition = view => jumpToOrigin(view, {
    get: getDefinition,
    capability: "definitionProvider"
});
/**
Jump to the declaration of the symbol at the cursor.
*/
const jumpToDeclaration = view => jumpToOrigin(view, {
    get: getDeclaration,
    capability: "declarationProvider"
});
/**
Jump to the type definition of the symbol at the cursor.
*/
const jumpToTypeDefinition = view => jumpToOrigin(view, {
    get: getTypeDefinition,
    capability: "typeDefinitionProvider"
});
/**
Jump to the implementation of the symbol at the cursor.
*/
const jumpToImplementation = view => jumpToOrigin(view, {
    get: getImplementation,
    capability: "implementationProvider"
});
/**
Binds F12 to [`jumpToDefinition`](https://codemirror.net/6/docs/ref/#lsp-client.jumpToDefinition).
*/
const jumpToDefinitionKeymap = [
    { key: "F12", run: jumpToDefinition, preventDefault: true },
];

function getReferences(plugin, pos) {
    return plugin.client.request("textDocument/references", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(pos),
        context: { includeDeclaration: true }
    });
}
/**
Ask the server to locate all references to the symbol at the
cursor. When the server can provide such references, show them as
a list in a panel.
*/
const findReferences = view => {
    const plugin = LSPPlugin.get(view);
    if (!plugin || plugin.client.hasCapability("referencesProvider") === false)
        return false;
    plugin.client.sync();
    let mapping = plugin.client.workspaceMapping(), passedMapping = false;
    getReferences(plugin, view.state.selection.main.head).then(response => {
        if (!response)
            return;
        return Promise.all(response.map(loc => plugin.client.workspace.requestFile(loc.uri).then(file => {
            return file ? { file, range: loc.range } : null;
        }))).then(resolved => {
            let locs = resolved.filter(l => l);
            if (locs.length) {
                displayReferences(plugin.view, locs, mapping);
                passedMapping = true;
            }
        });
    }, err => plugin.reportError("Finding references failed", err)).finally(() => {
        if (!passedMapping)
            mapping.destroy();
    });
    return true;
};
/**
Close the reference panel, if it is open.
*/
const closeReferencePanel = view => {
    if (!view.state.field(referencePanel, false))
        return false;
    view.dispatch({ effects: setReferencePanel.of(null) });
    return true;
};
const referencePanel = /*@__PURE__*/StateField.define({
    create() { return null; },
    update(panel, tr) {
        for (let e of tr.effects)
            if (e.is(setReferencePanel))
                return e.value;
        return panel;
    },
    provide: f => showPanel.from(f)
});
const setReferencePanel = /*@__PURE__*/StateEffect.define();
function displayReferences(view, locs, mapping) {
    let panel = createReferencePanel(locs, mapping);
    let effect = view.state.field(referencePanel, false) === undefined
        ? StateEffect.appendConfig.of(referencePanel.init(() => panel))
        : setReferencePanel.of(panel);
    view.dispatch({ effects: effect });
}
function createReferencePanel(locs, mapping) {
    let created = false;
    // Make sure that if this panel isn't used, the mapping still gets destroyed
    setTimeout(() => { if (!created)
        mapping.destroy(); }, 500);
    return view => {
        created = true;
        let prefixLen = findCommonPrefix(locs.map(l => l.file.uri));
        let panel = document.createElement("div"), curFile = null;
        panel.className = "cm-lsp-reference-panel";
        panel.tabIndex = 0;
        panel.role = "listbox";
        panel.setAttribute("aria-label", view.state.phrase("Reference list"));
        let options = [];
        for (let { file, range } of locs) {
            let fileName = file.uri.slice(prefixLen);
            if (fileName != curFile) {
                curFile = fileName;
                let header = panel.appendChild(document.createElement("div"));
                header.className = "cm-lsp-reference-file";
                header.textContent = fileName;
            }
            let entry = panel.appendChild(document.createElement("div"));
            entry.className = "cm-lsp-reference";
            entry.role = "option";
            let from = mapping.mapPosition(file.uri, range.start, 1), to = mapping.mapPosition(file.uri, range.end, -1);
            let view = file.getView(), line = (view ? view.state.doc : file.doc).lineAt(from);
            let lineNumber = entry.appendChild(document.createElement("span"));
            lineNumber.className = "cm-lsp-reference-line";
            lineNumber.textContent = (line.number + ": ").padStart(5, " ");
            let textBefore = line.text.slice(Math.max(0, from - line.from - 50), from - line.from);
            if (textBefore)
                entry.appendChild(document.createTextNode(textBefore));
            entry.appendChild(document.createElement("strong")).textContent = line.text.slice(from - line.from, to - line.from);
            let textAfter = line.text.slice(to - line.from, Math.min(line.length, 100 - textBefore.length));
            if (textAfter)
                entry.appendChild(document.createTextNode(textAfter));
            if (!options.length)
                entry.setAttribute("aria-selected", "true");
            options.push(entry);
        }
        function curSelection() {
            for (let i = 0; i < options.length; i++) {
                if (options[i].hasAttribute("aria-selected"))
                    return i;
            }
            return 0;
        }
        function setSelection(index) {
            for (let i = 0; i < options.length; i++) {
                if (i == index)
                    options[i].setAttribute("aria-selected", "true");
                else
                    options[i].removeAttribute("aria-selected");
            }
        }
        function showReference(index) {
            let { file, range } = locs[index];
            let plugin = LSPPlugin.get(view);
            if (!plugin)
                return;
            Promise.resolve(file.uri == plugin.uri ? view : plugin.client.workspace.displayFile(file.uri)).then(view => {
                if (!view)
                    return;
                let pos = mapping.mapPosition(file.uri, range.start, 1);
                view.focus();
                view.dispatch({
                    selection: { anchor: pos },
                    scrollIntoView: true
                });
            });
        }
        panel.addEventListener("keydown", event => {
            if (event.keyCode == 27) { // Escape
                closeReferencePanel(view);
                view.focus();
            }
            else if (event.keyCode == 38 || event.keyCode == 33) { // ArrowUp, PageUp
                setSelection((curSelection() - 1 + locs.length) % locs.length);
            }
            else if (event.keyCode == 40 || event.keyCode == 34) { // ArrowDown, PageDown
                setSelection((curSelection() + 1) % locs.length);
            }
            else if (event.keyCode == 36) { // Home
                setSelection(0);
            }
            else if (event.keyCode == 35) { // End
                setSelection(options.length - 1);
            }
            else if (event.keyCode == 13 || event.keyCode == 10) { // Enter, Space
                showReference(curSelection());
            }
            else {
                return;
            }
            event.preventDefault();
        });
        panel.addEventListener("click", event => {
            for (let i = 0; i < options.length; i++) {
                if (options[i].contains(event.target)) {
                    setSelection(i);
                    showReference(i);
                    event.preventDefault();
                }
            }
        });
        let dom = document.createElement("div");
        dom.appendChild(panel);
        let close = dom.appendChild(document.createElement("button"));
        close.className = "cm-dialog-close";
        close.textContent = "×";
        close.addEventListener("click", () => closeReferencePanel(view));
        close.setAttribute("aria-label", view.state.phrase("close"));
        return {
            dom,
            destroy: () => mapping.destroy(),
            mount: () => panel.focus(),
        };
    };
}
function findCommonPrefix(uris) {
    let first = uris[0], prefix = first.length;
    for (let i = 1; i < uris.length; i++) {
        let uri = uris[i], j = 0;
        for (let e = Math.min(prefix, uri.length); j < e && first[j] == uri[j]; j++) { }
        prefix = j;
    }
    while (prefix && first[prefix - 1] != "/")
        prefix--;
    return prefix;
}
/**
Binds Shift-F12 to [`findReferences`](https://codemirror.net/6/docs/ref/#lsp-client.findReferences)
and Escape to
[`closeReferencePanel`](https://codemirror.net/6/docs/ref/#lsp-client.closeReferencePanel).
*/
const findReferencesKeymap = [
    { key: "Shift-F12", run: findReferences, preventDefault: true },
    { key: "Escape", run: closeReferencePanel },
];

function toSeverity(sev) {
    return sev == 1 ? "error" : sev == 2 ? "warning" : sev == 3 ? "info" : "hint";
}
const autoSync = /*@__PURE__*/ViewPlugin.fromClass(class {
    constructor() {
        this.pending = -1;
    }
    update(update) {
        if (update.docChanged) {
            if (this.pending > -1)
                clearTimeout(this.pending);
            this.pending = setTimeout(() => {
                this.pending = -1;
                let plugin = LSPPlugin.get(update.view);
                if (plugin)
                    plugin.client.sync();
            }, 500);
        }
    }
    destroy() {
        if (this.pending > -1)
            clearTimeout(this.pending);
    }
});
function serverDiagnostics() {
    return {
        clientCapabilities: { textDocument: { publishDiagnostics: { versionSupport: true } } },
        notificationHandlers: {
            "textDocument/publishDiagnostics": (client, params) => {
                let file = client.workspace.getFile(params.uri);
                if (!file || params.version != null && params.version != file.version)
                    return false;
                const view = file.getView(), plugin = view && LSPPlugin.get(view);
                if (!view || !plugin)
                    return false;
                view.dispatch(setDiagnostics(view.state, params.diagnostics.map(item => {
                    var _a;
                    return ({
                        from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.start, plugin.syncedDoc)),
                        to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.end, plugin.syncedDoc)),
                        severity: toSeverity((_a = item.severity) !== null && _a !== void 0 ? _a : 1),
                        message: item.message,
                    });
                })));
                return true;
            }
        },
        editorExtension: autoSync
    };
}

/**
Returns an extension that enables the [LSP
plugin](https://codemirror.net/6/docs/ref/#lsp-client.LSPPlugin) as well as LSP based
autocompletion, hover tooltips, and signature help, along with the
keymaps for reformatting, renaming symbols, jumping to definition,
and finding references.

This function is deprecated. Prefer to directly use
[`LSPPlugin.create`](https://codemirror.net/6/docs/ref/#lsp-client.LSPPlugin^create) and either add
the extensions you need directly, or configure them in the client
via [`languageServerExtensions`](https://codemirror.net/6/docs/ref/#lsp-client.languageServerExtensions).
*/
function languageServerSupport(client, uri, languageID) {
    return [
        LSPPlugin.create(client, uri, languageID),
        serverCompletion(),
        hoverTooltips(),
        keymap.of([...formatKeymap, ...renameKeymap, ...jumpToDefinitionKeymap, ...findReferencesKeymap]),
        signatureHelp(),
    ];
}
/**
This function bundles all the extensions defined in this package,
in a way that can be passed to the
[`extensions`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClientConfig.extensions) option to
`LSPClient`.
*/
function languageServerExtensions() {
    return [
        serverCompletion(),
        hoverTooltips(),
        keymap.of([...formatKeymap, ...renameKeymap, ...jumpToDefinitionKeymap, ...findReferencesKeymap]),
        signatureHelp(),
        serverDiagnostics()
    ];
}

export { LSPClient, LSPPlugin, Workspace, WorkspaceMapping, closeReferencePanel, findReferences, findReferencesKeymap, formatDocument, formatKeymap, hoverTooltips, jumpToDeclaration, jumpToDefinition, jumpToDefinitionKeymap, jumpToImplementation, jumpToTypeDefinition, languageServerExtensions, languageServerSupport, nextSignature, prevSignature, renameKeymap, renameSymbol, serverCompletion, serverCompletionSource, serverDiagnostics, showSignatureHelp, signatureHelp, signatureKeymap };
