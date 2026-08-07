import * as lsp from 'vscode-languageserver-protocol';
import { Text, ChangeSet, TransactionSpec, Extension, ChangeDesc, MapMode } from '@codemirror/state';
import { Language } from '@codemirror/language';
import { EditorView, Command, KeyBinding } from '@codemirror/view';
import { CompletionSource } from '@codemirror/autocomplete';

/**
A file that is open in a workspace.
*/
interface WorkspaceFile {
    /**
    The file's unique URI.
    */
    uri: string;
    /**
    The LSP language ID for the file's content.
    */
    languageId: string;
    /**
    The current version of the file.
    */
    version: number;
    /**
    The document corresponding to `this.version`. Will not reflect
    changes made after that version was synchronized. Will be
    updated, along with `version`, by
    [`syncFiles`](https://codemirror.net/6/docs/ref/#lsp-client.Workspace.syncFiles).
    */
    doc: Text;
    /**
    Get an active editor view for this file, if there is one. For
    workspaces that support multiple views on a file, `main`
    indicates a preferred view.
    */
    getView(main?: EditorView): EditorView | null;
}
interface WorkspaceFileUpdate {
    file: WorkspaceFile;
    prevDoc: Text;
    changes: ChangeSet;
}
/**
Implementing your own workspace class can provide more control
over the way files are loaded and managed when interacting with
the language server. See
[`LSPClientConfig.workspace`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClientConfig.workspace).
*/
declare abstract class Workspace {
    /**
    The LSP client associated with this workspace.
    */
    readonly client: LSPClient;
    /**
    The files currently open in the workspace.
    */
    abstract files: WorkspaceFile[];
    /**
    The constructor, as called by the client when creating a
    workspace.
    */
    constructor(
    /**
    The LSP client associated with this workspace.
    */
    client: LSPClient);
    /**
    Find the open file with the given URI, if it exists. The default
    implementation just looks it up in `this.files`.
    */
    getFile(uri: string): WorkspaceFile | null;
    /**
    Check all open files for changes (usually from editors, but they
    may also come from other sources). When a file is changed,
    return a record that describes the changes, and update the file's
    [`version`](https://codemirror.net/6/docs/ref/#lsp-client.WorkspaceFile.version) and
    [`doc`](https://codemirror.net/6/docs/ref/#lsp-client.WorkspaceFile.doc) properties to reflect the
    new version.
    */
    abstract syncFiles(): readonly WorkspaceFileUpdate[];
    /**
    Called to request that the workspace open a file. The default
    implementation simply returns the file if it is open, null
    otherwise.
    */
    requestFile(uri: string): Promise<WorkspaceFile | null>;
    /**
    Called when an editor is created for a file. The implementation
    should track the file in
    [`this.files`](https://codemirror.net/6/docs/ref/#lsp-client.Workspace.files) and, if it wasn't
    open already, call
    [`LSPClient.didOpen`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.didOpen).
    */
    abstract openFile(uri: string, languageId: string, view: EditorView): void;
    /**
    Called when an editor holding this file is destroyed or
    reconfigured to no longer hold it. The implementation should
    track this and, when it closes the file, make sure to call
    [`LSPClient.didClose`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.didClose).
    */
    abstract closeFile(uri: string, view: EditorView): void;
    /**
    Called when the client for this workspace is connected. The
    default implementation calls
    [`LSPClient.didOpen`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.didOpen) on all open
    files.
    */
    connected(): void;
    /**
    Called when the client for this workspace is disconnected. The
    default implementation does nothing.
    */
    disconnected(): void;
    /**
    Called when a server-initiated change to a file is applied. The
    default implementation simply dispatches the update to the
    file's view, if the file is open and has a view.
    */
    updateFile(uri: string, update: TransactionSpec): void;
    /**
    When the client needs to put a file other than the one loaded in
    the current editor in front of the user, for example in
    [`jumpToDefinition`](https://codemirror.net/6/docs/ref/#lsp-client.jumpToDefinition), it will call
    this function. It should make sure to create or find an editor
    with the file and make it visible to the user, or return null if
    this isn't possible.
    */
    displayFile(uri: string): Promise<EditorView | null>;
}

