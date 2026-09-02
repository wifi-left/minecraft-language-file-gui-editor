'use strict';

// Minecraft Language File GUI Editor — extension entry point.
//
// The GUI is registered as a native custom editor ("打开方式 / Open With...")
// for Minecraft language files. Normal file opening is NEVER intercepted:
// users explicitly opt in per file via Open With / Reopen With, the explorer
// context menu, or the command palette.

const vscode = require('vscode');
const path = require('path');
const { LangEditorProvider, VIEW_TYPE } = require('./src/panel');
const { ModelRegistry } = require('./src/model');
const detection = require('./src/detection');
const { t } = require('./src/i18n');

const cmdOpenEditor = 'minecraftLanguageEditor.openEditor';

async function openEditorFor(uri) {
    if (!uri || uri.scheme !== 'file') {
        return false;
    }
    const name = path.basename(uri.fsPath);
    if (!detection.isLangFileName(name)) {
        vscode.window.showInformationMessage(`${t('notLangFile')}: ${name}${t('langFileHint')}`);
        return false;
    }
    try {
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(t('openEditorFail') + ': ' + (err instanceof Error ? err.message : String(err)));
        return false;
    }
}

function activate(context) {
    const registry = new ModelRegistry();
    context.subscriptions.push({ dispose: () => registry.disposeAll() });

    // Native custom editor — appears in "Open With..." / "Reopen Editor With..."
    // for Minecraft language files. priority: option => never takes over by default.
    const provider = new LangEditorProvider(context, registry);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false
        })
    );

    // Ctrl+Enter / Ctrl+Shift+Enter (contributed keybindings) → new key.
    context.subscriptions.push(
        vscode.commands.registerCommand('minecraftLanguageEditor.addKeyShortcut', () => {
            provider.broadcast({ type: 'cmdAddKey' });
        })
    );

    // Ctrl+Z / Ctrl+Y inside our GUI must undo OUR edits (never VS Code's own
    // undo on other editors), so route them through the GUI model.
    context.subscriptions.push(
        vscode.commands.registerCommand('minecraftLanguageEditor.undoKeys', () => {
            provider.broadcast({ type: 'cmdUndo' });
        }),
        vscode.commands.registerCommand('minecraftLanguageEditor.redoKeys', () => {
            provider.broadcast({ type: 'cmdRedo' });
        })
    );

    // Manual entry points: explorer context menu / command palette / editor title.
    context.subscriptions.push(
        vscode.commands.registerCommand(cmdOpenEditor, async (uriOrNothing) => {
            let uri = (uriOrNothing && uriOrNothing.fsPath) ? uriOrNothing : undefined;
            if (!uri) {
                const active = vscode.window.activeTextEditor;
                uri = active ? active.document.uri : undefined;
            }
            if (!uri) {
                vscode.window.showInformationMessage(t('pickLangHint'));
                return;
            }
            await openEditorFor(uri);
        })
    );

    console.log('[minecraft-language-editor] active');
}

function deactivate() {}

module.exports = { activate, deactivate };
