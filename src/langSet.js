'use strict';

// Normalized multi-language model for one folder of Minecraft language files.
// Pure logic (no vscode dependency): buildState / ops / serialization, unit-testable.

const detection = require('./detection');

/**
 * State shape:
 * {
 *   langs:  string[],                    // editable language codes, alphabetical
 *   broken: [{code, name, error}],       // files that could not be parsed (never rewritten)
 *   keys:   string[],                    // canonical (union) key order
 *   values: { [key]: { [code]: string } }, // only non-empty values are stored; missing => ''
 *   files:  { [code]: { name, indent: string|null, bom, crlf, trailingNewline } },
 *   fileOrders: { [code]: string[] }     // keys each file originally declared (in file order)
 * }
 */

/** @param {string} code */
function isLangCode(code, state) {
    return Array.isArray(state.langs) && state.langs.includes(code);
}

/** @param {string} key */
function hasKey(key, state) {
    return state.keys.includes(key);
}

/**
 * @param {string} key
 * @param {string} code
 */
function getValue(key, code, state) {
    const byLang = state.values[key];
    if (byLang && typeof byLang[code] === 'string') {
        return byLang[code];
    }
    return '';
}

function setValueInto(key, code, value, state) {
    if (value === '') {
        const byLang = state.values[key];
        if (byLang) {
            delete byLang[code];
        }
        return;
    }
    let byLang = state.values[key];
    if (!byLang) {
        byLang = {};
        state.values[key] = byLang;
    }
    byLang[code] = value;
}

/**
 * Build a state from a list of files.
 * @param {Array<{code:string, name:string, text:string}>} entries  (code/name lowercase)
 * @returns {object} state
 */
function buildState(entries) {
    const sorted = [...entries].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const state = {
        langs: [],
        broken: [],
        keys: [],
        values: {},
        files: {},
        fileOrders: {}
    };
    for (const entry of sorted) {
        const analysis = detection.analyzeFile(entry.name, entry.text);
        const code = entry.code || analysis.code;
        if (!analysis.parseOk || !analysis.flat || !code) {
            state.broken.push({
                code: code || '',
                name: entry.name,
                error: analysis.parseOk && !analysis.flat
                    ? '不是扁平字符串映射（不支持该 JSON 结构）'
                    : (analysis.error || '解析失败')
            });
            continue;
        }
        state.langs.push(code);
        // Remember which characters were originally written as \uXXXX escapes
        // so they can be preserved on write (instead of silently converting the
        // file's escape style to real characters).
        const escSet = new Set();
        const escRe = /\\u([0-9a-fA-F]{4})/g;
        let escM;
        const rawText = String(entry.text).replace(/^\uFEFF/, '');
        while ((escM = escRe.exec(rawText)) !== null) {
            escSet.add(parseInt(escM[1], 16));
        }
        state.files[code] = {
            name: entry.name,
            indent: analysis.indent,
            bom: analysis.bom,
            crlf: analysis.crlf,
            trailingNewline: analysis.trailingNewline,
            usedUnicodeEscapes: escSet.size > 0,
            escapePoints: escSet
        };
        const order = [];
        const value = analysis.value || {};
        for (const key of analysis.order) {
            order.push(key);
            if (typeof value[key] === 'string' && value[key] !== '') {
                setValueInto(key, code, value[key], state);
            }
        }
        state.fileOrders[code] = order;
        for (const key of order) {
            if (!state.keys.includes(key)) {
                state.keys.push(key);
            }
        }
    }
    return state;
}

/**
 * Apply a mutation op to the state. Ops never throw; they return {ok, applied?, error?}.
 * Supported ops:
 *   {type:'setValue', key, code, value}
 *   {type:'addKey',   key, code, value}   code: the language that provides the initial value (may be '')
 *   {type:'removeKeys', keys: string[]}
 *   {type:'renameKey', oldKey, newKey}
 * All cross-language ops update every editable language at once.
 */