/**
A workspace mapping is used to track changes made to open
documents, so that positions returned by a request can be
interpreted in terms of the current, potentially changed document.
*/
declare class WorkspaceMapping {
    private client;
    private startDocs;
    /**
    Get the changes made to the document with the given URI since
    the mapping was created. Returns null for documents that aren't
    open.
    */
    getMapping(uri: string): ChangeDesc | null;
    /**
    Map a position in the given file forward to the current document state.
    */
    mapPos(uri: string, pos: number, assoc?: number): number;
    mapPos(uri: string, pos: number, assoc: number, mode: MapMode): number | null;
    /**
    Convert an LSP-style position referring to a document at the
    time the mapping was created to an offset in the current document.
    */
    mapPosition(uri: string, pos: lsp.Position, assoc?: number): number;
    mapPosition(uri: string, pos: lsp.Position, assoc: number, mode: MapMode): number | null;
    /**
    Disconnect this mapping from the client so that it will no
    longer be notified of new changes. You must make sure to call
    this on every mapping you create, except when you use
    [`withMapping`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.withMapping), which will
    automatically schedule a disconnect when the given promise
    resolves or aborts.
    */
    destroy(): void;
}
/**
An object of this type should be used to wrap whatever transport
layer you use to talk to your language server. Messages should
contain only the JSON messages, no LSP headers.
*/
type Transport = {
    /**
    Send a message to the server. Should throw if the connection is
    broken somehow.
    */
    send(message: string): void;
    /**
    Register a handler for messages coming from the server.
    */
    subscribe(handler: (value: string) => void): void;
    /**
    Unregister a handler registered with `subscribe`.
    */
    unsubscribe(handler: (value: string) => void): void;
};
/**
Configuration options that can be passed to the LSP client.
*/
type LSPClientConfig = {
    /**
    The project root URI passed to the server, when necessary.
    */
    rootUri?: string;
    /**
    An optional function to create a
    [workspace](https://codemirror.net/6/docs/ref/#lsp-client.Workspace) object for the client to use.
    When not given, this will default to a simple workspace that
    only opens files that have an active editor, and only allows one
    editor per file.
    */
    workspace?: (client: LSPClient) => Workspace;
    /**
    The amount of milliseconds after which requests are
    automatically timed out. Defaults to 3000.
    */
    timeout?: number;
    /**
    LSP servers can send Markdown code, which the client must render
    and display as HTML. Markdown can contain arbitrary HTML and is
    thus a potential channel for cross-site scripting attacks, if
    someone is able to compromise your LSP server or your connection
    to it. You can pass an HTML sanitizer here to strip out
    suspicious HTML structure.
    */
    sanitizeHTML?: (html: string) => string;
    /**
    By default, the Markdown renderer will only be able to highlght
    code embedded in the Markdown text when its language tag matches
    the name of the language used by the editor. You can provide a
    function here that returns a CodeMirror language object for a
    given language tag to support more languages.
    */
    highlightLanguage?: (name: string) => Language | null;
    /**
    By default, the client will only handle the server notifications
    `window/logMessage` (logging warnings and errors to the console)
    and `window/showMessage`. You can pass additional handlers here.
    They will be tried before the built-in handlers, and override
    those when they return true.
    */
    notificationHandlers?: {
        [method: string]: (client: LSPClient, params: any) => boolean;
    };
    /**
    When no handler is found for a notification, it will be passed
    to this function, if given.
    */
    unhandledNotification?: (client: LSPClient, method: string, params: any) => void;
    /**
    Provide a set of extensions, which may be plain CodeMirror
    extensions, or objects containing additional client capabilities
    or notification handlers. Any CodeMirror extensions provided
    here will be included in the extension returned by
    [`LSPPlugin.create`](https://codemirror.net/6/docs/ref/#lsp-client.LSPPlugin^create).
    */
    extensions?: readonly (Extension | LSPClientExtension)[];
};
/**
Objects of this type can be included in the
[`extensions`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClientConfig.extensions) option to
`LSPClient` to modularly configure client capabilities or
notification handlers.
*/
type LSPClientExtension = {
    /**
    Extra [client
    capabilities](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#clientCapabilities)
    to send to the server when initializing. The object provided
    here will be merged with the capabilities the client provides by
    default.
    */
    clientCapabilities?: Record<string, any>;
    /**
    Additional [notification
    handlers](https://codemirror.net/6/docs/ref/#lsp-client.LSPClientConfig.notificationHandlers).
    These will be tried after notification handlers defined directly
    in the config object, and then in order of appearance in the
    [`extensions`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClientConfig.extensions) array.
    */
    notificationHandlers?: {
        [method: string]: (client: LSPClient, params: any) => boolean;
    };
    /**
    An optional CodeMirror extension to include.
    */
    editorExtension?: Extension;
};
/**
An LSP client manages a connection to a language server. It should
be explicitly [connected](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.connect) before
use.
*/
declare class LSPClient {
    /**
    The client's [workspace](https://codemirror.net/6/docs/ref/#lsp-client.Workspace).
    */
    workspace: Workspace;
    private nextReqID;
    private requests;
    /**
    The capabilities advertised by the server. Will be null when not
    connected or initialized.
    */
    serverCapabilities: lsp.ServerCapabilities | null;
    private supportSync;
    /**
    A promise that resolves once the client connection is initialized. Will be
    replaced by a new promise object when you call `disconnect`.
    */
    initializing: Promise<null>;
    private init;
    private timeout;
    /**
    Create a client object.
    */
    constructor(
    /**
    @internal
    */
    config?: LSPClientConfig);
    /**
    Whether this client is connected (has a transport).
    */
    get connected(): boolean;
    /**
    Connect this client to a server over the given transport. Will
    immediately start the initialization exchange with the server,
    and resolve `this.initializing` (which it also returns) when
    successful.
    */
    connect(transport: Transport): this;
    /**
    Disconnect the client from the server.
    */
    disconnect(): void;
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
    plugin(fileURI: string, languageID?: string): Extension;
    /**
    Send a `textDocument/didOpen` notification to the server.
    */
    didOpen(file: WorkspaceFile): void;
    /**
    Send a `textDocument/didClose` notification to the server.
    */
    didClose(uri: string): void;
    private receiveMessage;
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
    request<Params, Result>(method: string, params: Params): Promise<Result>;
    private requestInner;
    /**
    Send a notification to the server.
    */
    notification<Params>(method: string, params: Params): void;
    /**
    Cancel the in-progress request with the given parameter value
    (which is compared by identity).
    */
    cancelRequest(params: any): void;
    /**
    Create a [workspace mapping](https://codemirror.net/6/docs/ref/#lsp-client.WorkspaceMapping) that
    tracks changes to files in this client's workspace, relative to
    the moment where it was created. Make sure you call
    [`destroy`](https://codemirror.net/6/docs/ref/#lsp-client.WorkspaceMapping.destroy) on the mapping
    when you're done with it.
    */
    workspaceMapping(): WorkspaceMapping;
    /**
    Run the given promise with a [workspace
    mapping](https://codemirror.net/6/docs/ref/#lsp-client.WorkspaceMapping) active. Automatically
    release the mapping when the promise resolves or rejects.
    */
    withMapping<T>(f: (mapping: WorkspaceMapping) => Promise<T>): Promise<T>;
    /**
    Push any [pending changes](https://codemirror.net/6/docs/ref/#lsp-client.Workspace.syncFiles) in
    the open files to the server. You'll want to call this before
    most types of requests, to make sure the server isn't working
    with outdated information.
    */
    sync(): void;
    private timeoutRequest;
}

