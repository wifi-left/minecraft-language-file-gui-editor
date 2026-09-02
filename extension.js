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

const cmdOpenEditor = 'minecraftLanguageEditor.openEditor';

async function openEditorFor(uri) {
    if (!uri || uri.scheme !== 'file') {
        return false;
    }
    const name = path.basename(uri.fsPath);
    if (!detection.isLangFileName(name)) {
        vscode.window.showInformationMessage(`${name} 不是 Minecraft 语言文件（如 en_us.json / zh_cn.json）。`);
        return false;
    }
    try {
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
        return true;
    } catch (err) {
        vscode.window.showErrorMessage('打开语言编辑器失败: ' + (err instanceof Error ? err.message : String(err)));
        return false;
    }
}

function activate(context) {
    const registry = new ModelRegistry();
    context.subscriptions.push({ dispose: () => registry.disposeAll() });

    // Native custom editor — appears in "Open With..." / "Reopen Editor With..."
    // for Minecraft language files. priority: option => never takes over by default.
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, new LangEditorProvider(context, registry), {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false
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
                vscode.window.showInformationMessage('请先打开一个 Minecraft 语言文件（如 en_us.json / zh_cn.json），或右键资源管理器中的语言文件。');
                return;
            }
            await openEditorFor(uri);
        })
    );

    console.log('[minecraft-language-editor] active');
}

function deactivate() {}

module.exports = { activate, deactivate };
