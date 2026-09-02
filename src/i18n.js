'use strict';

// Shared UI strings for the extension host side (banners, dialogs, notices).
// The webview GUI has its own dictionary in media/editor.js.

const vscode = require('vscode');

const DICT = {
    reloaded: { zh: '已从磁盘重新加载（{r}）', en: 'Reloaded from disk ({r})' },
    undone: { zh: '已撤销', en: 'Undone' },
    redone: { zh: '已重做', en: 'Redone' },
    brokenSkip: { zh: '{f}: {e}（已跳过，不会被改写）', en: '{f}: {e} (skipped, never rewritten)' },
    openRaw: { zh: '打开原文件', en: 'Open file' },
    dirtySkip: {
        zh: '{f} 在原始 JSON 中有未保存修改，GUI 已跳过它；请先保存再继续',
        en: '{f} has unsaved raw edits; GUI skipped it — save it first'
    },
    saveFile: { zh: '保存文件', en: 'Save file' },
    writeFail: { zh: '写入 {f} 失败: {e}', en: 'Write {f} failed: {e}' },
    skipUnsaved: { zh: '有未保存的原始编辑，已跳过', en: 'Has unsaved edits — skipped' },
    noneUndo: { zh: '没有可撤销的操作', en: 'Nothing to undo' },
    noneRedo: { zh: '没有可重做的操作', en: 'Nothing to redo' },
    modelNotReady: { zh: '模型未就绪', en: 'Model not ready' },
    folderReadFail: { zh: '无法读取语言文件目录', en: 'Cannot read language folder' },
    notLangFile: { zh: '不是 Minecraft 语言文件', en: 'Not a Minecraft language file' },
    langFileHint: { zh: '（如 en_us.json / zh_cn.json）', en: ' (e.g. en_us.json / zh_cn.json)' },
    openEditorFail: { zh: '打开语言编辑器失败', en: 'Failed to open the language editor' },
    pickLangHint: {
        zh: '请先打开一个 Minecraft 语言文件，或右键资源管理器中的语言文件。',
        en: 'Open a Minecraft language file first, or right-click one in the explorer.'
    },
    readFail: { zh: '无法读取文件: {e}', en: 'Cannot read file: {e}' },
    flatOnly: { zh: '不是扁平字符串映射（不支持该结构）', en: 'Not a flat string map (unsupported)' },
    reasonSave: { zh: '外部保存: {f}', en: 'saved externally: {f}' },
    reasonFs: { zh: '文件系统变化', en: 'file system change' },
    reasonExternal: { zh: '外部修改: {f}', en: 'modified externally: {f}' }
};

function isZh() {
    const l = vscode.env.language;
    return !!l && l.toLowerCase().startsWith('zh');
}

/**
 * @param {string} key
 * @param {Object<string,string|number>} [vars]
 */
function t(key, vars) {
    const m = DICT[key];
    let s = m ? (isZh() ? m.zh : m.en) : key;
    if (vars) {
        for (const k of Object.keys(vars)) {
            s = s.split('{' + k + '}').join(String(vars[k]));
        }
    }
    return s;
}

module.exports = { t, isZh };