/**
A plugin that connects a given editor to a language server client.
*/
declare class LSPPlugin {
    /**
    The editor view that this plugin belongs to.
    */
    readonly view: EditorView;
    /**
    The client connection.
    */
    client: LSPClient;
    /**
    The URI of this file.
    */
    uri: string;
    /**
    Render a doc string from the server to HTML.
    */
    docToHTML(value: string | lsp.MarkupContent, defaultKind?: lsp.MarkupKind): string;
    /**
    Convert a CodeMirror document offset into an LSP `{line,
    character}` object. Defaults to using the view's current
    document, but can be given another one.
    */
    toPosition(pos: number, doc?: Text): lsp.Position;
    /**
    Convert an LSP `{line, character}` object to a CodeMirror
    document offset.
    */
    fromPosition(pos: lsp.Position, doc?: Text): number;
    /**
    Display an error in this plugin's editor.
    */
    reportError(message: string, err: any): void;
    /**
    The version of the document that was synchronized to the server.
    */
    syncedDoc: Text;
    /**
    The changes accumulated in this editor that have not been sent
    to the server yet.
    */
    unsyncedChanges: ChangeSet;
    /**
    Reset the [unsynced
    changes](https://codemirror.net/6/docs/ref/#lsp-client.LSPPlugin.unsyncedChanges). Should probably
    only be called by a [workspace](https://codemirror.net/6/docs/ref/#lsp-client.Workspace).
    */
    clear(): void;
    /**
    Get the LSP plugin associated with an editor, if any.
    */
    static get(view: EditorView): LSPPlugin | null;
    /**
    Deprecated. Use
    [`LSPClient.plugin`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClient.plugin) instead.
    */
    static create(client: LSPClient, fileURI: string, languageID?: string): Extension;
}

/**
Register the [language server completion
source](https://codemirror.net/6/docs/ref/#lsp-client.serverCompletionSource) as an autocompletion
source.
*/
declare function serverCompletion(config?: {
    /**
    By default, the completion source that asks the language server
    for completions is added as a regular source, in addition to any
    other sources. Set this to true to make it replace all
    completion sources.
    */
    override?: boolean;
    /**
    Set a custom
    [`validFor`](https://codemirror.net/6/docs/ref/#autocomplete.CompletionResult.validFor) expression
    to use in the completion results. By default, the library uses an
    expression that accepts word characters, optionally prefixed by
    any non-word prefixes found in the results.
    */
    validFor?: RegExp;
}): Extension;
/**
A completion source that requests completions from a language
server.
*/
declare const serverCompletionSource: CompletionSource;

