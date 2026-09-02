'use strict';

// CustomTextEditorProvider: turns a Minecraft language JSON file into the GUI.
// One editor instance is bound to the opened language file; the whole folder
// (all sibling language files) is edited through the shared FolderModel.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { t } = require('./i18n');
const crypto = require('crypto');
const detection = require('./detection');

const VIEW_TYPE = 'minecraftLanguageEditor.gridEditor';

/**
 * @param {vscode.ExtensionContext} context
 */
function buildHtml(context, webview) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.js'));
    const htmlPath = path.join(context.extensionPath, 'media', 'editor.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
        .replace(/\{nonce\}/g, nonce)
        .replace(/\{cspSource\}/g, webview.cspSource)
        .replace(/\{cssUri\}/g, css.toString())
        .replace(/\{scriptUri\}/g, script.toString());
    return html;
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/** VS Code theme kind + font settings the GUI should follow. Dedicated
 * `minecraftLanguageEditor.fontSize/fontFamily` override the editor defaults
 * when set. */
function uiConfigMessage() {
    const editor = vscode.workspace.getConfiguration('editor');
    const mine = vscode.workspace.getConfiguration('minecraftLanguageEditor');
    const kind = vscode.window.activeColorTheme ? vscode.window.activeColorTheme.kind : vscode.ColorThemeKind.Dark;
    const themeKind =
        kind === vscode.ColorThemeKind.Light ? 'light' :
        kind === vscode.ColorThemeKind.HighContrast ? 'hc' :
        kind === vscode.ColorThemeKind.HighContrastLight ? 'hcl' : 'dark';
    const localFontSize = mine.get('fontSize', null);
    const localFontFamily = mine.get('fontFamily', null);
    return {
        type: 'uiConfig',
        fontSize: typeof localFontSize === 'number' ? localFontSize : editor.get('fontSize', 14),
        fontFamily: (typeof localFontFamily === 'string' && localFontFamily) || editor.get('fontFamily', '') || null,
        themeKind
    };
}

/** Current folder layout sizes remembered across sessions (globalState). */
function layoutStoreKey() {
    return 'minecraftLanguageEditor.layout';
}

class EditorPanel {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {import('./model').FolderModel} model
     * @param {import('./model').ModelRegistry} registry
     * @param {vscode.WebviewPanel} panel
     * @param {object} init {primaryCode, bindName}
     */
    constructor(context, model, registry, panel, init) {
        this.context = context;
        this.model = model;
        this.registry = registry;
        this.panel = panel;
        this.init = init;
        this.panelId = null;
        this._handle = null;
        this._uiDisposables = [];

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
            enableCommandUris: false
        };
        panel.webview.html = buildHtml(context, panel.webview);

        this._handle = panel.webview.onDidReceiveMessage((msg) => this._onMessage(msg));

        // Keep the GUI in sync with VS Code font settings / theme and with our
        // own settings (confirmDelete / detailDock / font overrides).
        const pushUi = () => this._post(uiConfigMessage());
        const pushCfg = () => this._post(this._configMessage());
        this._uiDisposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('editor.fontSize') ||
                    e.affectsConfiguration('editor.fontFamily') ||
                    e.affectsConfiguration('editor.lineHeight') ||
                    e.affectsConfiguration('minecraftLanguageEditor.fontSize') ||
                    e.affectsConfiguration('minecraftLanguageEditor.fontFamily')) {
                    pushUi();
                }
                if (e.affectsConfiguration('minecraftLanguageEditor.confirmDelete') ||
                    e.affectsConfiguration('minecraftLanguageEditor.detailDock') ||
                    e.affectsConfiguration('minecraftLanguageEditor.showNewlineAsEscape')) {
                    pushCfg();
                }
            })
        );
        this._uiDisposables.push(vscode.window.onDidChangeActiveColorTheme(pushUi));

        panel.onDidDispose(() => this.dispose());
    }

    _post(message) {
        if (!this.panel.webview) {
            return;
        }
        try {
            this.panel.webview.postMessage(message);
        } catch {
            // webview disposed
        }
    }

    /** Current confirmDelete + detailDock values pushed to the GUI. */
    _configMessage() {
        const c = vscode.workspace.getConfiguration('minecraftLanguageEditor');
        return {
            type: 'config',
            confirmDelete: c.get('confirmDelete', true),
            detailDock: c.get('detailDock', 'bottom'),
            newlineEscape: c.get('showNewlineAsEscape', true)
        };
    }

    _layoutKey() {
        return this.model.folderUri.toString();
    }

    async _readLayout() {
        const all = this.context.globalState.get(layoutStoreKey(), {}) || {};
        return all[this._layoutKey()] || {};
    }

    async _writeLayout(part) {
        const all = this.context.globalState.get(layoutStoreKey(), {}) || {};
        all[this._layoutKey()] = { ...(all[this._layoutKey()] || {}), ...part };
        await this.context.globalState.update(layoutStoreKey(), all);
    }

    async _onMessage(msg) {
        if (!msg || !msg.type) {
            return;
        }
        switch (msg.type) {
            case 'ready': {
                // Send init + authoritative snapshot + replay current notices.
                const cfg = vscode.workspace.getConfiguration('minecraftLanguageEditor');
                this._post({
                    type: 'init',
                    primaryCode: this.init.primaryCode || null,
                    bindName: this.init.bindName || '',
                    folderName: this.model.folderName,
                    folderPath: this.model.folderUri.fsPath,
                    config: { confirmDelete: cfg.get('confirmDelete', true) },
                    locale: vscode.env.language && vscode.env.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
                });
                for (const notice of this.model.notices()) {
                    this._post({ type: 'notice', ...notice });
                }
                this._post(uiConfigMessage());
                this._post(this._configMessage());
                // Remembered layout sizes for this folder (survive restarts).
                const lay = await this._readLayout();
                this._post({ type: 'layoutCfg', bottomH: lay.bottomH || null, sideW: lay.sideW || null });
                this._post(this.model.snapshot());
                break;
            }
            case 'requestSnapshot':
                this._post(this.model.snapshot());
                break;
            case 'op':
                this.model.doOp(msg.op, this.panelId);
                break;
            case 'undo':
                this.model.undo(this.panelId);
                break;
            case 'redo':
                this.model.redo(this.panelId);
                break;
            case 'reload':
                this.model.reload(this.panelId);
                break;
            case 'copy':
                if (typeof msg.text === 'string') {
                    vscode.env.clipboard.writeText(msg.text);
                }
                break;
            case 'readClipboard': {
                const txt = await vscode.env.clipboard.readText();
                this._post({ type: 'clipboard', text: txt });
                break;
            }
            case 'setConfirmDelete': {
                const cfg = vscode.workspace.getConfiguration('minecraftLanguageEditor');
                await cfg.update('confirmDelete', !!msg.value, vscode.ConfigurationTarget.Global);
                break;
            }
            case 'layoutChange': {
                // Remember sizes per folder; remember the dock by persisting it
                // into the `detailDock` setting (so it survives restarts too).
                const next = {};
                if (typeof msg.bottomH === 'number') {
                    next.bottomH = Math.round(msg.bottomH);
                }
                if (typeof msg.sideW === 'number') {
                    next.sideW = Math.round(msg.sideW);
                }
                if (Object.keys(next).length) {
                    await this._writeLayout(next);
                }
                const dock = String(msg.dock || '');
                if (['bottom', 'left', 'right', 'full'].includes(dock)) {
                    const cfg = vscode.workspace.getConfiguration('minecraftLanguageEditor');
                    if (cfg.get('detailDock', 'bottom') !== dock) {
                        await cfg.update('detailDock', dock, vscode.ConfigurationTarget.Global);
                    }
                }
                break;
            }
            case 'noticeAction': {
                const id = String(msg.id || '');
                if (id.startsWith('openRaw:')) {
                    this.model.openRawFileByName(id.slice('openRaw:'.length));
                } else if (id.startsWith('saveDoc:')) {
                    const p = id.slice('saveDoc:'.length).toLowerCase();
                    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === p);
                    if (doc) {
                        await doc.save();
                    }
                } else if (id === 'reload') {
                    this.model.reload(this.panelId);
                }
                break;
            }
            default:
                break;
        }
    }

    attach() {
        this.panelId = this.model.attachPanel((message) => this._post(message));
    }

    /** Public post — used by native webview context-menu commands. */
    post(message) {
        this._post(message);
    }

    dispose() {
        for (const d of this._uiDisposables) {
            try {
                d.dispose();
            } catch {
                // ignore
            }
        }
        this._uiDisposables = [];
        if (this._handle) {
            this._handle.dispose();
            this._handle = null;
        }
        if (this.panelId) {
            this.model.detachPanel(this.panelId);
            this.panelId = null;
        }
        // Dispose the folder model when its last GUI panel goes away.
        if (this.model.panelCount === 0 && !this.model.isDisposed()) {
            this.registry.disposeModel(this.model);
        }
    }
}

