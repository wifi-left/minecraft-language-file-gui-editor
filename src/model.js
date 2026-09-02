'use strict';

// One shared "folder model" per language-file directory.
// Owns the normalized state (see src/langSet.js), the undo/redo stacks, all
// persistence (through VS Code TextDocuments / workspace.fs) and the broadcast
// of changes to every open GUI panel of that folder.

const vscode = require('vscode');
const path = require('path');
const { t } = require('./i18n');
const detection = require('./detection');
const langSet = require('./langSet');

const INTERNAL_IGNORE_MS = 2000;

/**
 * @param {vscode.Uri} uri
 * @returns {string} fs path normalized for keying
 */
function keyOfUri(uri) {
    return path.normalize(uri.fsPath).toLowerCase();
}

class FolderModel {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {vscode.Uri} folderUri
     */
    constructor(context, folderUri) {
        this.context = context;
        this.folderUri = folderUri;
        this.key = keyOfUri(folderUri);

        this._state = null;                 // langSet state
        this._sourceTexts = {};             // code -> text the model was built from
        this._panels = new Map();           // id -> { postMessage }
        this._undoStack = [];
        this._redoStack = [];
        this._chain = Promise.resolve();
        this._disposed = false;
        this._reloadPending = false;
        this._internalUntil = new Map();    // lower-case fsPath -> timestamp
        this._noticeLog = [];
        this._dirtyWarned = new Set();      // codes we warned about this session

        // Settings snapshot (config for serialization).
        const cfg = vscode.workspace.getConfiguration('minecraftLanguageEditor');
        this._indentSize = cfg.get('indentSize', 2);
        this._undoLimit = Math.max(1, cfg.get('undoLimit', 100));

        // Listen to the folder for new/deleted/changed language files.
        // (A watcher can fail to be created for folders outside the workspace;
        // it is optional — document events still keep the model in sync.)
        let watcher = null;
        try {
            watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folderUri, '*.json')
            );
            watcher.onDidCreate(() => this._onExternalFsEvent());
            watcher.onDidChange((uri) => this._onExternalFsEvent(uri));
            watcher.onDidDelete(() => this._onExternalFsEvent());
        } catch {
            watcher = null;
        }
        this._watcher = watcher;

        // Listen to documents (raw JSON tabs, our own writes).
        this._docDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
            const uri = e.document.uri;
            if (uri.scheme !== 'file') {
                return;
            }
            const p = keyOfUri(uri);
            if (this._isInternalNow(p)) {
                return;
            }
            if (!this._sourceUris.has(p)) {
                return;
            }
            // An edit we did not cause landed in one of our language files.
            this._onDocumentEditedExternally(e.document);
        });
        this._saveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
            const p = keyOfUri(doc.uri);
            if (this._isInternalNow(p)) {
                return;
            }
            if (this._sourceUris.has(p)) {
                this._scheduleExternalReload(t('reasonSave', { f: path.basename(doc.uri.fsPath) }));
            }
        });
        this._sourceUris = new Set();
        this._sourceCodeByPath = new Map(); // lower fsPath -> code
    }

    // ---------------------------------------------------------------- public

    get folderName() {
        return path.basename(this.folderUri.fsPath) || this.folderUri.fsPath;
    }

    get indent() {
        return ' '.repeat(this._indentSize);
    }

    isDisposed() {
        return this._disposed;
    }

    /** Code of the file that is the "primary" language (the one being edited). */
    get langs() {
        return this._state ? this._state.langs : [];
    }

    /**
     * (Re)load the folder state from disk / open documents.
     */
    async init() {
        await this._reloadInternal({});
    }

    /** Recent notices so a newly opened panel can replay them. */
    notices() {
        return this._noticeLog.slice();
    }

    /**
     * @param {(message: object) => void} post
     * @returns {string} panel id
     */
    attachPanel(post) {
        const id = 'p' + Math.random().toString(36).slice(2);
        this._panels.set(id, { postMessage: post });
        return id;
    }

    detachPanel(id) {
        this._panels.delete(id);
    }

    get panelCount() {
        return this._panels.size;
    }

    broadcast(message) {
        const withHist = { ...message, canUndo: this.canUndo(), canRedo: this.canRedo() };
        if (message && message.type === 'notice') {
            // Keep a short log so panels opened later can replay current warnings.
            this._noticeLog = this._noticeLog.filter((n) => n.text !== message.text);
            this._noticeLog.push({ level: message.level, text: message.text, action: message.action });
            while (this._noticeLog.length > 6) {
                this._noticeLog.shift();
            }
        }
        for (const panel of this._panels.values()) {
            try {
                panel.postMessage(withHist);
            } catch {
                // panel gone
            }
        }
        return withHist;
    }

    snapshot() {
        const s = this._state;
        return {
            type: 'snapshot',
            folderName: this.folderName,
            folderPath: this.folderUri.fsPath,
            indentSize: this._indentSize,
            langs: s.langs.map((code) => ({ code, name: s.files[code] ? s.files[code].name : code + '.json' })),
            broken: s.broken,
            keys: s.keys,
            values: s.values,
            canUndo: this.canUndo(),
            canRedo: this.canRedo()
        };
    }

    canUndo() {
        return this._undoStack.length > 0;
    }

    canRedo() {
        return this._redoStack.length > 0;
    }

    /**
     * Execute a mutation op, persist changed files, broadcast the op echo.
     * @param {object} op
     * @param {string} originPanelId panel to send the authoritative reply to ('' = none)
     * @returns {Promise<object>} {ok, applied?, error?}
     */
    doOp(op, originPanelId) {
        return this._enqueue(() => this._doOpNow(op, originPanelId));
    }

    async _doOpNow(op, originPanelId) {
        const s = this._state;
        if (!s) {
            return { ok: false, error: t('modelNotReady') };
        }
        const before = this._serializeMap();
        const res = langSet.applyOp(s, op);
        if (!res.ok) {
            this._reply(originPanelId, { type: 'opError', error: res.error });
            return { ok: false, error: res.error };
        }
        if (!res.applied) {
            // Nothing changed (same value etc.) — nothing to persist.
            return { ok: true, applied: false };
        }
        const after = this._serializeMap();
        const changed = [];
        for (const code of s.langs) {
            if (before[code] !== after[code]) {
                changed.push(code);
            }
        }
        if (changed.length === 0) {
            return { ok: true, applied: true };
        }
        const beforeSub = {};
        const afterSub = {};
        for (const code of changed) {
            beforeSub[code] = before[code];
            afterSub[code] = after[code];
        }
        const entry = {
            op: op,
            label: op.type,
            codes: changed,
            before: { texts: beforeSub, keys: [...s.keys] },
            after: { texts: afterSub, keys: [...s.keys] }
        };
        this._undoStack.push(entry);
        if (this._undoStack.length > this._undoLimit) {
            this._undoStack.shift();
        }
        this._redoStack = [];

        const errors = await this._persistTexts(afterSub);
        this._sourceTexts = { ...this._sourceTexts, ...afterSub };
        const msg = this.broadcast({ type: 'op', op });
        this._reportPersistErrors(errors, msg);
        if (originPanelId) {
            this._reply(originPanelId, { type: 'opAck', ok: true });
        }
        return { ok: true, applied: true };
    }

    undo(originPanelId) {
        return this._enqueue(() => this._restoreFromStack('undo', originPanelId));
    }

    redo(originPanelId) {
        return this._enqueue(() => this._restoreFromStack('redo', originPanelId));
    }

    reload(originPanelId) {
        return this._enqueue(async () => {
            await this._reloadInternal({});
            if (originPanelId) {
                this._reply(originPanelId, { type: 'opAck', ok: true });
            }
            return { ok: true };
        });
    }

    /** Open a language file by file name in the raw JSON editor. */
    openRawFileByName(name) {
        let code = null;
        for (const c of this._state.langs) {
            if (this._state.files[c] && this._state.files[c].name === name) {
                code = c;
                break;
            }
        }
        if (code) {
            this.openRawFile(code);
            return;
        }
        const broken = this._state.broken.find((b) => b.name === name);
        if (broken) {
            vscode.commands.executeCommand('vscode.openWith',
                vscode.Uri.joinPath(this.folderUri, broken.name), 'default');
        }
    }

    /** Ask extension host to open a language file in the raw JSON editor. */
    openRawFile(code) {
        const name = this._state && this._state.files[code] ? this._state.files[code].name : null;
        if (!name) {
            return;
        }
        const uri = vscode.Uri.joinPath(this.folderUri, name);
        vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }

    dispose() {
        this._disposed = true;
        for (const d of [this._watcher, this._docDisposable, this._saveDisposable]) {
            try {
                if (d) {
                    d.dispose();
                }
            } catch {
                // ignore
            }
        }
        this._panels.clear();
    }

    // ------------------------------------------------------------ internals

    _enqueue(fn) {
        const run = this._chain.then(fn, fn);
        // Keep the chain alive even when a step rejects.
        this._chain = run.catch(() => undefined);
        return run;
    }

    _reply(panelId, message) {
        const panel = this._panels.get(panelId);
        if (panel) {
            try {
                panel.postMessage(message);
            } catch {
                // ignore
            }
        }
    }

    _serializeMap() {
        const cfg = vscode.workspace.getConfiguration('minecraftLanguageEditor');
        const escape = !!cfg.get('escapeNonAsciiOnWrite', false);
        const preserve = !!cfg.get('preserveUnicodeEscapes', true);
        return langSet.serializeAll(this._state, this.indent, {
            escapeNonAscii: escape,
            preserveEscapes: preserve
        });
    }

    _isInternalNow(fsPathKey) {
        const until = this._internalUntil.get(fsPathKey);
        return !!until && until > Date.now();
    }

    _markInternal(fsPathKey) {
        this._internalUntil.set(fsPathKey, Date.now() + INTERNAL_IGNORE_MS);
    }

    _onExternalFsEvent(uri) {
        if (uri) {
            const p = keyOfUri(uri);
            if (this._isInternalNow(p)) {
                return;
            }
        }
        this._scheduleExternalReload(t('reasonFs'));
    }

    _scheduleExternalReload(reason) {
        if (this._reloadPending || this._disposed) {
            return;
        }
        this._reloadPending = true;
        setTimeout(() => {
            this._reloadPending = false;
            this._enqueue(async () => {
                if (this._disposed) {
                    return;
                }
                const current = this._serializeMap();
                await this._reloadInternal({ notifyBroken: false });
                const next = this._serializeMap();
                if (this._mapEqual(current, next) && this._state.broken.length === 0) {
                    return; // nothing observable changed (e.g. our own formatting)
                }
                this.broadcast({ type: 'notice', level: 'info', text: t('reloaded', { r: reason }) });
                this.broadcast(this.snapshot());
            });
        }, 350);
    }

    _mapEqual(a, b) {
        const ak = Object.keys(a);
        const bk = Object.keys(b);
        if (ak.length !== bk.length) {
            return false;
        }
        for (const code of ak) {
            if (a[code] !== b[code]) {
                return false;
            }
        }
        return true;
    }

    async _reloadInternal(opts) {
        const o = opts || {};
        const files = await this._readFolder();
        const newState = langSet.buildState(files.entries);
        // A file that could not even be read is reported (and never rewritten),
        // but must not prevent the rest of the folder from loading.
        for (const r of files.readErrors) {
            newState.broken.push({ code: r.code || '', name: r.name, error: r.error });
        }
        this._adoptState(newState, o.clearHistory !== false, o.notifyBroken !== false, o.preferredKeys || null);
    }

    /**
     * Install a freshly built state and refresh the per-path bookkeeping.
     */
    _adoptState(newState, clearHistory, notifyBroken, preferredKeys) {
        if (Array.isArray(preferredKeys)) {
            const known = new Set(newState.keys);
            const kept = preferredKeys.filter((k) => known.has(k));
            const seen = new Set(kept);
            for (const k of newState.keys) {
                if (!seen.has(k)) {
                    kept.push(k);
                }
            }
            newState.keys = kept;
        }
        this._state = newState;
        this._sourceTexts = {};
        this._sourceUris = new Set();
        this._sourceCodeByPath = new Map();
        const serialized = this._serializeMap();
        for (const code of this._state.langs) {
            const file = this._state.files[code];
            const uri = vscode.Uri.joinPath(this.folderUri, file.name);
            this._sourceTexts[code] = serialized[code];
            this._sourceUris.add(keyOfUri(uri));
            this._sourceCodeByPath.set(keyOfUri(uri), code);
        }
        this._dirtyWarned.clear();
        if (clearHistory) {
            this._undoStack = [];
            this._redoStack = [];
        }
        if (notifyBroken && this._state.broken.length > 0) {
            this._notifyBroken();
        }
    }

    _notifyBroken() {
        for (const b of this._state.broken) {
            this.broadcast({
                type: 'notice',
                level: 'error',
                text: t('brokenSkip', { f: b.name, e: b.error }),
                action: { id: 'openRaw:' + b.name, label: t('openRaw') }
            });
            return;
        }
    }

    async _readFolder() {
        const dir = await vscode.workspace.fs.readDirectory(this.folderUri);
        const names = dir
            .filter(([name, type]) => type === vscode.FileType.File && detection.isLangFileName(name))
            .map(([name]) => name)
            .sort();
        const entries = [];
        const readErrors = [];
        for (const name of names) {
            const code = detection.langCodeFromFileName(name);
            const uri = vscode.Uri.joinPath(this.folderUri, name);
            try {
                const text = await this._readTextForUri(uri);
                entries.push({ code, name, text });
            } catch (err) {
                readErrors.push({
                    code: code || '',
                    name,
                    error: t('readFail', { e: err instanceof Error ? err.message : String(err) })
                });
            }
        }
        return { entries, readErrors };
    }

    async _readTextForUri(uri) {
        // Prefer an open TextDocument so unsaved edits in a raw JSON tab survive.
        const doc = this._findOpenDocument(uri);
        if (doc) {
            return doc.getText();
        }
        const data = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(data).toString('utf8');
    }

    _findOpenDocument(uri) {
        const p = keyOfUri(uri);
        return vscode.workspace.textDocuments.find((d) => keyOfUri(d.uri) === p);
    }

    _onDocumentEditedExternally(doc) {
        const p = keyOfUri(doc.uri);
        const code = this._sourceCodeByPath.get(p);
        if (doc.isDirty) {
            // Raw JSON tab has unsaved edits — model can't trust disk or doc blindly.
            if (!this._dirtyWarned.has(code || p)) {
                this._dirtyWarned.add(code || p);
                this.broadcast({
                    type: 'notice',
                    level: 'warn',
                    text: t('dirtySkip', { f: path.basename(doc.uri.fsPath) }),
                    action: { id: 'saveDoc:' + p, label: t('saveFile') }
                });
            }
            return;
        }
        this._scheduleExternalReload(t('reasonExternal', { f: path.basename(doc.uri.fsPath) }));
    }

    /**
     * Persist texts (code -> full file text) using the doc route where a document
     * is already open, else direct fs write. Skips files that have unsaved edits
     * from another editor. Returns list of {code, name, error}.
     */
    async _persistTexts(texts) {
        const errors = [];
        for (const code of Object.keys(texts)) {
            const text = texts[code];
            const name = this._state.files[code] ? this._state.files[code].name : code + '.json';
            const uri = vscode.Uri.joinPath(this.folderUri, name);
            const p = keyOfUri(uri);
            const doc = this._findOpenDocument(uri);
            if (doc && doc.isDirty && !this._isInternalNow(p)) {
                const source = this._sourceTexts[code];
                if (source !== doc.getText()) {
                    if (!this._dirtyWarned.has(code)) {
                        this._dirtyWarned.add(code);
                        errors.push({ code, name, error: t('skipUnsaved') });
                    }
                    continue;
                }
            }
            try {
                await this._writeText(uri, text);
                this._sourceTexts[code] = text;
            } catch (err) {
                errors.push({ code, name, error: err instanceof Error ? err.message : String(err) });
            }
        }
        return errors;
    }

    async _writeText(uri, text) {
        const p = keyOfUri(uri);
        const doc = this._findOpenDocument(uri);
        if (doc) {
            this._markInternal(p);
            const edit = new vscode.WorkspaceEdit();
            const end = doc.positionAt(doc.getText().length);
            edit.replace(uri, new vscode.Range(doc.positionAt(0), end), text);
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                // Fall through to a direct write.
                await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
            } else {
                await doc.save();
            }
            this._markInternal(p);
            return;
        }
        this._markInternal(p);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    }

    async _restoreFromStack(direction, originPanelId) {
        const from = direction === 'undo' ? this._undoStack : this._redoStack;
        const to = direction === 'undo' ? this._redoStack : this._undoStack;
        const entry = from.pop();
        if (!entry) {
            if (originPanelId) {
                this._reply(originPanelId, { type: 'opError', error: direction === 'undo' ? t('noneUndo') : t('noneRedo') });
            }
            return { ok: false, error: 'empty' };
        }
        const target = direction === 'undo' ? entry.before : entry.after;
        const errors = await this._persistTexts(target.texts);
        // Reload the whole folder from disk (keeps history stacks), restoring the
        // canonical key order the history entry recorded.
        await this._reloadInternal({ clearHistory: false, notifyBroken: false, preferredKeys: target.keys });
        to.push(entry);
        this.broadcast({ type: 'notice', level: 'info', text: direction === 'undo' ? t('undone') : t('redone') });
        this.broadcast(this.snapshot());
        this._reportPersistErrors(errors, null);
        if (originPanelId) {
            this._reply(originPanelId, { type: 'opAck', ok: true });
        }
        return { ok: true };
    }

    _reportPersistErrors(errors, ctx) {
        if (errors.length === 0) {
            return;
        }
        for (const e of errors) {
            this.broadcast({
                type: 'notice',
                level: 'error',
                text: t('writeFail', { f: e.name, e: e.error }),
                action: { id: 'openRaw:' + e.name, label: t('openRaw') }
            });
        }
        void ctx;
    }
}

/**
 * Registry of folder models.
 */
class ModelRegistry {
    constructor() {
        /** @type {Map<string, FolderModel>} */
        this.models = new Map();
    }

    async getOrCreate(context, folderUri) {
        const key = keyOfUri(folderUri);
        let model = this.models.get(key);
        if (!model || model.isDisposed()) {
            model = new FolderModel(context, folderUri);
            await model.init();
            this.models.set(key, model);
        }
        return model;
    }

    get(folderUri) {
        return this.models.get(keyOfUri(folderUri)) || null;
    }

    disposeModel(model) {
        if (model && !model.isDisposed()) {
            model.dispose();
            if (this.models.get(model.key) === model) {
                this.models.delete(model.key);
            }
        }
    }

    disposeAll() {
        for (const model of this.models.values()) {
            model.dispose();
        }
        this.models.clear();
    }
}

module.exports = { FolderModel, ModelRegistry };