/**
Create an extension that queries the language server for hover
tooltips when the user hovers over the code with their pointer,
and displays a tooltip when the server provides one.
*/
declare function hoverTooltips(config?: {
    hoverTime?: number;
}): Extension;

/**
This command asks the language server to reformat the document,
and then applies the changes it returns.
*/
declare const formatDocument: Command;
/**
A keymap that binds Shift-Alt-f to
[`formatDocument`](https://codemirror.net/6/docs/ref/#lsp-client.formatDocument).
*/
declare const formatKeymap: readonly KeyBinding[];

/**
This command will, if the cursor is over a word, prompt the user
for a new name for that symbol, and ask the language server to
perform a rename of that symbol.

Note that this may affect files other than the one loaded into
this view. See the
[`Workspace.updateFile`](https://codemirror.net/6/docs/ref/#lsp-client.Workspace.updateFile)
method.
*/
declare const renameSymbol: Command;
/**
A keymap that binds F2 to [`renameSymbol`](https://codemirror.net/6/docs/ref/#lsp-client.renameSymbol).
*/
declare const renameKeymap: readonly KeyBinding[];

/**
Explicitly prompt the server to provide signature help at the
cursor.
*/
declare const showSignatureHelp: Command;
/**
If there is an active signature tooltip with multiple signatures,
move to the next one.
*/
declare const nextSignature: Command;
/**
If there is an active signature tooltip with multiple signatures,
move to the previous signature.
*/
declare const prevSignature: Command;
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
declare const signatureKeymap: readonly KeyBinding[];
/**
Returns an extension that enables signature help. Will bind the
keys in [`signatureKeymap`](https://codemirror.net/6/docs/ref/#lsp-client.signatureKeymap) unless
`keymap` is set to `false`.
*/
declare function signatureHelp(config?: {
    keymap?: boolean;
}): Extension;

/**
Jump to the definition of the symbol at the cursor. To support
cross-file jumps, you'll need to implement
[`Workspace.displayFile`](https://codemirror.net/6/docs/ref/#lsp-client.Workspace.displayFile).
*/
declare const jumpToDefinition: Command;
/**
Jump to the declaration of the symbol at the cursor.
*/
declare const jumpToDeclaration: Command;
/**
Jump to the type definition of the symbol at the cursor.
*/
declare const jumpToTypeDefinition: Command;
/**
Jump to the implementation of the symbol at the cursor.
*/
declare const jumpToImplementation: Command;
/**
Binds F12 to [`jumpToDefinition`](https://codemirror.net/6/docs/ref/#lsp-client.jumpToDefinition).
*/
declare const jumpToDefinitionKeymap: readonly KeyBinding[];

/**
Ask the server to locate all references to the symbol at the
cursor. When the server can provide such references, show them as
a list in a panel.
*/
declare const findReferences: Command;
/**
Close the reference panel, if it is open.
*/
declare const closeReferencePanel: Command;
/**
Binds Shift-F12 to [`findReferences`](https://codemirror.net/6/docs/ref/#lsp-client.findReferences)
and Escape to
[`closeReferencePanel`](https://codemirror.net/6/docs/ref/#lsp-client.closeReferencePanel).
*/
declare const findReferencesKeymap: readonly KeyBinding[];

declare function serverDiagnostics(): LSPClientExtension;

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
declare function languageServerSupport(client: LSPClient, uri: string, languageID?: string): Extension;
/**
This function bundles all the extensions defined in this package,
in a way that can be passed to the
[`extensions`](https://codemirror.net/6/docs/ref/#lsp-client.LSPClientConfig.extensions) option to
`LSPClient`.
*/
declare function languageServerExtensions(): readonly (Extension | LSPClientExtension)[];

export { LSPClient, LSPPlugin, Workspace, WorkspaceMapping, closeReferencePanel, findReferences, findReferencesKeymap, formatDocument, formatKeymap, hoverTooltips, jumpToDeclaration, jumpToDefinition, jumpToDefinitionKeymap, jumpToImplementation, jumpToTypeDefinition, languageServerExtensions, languageServerSupport, nextSignature, prevSignature, renameKeymap, renameSymbol, serverCompletion, serverCompletionSource, serverDiagnostics, showSignatureHelp, signatureHelp, signatureKeymap };
export type { LSPClientConfig, LSPClientExtension, Transport, WorkspaceFile };