function applyOp(state, op) {
    switch (op.type) {
        case 'setValue': {
            if (!hasKey(op.key, state)) {
                return { ok: false, error: `key 不存在: ${op.key}` };
            }
            if (!isLangCode(op.code, state)) {
                return { ok: false, error: `语言不存在: ${op.code}` };
            }
            if (typeof op.value !== 'string') {
                return { ok: false, error: '值必须是字符串' };
            }
            const old = getValue(op.key, op.code, state);
            if (old === op.value) {
                return { ok: true, applied: false };
            }
            setValueInto(op.key, op.code, op.value, state);
            return { ok: true, applied: true };
        }
        case 'addKey': {
            if (typeof op.key !== 'string' || op.key.trim() === '') {
                return { ok: false, error: 'key 不能为空' };
            }
            if (hasKey(op.key, state)) {
                return { ok: false, error: `key 已存在: ${op.key}` };
            }
            if (!isLangCode(op.code, state)) {
                return { ok: false, error: `语言不存在: ${op.code}` };
            }
            if (typeof op.value !== 'string') {
                return { ok: false, error: '值必须是字符串' };
            }
            state.keys.push(op.key);
            if (op.value !== '') {
                setValueInto(op.key, op.code, op.value, state);
                state.fileOrders[op.code].push(op.key); // "owned" by the language that defined it
            }
            return { ok: true, applied: true };
        }
        case 'removeKeys': {
            if (!Array.isArray(op.keys) || op.keys.length === 0) {
                return { ok: false, error: '没有要删除的 key' };
            }
            for (const key of op.keys) {
                if (!hasKey(key, state)) {
                    return { ok: false, error: `key 不存在: ${key}` };
                }
            }
            for (const key of op.keys) {
                state.keys = state.keys.filter((k) => k !== key);
                delete state.values[key];
                for (const code of state.langs) {
                    state.fileOrders[code] = state.fileOrders[code].filter((k) => k !== key);
                }
            }
            return { ok: true, applied: true };
        }
        case 'renameKey': {
            const oldKey = op.oldKey;
            const newKey = op.newKey;
            if (typeof newKey !== 'string' || newKey.trim() === '') {
                return { ok: false, error: '新 key 不能为空' };
            }
            if (!hasKey(oldKey, state)) {
                return { ok: false, error: `key 不存在: ${oldKey}` };
            }
            if (oldKey === newKey) {
                return { ok: true, applied: false };
            }
            if (hasKey(newKey, state)) {
                return { ok: false, error: `key 已存在: ${newKey}` };
            }
            const idx = state.keys.indexOf(oldKey);
            state.keys[idx] = newKey;
            if (state.values[oldKey]) {
                state.values[newKey] = state.values[oldKey];
                delete state.values[oldKey];
            }
            for (const code of state.langs) {
                const o = state.fileOrders[code];
                const i = o.indexOf(oldKey);
                if (i !== -1) {
                    o[i] = newKey;
                }
            }
            return { ok: true, applied: true };
        }
        default:
            return { ok: false, error: `未知操作: ${op.type}` };
    }
}

/**
 * Escape every non-ASCII character (code > 0x7e) as \uXXXX. ASCII letters,
 * digits and symbols are left untouched (surrogates are escaped as pairs).
 */
function escapeNonAscii(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c > 0x7e) {
            out += '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
        } else {
            out += text[i];
        }
    }
    return out;
}

/**
 * Escape only the code points that the original file had written as \uXXXX
 * (so § stays \u00A7 while previously-real characters like 中文 stay real).
 */
function escapeBySet(text, codePoints) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c > 0x7e && codePoints.has(c)) {
            out += '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
        } else {
            out += text[i];
        }
    }
    return out;
}

/**
 * Serialize one language file back to text, preserving per-file key order:
 * keys the file originally declared (in that order), then union keys it is missing
 * appended in canonical order (empty values => "" placeholders).
 * @param {object} [opts] { escapeNonAscii?: boolean, preserveEscapes?: boolean }
 */
function serializeFile(state, code, defaultIndent, opts) {
    const file = state.files[code];
    if (!file || state.broken.some((b) => b.code === code)) {
        return null;
    }
    const unit = file.indent || defaultIndent || '  ';
    const owned = state.fileOrders[code] || [];
    const emitted = new Set();
    const obj = {};
    for (const key of owned) {
        emitted.add(key);
        obj[key] = getValue(key, code, state);
    }
    for (const key of state.keys) {
        if (!emitted.has(key)) {
            obj[key] = getValue(key, code, state);
        }
    }
    let json = JSON.stringify(obj, null, unit === '' ? null : unit);
    if (json === undefined) {
        json = '{}';
    }
    if (opts && opts.escapeNonAscii) {
        // Non-ASCII only ever appears inside string literals, so escaping the
        // whole serialized text is safe. (CRLF handled afterwards.)
        json = escapeNonAscii(json);
    } else if (opts && opts.preserveEscapes && file.usedUnicodeEscapes && file.escapePoints) {
        json = escapeBySet(json, file.escapePoints);
    }
    if (file.crlf) {
        json = json.replace(/\n/g, '\r\n');
    }
    if (file.trailingNewline) {
        json += file.crlf ? '\r\n' : '\n';
    }
    return (file.bom ? '\uFEFF' : '') + json;
}

/**
 * Serialize every editable file.
 * @returns {Object<string,string>} code -> text
 */
function serializeAll(state, defaultIndent, opts) {
    const out = {};
    for (const code of state.langs) {
        out[code] = serializeFile(state, code, defaultIndent, opts);
    }
    return out;
}

/**
 * Per-language + global stats used by the UI.
 */
function stats(state) {
    const perLang = {};
    const total = state.keys.length;
    for (const code of state.langs) {
        let missing = 0;
        for (const key of state.keys) {
            if (getValue(key, code, state) === '') {
                missing++;
            }
        }
        perLang[code] = { total, missing, translated: total - missing };
    }
    return { total, perLang };
}

module.exports = {
    buildState,
    applyOp,
    getValue,
    serializeFile,
    serializeAll,
    stats,
    escapeNonAscii
};