class LangEditorProvider {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {import('./model').ModelRegistry} registry
     */
    constructor(context, registry) {
        this.context = context;
        this.registry = registry;
        /** @type {Set<EditorPanel>} open GUI panels (for native context menus) */
        this.panels = new Set();
    }

    registerPanel(panel, webviewPanel) {
        this.panels.add(panel);
        webviewPanel.onDidDispose(() => this.panels.delete(panel));
    }

    /** Send a message to every open GUI panel (context-menu commands). */
    broadcast(message) {
        for (const panel of this.panels) {
            try {
                panel.post(message);
            } catch {
                // panel gone
            }
        }
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.WebviewPanel} webviewPanel
     */
    async resolveCustomTextEditor(document, webviewPanel) {
        const fsPath = document.uri.fsPath;
        const name = path.basename(fsPath);
        const code = detection.langCodeFromFileName(name);
        const folderUri = vscode.Uri.file(path.dirname(fsPath));
        let model;
        let loadError = null;
        try {
            model = await this.registry.getOrCreate(this.context, folderUri);
        } catch (err) {
            model = null;
            loadError = err instanceof Error ? err.message : String(err);
        }
        if (!model || model.isDisposed()) {
            const msg = t('folderReadFail') + ': ' + loadError;
            webviewPanel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><meta charset="UTF-8">` +
                `<body style="font-family:sans-serif;padding:24px;color:#c0392b">${escapeHtml(msg)}</body></html>`;
            return;
        }
        const panel = new EditorPanel(this.context, model, this.registry, webviewPanel, {
            primaryCode: code || (model.langs[0] || null),
            bindName: name
        });
        panel.attach();
        this.registerPanel(panel, webviewPanel);
    }
}

module.exports = { LangEditorProvider, VIEW_TYPE, buildHtml };
