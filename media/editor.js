// Minecraft language-file GUI editor — webview client.
// Talks to the extension host which owns the authoritative multi-file model.
// Editing typography follows VS Code's editor.fontSize/fontFamily; colors come
// from the active theme (CSS vars + per-kind fallbacks); key / value inputs get
// a completion popup (existing keys, Minecraft prefixes, %-placeholders).
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    let ROW_H = 26; // updated when the editor font size changes

    // ---------------------------------------------------------------- state
    const data = {
        langs: [],           // [{code, name}]
        broken: [],          // [{code, name, error}]
        keys: [],            // canonical key order
        values: {},          // key -> {code: value} (only non-empty)
        folderName: '',
        folderPath: ''
    };
    let primary = null;              // language code of the bound file
    let confirmDelete = true;
    let locale = 'zh';
    let visibleLangs = [];           // codes whose columns are shown
    let sort = { kind: 'none', code: null, dir: 1 }; // none | key | lang
    let filterText = '';
    let onlyMissing = false;
    const selected = new Set();
    let lastClickIdx = -1;
    let rowsCache = [];              // key list after filter/sort
    let canUndo = false;
    let canRedo = false;

    // Pending cell edits (typed but not yet committed to the host).
    const pendingCells = new Map();  // `${key}\u0000${code}` -> {value, timer}
    let activeInline = null;         // {cell, key, code, isKey, input, baseValue}
    let notices = [];                // {id, level, text, action}
    let detailKey = null;
    let draftNew = false; // true while creating a brand-new key in the detail pane
    let showNewlineEscape = true; // grid shows real newlines escaped when on

    // ---------------------------------------------------------------- dom
    const $ = (id) => document.getElementById(id);
    const els = {
        app: $('app'),
        folderBadge: $('folderBadge'),
        bindInfo: $('bindInfo'),
        notices: $('notices'),
        undo: $('btnUndo'), redo: $('btnRedo'),
        add: $('btnAdd'), del: $('btnDelete'), reload: $('btnReload'),
        filter: $('filterInput'), onlyMissingChk: $('onlyMissingCheck'),
        langChips: $('langChips'),
        addBar: $('addBar'), addKey: $('addKeyInput'), addValue: $('addValueInput'),
        addOk: $('addOk'), addCancel: $('addCancel'), addLang: $('addLangSelect'),
        headRow: $('headRow'),
        gridWrap: $('gridWrap'),
        bodyScroll: $('bodyScroll'), rowSpacer: $('rowSpacer'),
        emptyState: $('emptyState'),
        detail: $('detail'), detailRows: $('detailRows'),
        placeholderWarn: $('placeholderWarn'),
        btnCopyKey: $('btnCopyKey'), btnDeleteOne: $('btnDeleteOne'), btnCloseDetail: $('btnCloseDetail'),
        statText: $('statText')
    };
    let checkAllInput = null; // re-created with each header render

    const I18N = {
        reload: { zh: '重载', en: 'Reload' },
        detailTitle: { zh: '详情', en: 'Details' },
        noRows: { zh: '无匹配 key', en: 'No matching keys' },
        noKeysHint: { zh: '暂无翻译 key，点“＋ 添加”创建', en: 'No keys yet — use “＋ Add”' },
        brokenOnly: { zh: '无可用的语言文件，请修复原始 JSON', en: 'No usable files — fix the JSON first' },
        copied: { zh: '已复制', en: 'Copied' },
        prefix: { zh: '前缀', en: 'prefix' },
        complete: { zh: '完整', en: 'ok' },
        missing: { zh: '缺', en: 'miss' },
        placeholder: { zh: '占位符', en: 'ph' },
        existing: { zh: '已存在，已定位', en: 'exists, jumped' },
        mCut: { zh: '剪切', en: 'Cut' },
        mCopy: { zh: '复制', en: 'Copy' },
        mPaste: { zh: '粘贴', en: 'Paste' },
        mSelAll: { zh: '全选', en: 'Select all' },

        // toolbar
        uiUndo: { zh: '↩', en: '↩' },
        uiRedo: { zh: '↪', en: '↪' },
        uiAdd: { zh: '＋ 添加', en: '＋ Add' },
        uiDelete: { zh: '🗑', en: '🗑' },
        uiReloadTitle: { zh: '从磁盘重载', en: 'Reload from disk' },
        uiUndoTitle: { zh: '撤销 (Ctrl+Z)', en: 'Undo (Ctrl+Z)' },
        uiRedoTitle: { zh: '重做 (Ctrl+Y)', en: 'Redo (Ctrl+Y)' },
        uiAddTitle: { zh: '新增翻译 key（写入所有语言）', en: 'New key (all languages)' },
        uiDeleteTitle: { zh: '删除所选（所有语言）', en: 'Delete selected' },
        uiFilterPh: { zh: '筛 key / 译文  (/)', en: 'Filter keys / text  (/)' },
        uiOnlyMissing: { zh: '仅未译', en: 'missing' },
        uiAddKeyPh: { zh: 'key，如 item.minecraft.x', en: 'key e.g. item.minecraft.x' },
        uiAddValPh: { zh: '译文（其它语言留空）', en: 'value (others stay empty)' },
        uiLang: { zh: '语言', en: 'Lang' },
        uiCancel: { zh: '取消', en: 'Cancel' },
        uiOkAdd: { zh: '添加', en: 'Add' },
        uiCur: { zh: '当前', en: 'Open' },
        uiAutoSave: { zh: '自动保存', en: 'auto-saved' },

        // dock / nav
        dockBottomT: { zh: '停靠底部', en: 'Dock bottom' },
        dockLeftT: { zh: '停靠左侧', en: 'Dock left' },
        dockRightT: { zh: '停靠右侧', en: 'Dock right' },
        dockFullT: { zh: '全屏', en: 'Fullscreen' },
        navPrevT: { zh: '上一条 (Ctrl+↑)', en: 'Prev (Ctrl+↑)' },
        navNextT: { zh: '下一条 (Ctrl+↓)', en: 'Next (Ctrl+↓)' },
        navJumpT: { zh: '跳转 key', en: 'Jump to key' },
        keyHint: { zh: 'Enter 提交', en: 'Enter to rename' },
        divBottomTitle: { zh: '拖调高度', en: 'Drag height' },
        divSideTitle: { zh: '拖调宽度', en: 'Drag width' },
        divBottomTitle2: { zh: '拖动调整详情面板高度', en: 'Drag to resize height' },
        divSideTitle2: { zh: '拖动调整详情面板宽度', en: 'Drag to resize width' },

        // context menu
        ctxCopyKey: { zh: '复制 key', en: 'Copy key' },
        ctxCopyVal: { zh: '复制译文 ({c})', en: 'Copy value ({c})' },
        ctxCopyRow: { zh: '复制条目（全部语言）', en: 'Copy entry (all)' },
        ctxDelete: { zh: '删除此 key', en: 'Delete key' },
        ctxDeleteSel: { zh: '删除所选 ({n})', en: 'Delete {n} rows' },

        // modal
        mOk: { zh: '确定', en: 'OK' },
        mCancel: { zh: '取消', en: 'Cancel' },
        mDelOk: { zh: '删除', en: 'Delete' },
        mDoNotAsk: { zh: '此后不再提醒', en: "Don't ask again" },
        mDoNotAskHint: { zh: '此后不再提醒（设置中可重开）', en: "Don't ask again (re-enable in settings)" },
        delConfirm: { zh: '从 {l} 个语言文件删除 {n} 个 key？{list}可撤销 (Ctrl+Z)', en: 'Delete {n} keys from {l} files?{list}Undoable (Ctrl+Z)' },
        reloadConfirm: { zh: '从磁盘重载？\n未保存修改会丢失，撤销历史清空', en: 'Reload from disk?\nUnsaved edits & undo history are lost' },
        jumpPrompt: { zh: '跳转 key（支持部分匹配）:', en: 'Jump to key (partial ok):' },
        jumpPh: { zh: '如 item.minecraft.diamond', en: 'e.g. item.minecraft.diamond' },
        jumpNone: { zh: '无此 key', en: 'Key not found' },
        keyEmptyWarn: { zh: 'key 不能为空', en: 'Key is empty' },
        keyExistsWarn: { zh: 'key 已存在', en: 'Key exists' },
        langOneWarn: { zh: '至少保留一列', en: 'Keep ≥1 column' },
        plWarn: { zh: '⚠ 占位符不一致: {c}', en: '⚠ placeholders differ: {c}' },
        plWarnTitle: { zh: '各语言 %s/%d 占位符不一致，游戏内可能出错', en: 'Placeholders differ across languages' },
        uiKeyTitle: { zh: '回车提交重命名（全文件同步）', en: 'Rename, Enter to commit' },
        missingCell: { zh: '〔未翻译〕', en: '(missing)' },
        stFmt: { zh: '{t} key · {l} 语言', en: '{t} keys · {l} langs' },
        stCur: { zh: '{name} {tr}/{t}', en: '{name} {tr}/{t}' },
        stBad: { zh: '损坏 {n}', en: 'broken {n}' },
        stCols: { zh: '列 {v}/{c}', en: 'cols {v}/{c}' },
        opErrorTxt: { zh: '操作失败', en: 'Failed' },
        errInitTxt: { zh: '初始化出错', en: 'Init error' }
    };
    function t(key, vars) {
        const m = I18N[key];
        let s = m ? m[locale] || m.zh : key;
        if (vars) {
            for (const k of Object.keys(vars)) {
                s = s.split('{' + k + '}').join(String(vars[k]));
            }
        }
        return s;
    }
    function translateStatic() {
        document.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = t(el.dataset.i18n);
        });
        document.querySelectorAll('[data-i18n-title]').forEach((el) => {
            el.title = t(el.dataset.i18nTitle);
        });
        document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
            el.placeholder = t(el.dataset.i18nPh);
        });
    }

    function getVal(key, code) {
        const byLang = data.values[key];
        return byLang && typeof byLang[code] === 'string' ? byLang[code] : '';
    }
    function keyOfCell(key, code) {
        return key + '\u0000' + code;
    }

    const PLACEHOLDER_RE = /%(?:[0-9]+\$)?[sdbf]|%%/gi;
    const TOKEN_RE = /%(?:[0-9]+\$)?[sdbf]|%%|§[0-9a-fk-orx]/gi;
    const COMMON_PLACEHOLDERS = ['%s', '%d', '%1$s', '%1$d', '%%'];
    const KEY_PREFIXES = [
        'advancements.', 'attribute.', 'biome.', 'block.minecraft.', 'commands.',
        'container.', 'death.', 'death.attack.', 'effect.minecraft.',
        'enchantment.minecraft.', 'entity.minecraft.', 'filled_map.', 'gameMode.',
        'gui.', 'item.minecraft.', 'itemGroup.', 'key.', 'menu.', 'message.',
        'mount.onboard.', 'options.', 'pack.', 'potion.', 'selectWorld.', 'sound.',
        'stat.', 'subtitles.', 'tile.', 'trim_pattern.', 'upgrade.', 'wiki.'
    ];

    function placeholdersOf(text) {
        const m = String(text).match(PLACEHOLDER_RE);
        return m ? m.sort() : [];
    }

    // ---------------------------------------------------------------- msg
    function post(msg) {
        vscode.postMessage(msg);
    }
    function sendOp(op) {
        if (op.type === 'setValue' && op.key === '') {
            return; // draft rows have no real key yet
        }
        post({ type: 'op', op });
    }
    function requestSnapshot() {
        post({ type: 'requestSnapshot' });
    }

    function flushPending() {
        for (const [cellKey, pending] of pendingCells) {
            const sep = cellKey.indexOf('\u0000');
            const key = cellKey.slice(0, sep);
            const code = cellKey.slice(sep + 1);
            const value = String(pending.value);
            pendingCells.delete(cellKey);
            if (pending.timer) {
                clearTimeout(pending.timer);
            }
            if (value !== getVal(key, code)) {
                sendOp({ type: 'setValue', key, code, value });
            }
        }
    }

    function cancelCellPending(key, code) {
        const ck = keyOfCell(key, code);
        const pending = pendingCells.get(ck);
        if (pending && pending.timer) {
            clearTimeout(pending.timer);
        }
        pendingCells.delete(ck);
    }

    // ------------------------------------------- per-field text undo/redo
    // VS Code webviews do not reliably get Chromium's default input undo, so
    // each editable field keeps its own small history. Consecutive typing is
    // merged into one undo step (like a normal editor); the value pipelines
    // (auto-save, empty marker, placeholder warnings) stay in sync.
    const FIELD_UNDO_GROUP_MS = 800;

    /**
     * @param {HTMLInputElement|HTMLTextAreaElement} input
     */
    function attachFieldUndo(input) {
        const snap = () => ({
            value: input.value,
            start: input.selectionStart != null ? input.selectionStart : input.value.length,
            end: input.selectionEnd != null ? input.selectionEnd : input.value.length
        });
        const states = [snap()];
        let cursor = 0;
        let topAt = 0;
        let busy = false;

        function record() {
            if (busy) {
                return;
            }
            const now = Date.now();
            const cur = states[cursor];
            if (cur.value === input.value) {
                return;
            }
            if (cursor < states.length - 1) {
                states.length = cursor + 1; // drop redo tail
            }
            const atFrontier = cursor === states.length - 1;
            if (atFrontier && cursor > 0 && now - topAt <= FIELD_UNDO_GROUP_MS) {
                states[cursor] = snap(); // extend the same typing burst
                topAt = now;
                return;
            }
            states.push(snap());
            cursor++;
            topAt = now;
            if (states.length > 500) {
                states.shift();
                cursor--;
            }
        }

        function apply(state) {
            busy = true;
            input.value = state.value;
            try {
                input.setSelectionRange(state.start, state.end);
            } catch {
                // ignore
            }
            busy = false;
            // Keep commit schedulers / warnings in sync with the restored text.
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const api = {
            undo() {
                if (cursor > 0) {
                    cursor--;
                    apply(states[cursor]);
                    return true;
                }
                return false;
            },
            redo() {
                if (cursor < states.length - 1) {
                    cursor++;
                    apply(states[cursor]);
                    return true;
                }
                return false;
            },
            canUndo() {
                return cursor > 0;
            },
            canRedo() {
                return cursor < states.length - 1;
            }
        };
        input.addEventListener('input', record);
        input.addEventListener('focus', () => {
            // Rebase when the value changed externally while unfocused.
            const cur = states[cursor];
            if (cur && cur.value !== input.value) {
                states.length = 0;
                states.push(snap());
                cursor = 0;
                topAt = 0;
            }
        });
        input.fieldUndo = api;
        return api;
    }

    // ------------------------------------------------- font + theme (host)
    function kindName(kind) {
        // kind: 'light' | 'dark' | 'hc' | 'hcl'
        return kind || 'dark';
    }
    function applyUiConfig(cfg) {
        if (!cfg) {
            return;
        }
        const rootStyle = document.documentElement.style;
        const fs = Math.min(40, Math.max(8, Number(cfg.fontSize) || 14));
        rootStyle.setProperty('--edit-font-size', fs + 'px');
        if (cfg.fontFamily) {
            rootStyle.setProperty('--edit-font-family', cfg.fontFamily);
        }
        document.body.setAttribute('data-kind', kindName(cfg.themeKind));
        // Row height scales with the editor font so taller text never clips.
        ROW_H = Math.max(18, Math.round(fs * 1.5 + 6));
        rootStyle.setProperty('--row-h', ROW_H + 'px');
        // Re-layout with the new metrics.
        const scrolledTop = els.bodyScroll.scrollTop;
        refreshRows();
        renderHeader();
        els.bodyScroll.scrollTop = scrolledTop;
        syncHeadWidth();
    }

    // ----------------------------------------------------- value rendering
    /**
     * Append value text with theme-colored placeholder / format tokens.
     * Used for single-line grid cells only: real newlines are shown as the
     * literal escape "\n" (the detail panel edits with actual newlines).
     */
    function appendValue(parent, value) {
        if (!value) {
            return;
        }
        let display = String(value);
        if (showNewlineEscape) {
            const nl = String.fromCharCode(10);
            const esc = String.fromCharCode(92) + 'n';
            display = display.split(String.fromCharCode(13)).join('').split(nl).join(esc);
        }
        const text = display;
        const re = new RegExp(TOKEN_RE.source, 'gi');
        let last = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) {
                parent.appendChild(document.createTextNode(text.slice(last, m.index)));
            }
            const tok = document.createElement('span');
            tok.className = 'tok tok-ph';
            tok.textContent = m[0];
            parent.appendChild(tok);
            last = m.index + m[0].length;
        }
        if (last < text.length) {
            parent.appendChild(document.createTextNode(text.slice(last)));
        }
    }

    // ------------------------------------------------------------ render rows
    // Column width model: every track is expressed in pixels so the grid width is
    // always finite. Columns the user has not resized share the available width
    // (key column gets a wider share) and are recomputed whenever the container
    // resizes; dragged / auto-fit columns stay fixed at their chosen width.
    const COL_MIN = { key: 220, lang: 150 };
    const colSpec = { key: null, langs: {} }; // null => auto-distributed width

    function setColSpec(id, px) {
        if (id === 'key') {
            colSpec.key = Math.max(COL_MIN.key, Math.round(px));
        } else {
            colSpec.langs[id] = Math.max(COL_MIN.lang, Math.round(px));
        }
    }

    /** Pixels for the auto-distributed key column share (or its saved width). */
    function keyColW(avail, unit) {
        return colSpec.key || Math.max(COL_MIN.key, Math.round(unit * 1.4));
    }
    function langColW(unit) {
        // per-language callback is impossible; handled inline in colsTemplate
        return Math.max(COL_MIN.lang, Math.round(unit));
    }

    function colsTemplate() {
        // Base the auto-distribution on the *content* width when the grid already
        // overflows, so the horizontal scrollbar never feeds back into the layout.
        const body = els.bodyScroll;
        const avail = Math.max(body.clientWidth || 0, body.scrollWidth || 0) || 640;
        const flexCount = visibleLangs.length;
        const unit = flexCount ? Math.max(0, (avail - 28) / (1.4 + flexCount)) : 0;
        const parts = ['28px', keyColW(avail, unit) + 'px'];
        for (const code of visibleLangs) {
            const w = colSpec.langs[code] || langColW(unit);
            parts.push(w + 'px');
        }
        return parts.join(' ');
    }

    /** Apply the current column template to the header and mounted rows. */
    function applyColTemplates() {
        const t = colsTemplate();
        els.headRow.style.gridTemplateColumns = t;
        const rows = els.rowSpacer.querySelectorAll('.grid-row');
        rows.forEach((r) => {
            r.style.gridTemplateColumns = t;
        });
        window.requestAnimationFrame(syncHeadWidth);
    }

    // ---- measuring (for auto-fit) ----
    let measureCtx = null;
    function measureText(text) {
        if (!measureCtx) {
            measureCtx = document.createElement('canvas').getContext('2d');
        }
        const rootStyle = getComputedStyle(document.documentElement);
        const fs = rootStyle.getPropertyValue('--edit-font-size').trim() || '14px';
        const ff = rootStyle.getPropertyValue('--edit-font-family').trim() || 'monospace';
        measureCtx.font = '400 ' + fs + ' ' + ff;
        return measureCtx.measureText(text).width;
    }

    /** Auto-fit a column so every visible row's content is fully shown. */
    function autofitColumn(id) {
        const list = rowsCache.length ? rowsCache : data.keys;
        let maxW = 0;
        const want = (str) => {
            const w = measureText(str);
            if (w > maxW) {
                maxW = w;
            }
        };
        if (id === 'key') {
            want('key');
            for (const k of list) {
                want(k);
            }
        } else {
            const lang = data.langs.find((l) => l.code === id);
            want(lang ? lang.name : id);
            let hasEmpty = false;
            for (const k of list) {
                const v = getVal(k, id);
                if (v) {
                    want(String(v).replace(/\r?\n/g, '\\n'));
                } else {
                    hasEmpty = true;
                }
            }
            if (hasEmpty) {
                want('〔未翻译〕');
            }
        }
        setColSpec(id, maxW + 18); // cell padding + a little breathing room
        renderHeader();
        refreshRows();
    }

    function computeRows() {
        let arr = data.keys.slice();
        if (onlyMissing) {
            const p = primary || (data.langs[0] && data.langs[0].code) || null;
            if (p) {
                arr = arr.filter((k) => getVal(k, p) === '');
            }
        }
        if (filterText) {
            const f = filterText.toLowerCase();
            arr = arr.filter((k) => {
                if (k.toLowerCase().includes(f)) {
                    return true;
                }
                for (const lang of data.langs) {
                    if (getVal(k, lang.code).toLowerCase().includes(f)) {
                        return true;
                    }
                }
                return false;
            });
        }
        const { kind, code, dir } = sort;
        if (kind === 'key') {
            // Alphabetical order on the translation keys.
            arr.sort((a, b) => {
                if (a === b) {
                    return 0;
                }
                return (a < b ? -1 : 1) * dir;
            });
        } else if (kind === 'lang' && code) {
            arr.sort((a, b) => {
                const va = getVal(a, code) || '';
                const vb = getVal(b, code) || '';
                let r;
                if (va === vb) {
                    r = 0;
                } else if (va === '') {
                    r = 1;
                } else if (vb === '') {
                    r = -1;
                } else {
                    r = va < vb ? -1 : 1;
                }
                return r * dir;
            });
        }
        return arr;
    }

    function refreshRows() {
        rowsCache = computeRows();
        const total = rowsCache.length;
        els.rowSpacer.style.height = total * ROW_H + 'px';
        updateEmptyState(total);
        renderWindow();
    }

    function updateEmptyState(shown) {
        const filtered = shown === 0 && data.keys.length > 0;
        if (filtered) {
            els.emptyState.textContent = t('noRows');
            els.emptyState.classList.remove('hidden');
            return;
        }
        if (data.keys.length === 0 || data.langs.length === 0) {
            if (data.broken.length > 0 && data.langs.length === 0) {
                els.emptyState.textContent = t('brokenOnly');
            } else {
                els.emptyState.textContent = t('noKeysHint');
            }
            els.emptyState.classList.remove('hidden');
            return;
        }
        els.emptyState.classList.add('hidden');
    }

    function renderWindow() {
        const body = els.bodyScroll;
        const top = body.scrollTop;
        const height = body.clientHeight || 400;
        const first = Math.max(0, Math.floor(top / ROW_H) - 3);
        const count = Math.ceil(height / ROW_H) + 7;
        const last = Math.min(rowsCache.length, first + count);
        const frag = document.createDocumentFragment();
        const cols = colsTemplate();
        for (let i = first; i < last; i++) {
            frag.appendChild(buildRow(rowsCache[i], i, cols));
        }
        els.rowSpacer.textContent = '';
        els.rowSpacer.appendChild(frag);
        // Keep the header template in step with the rows (container resizes etc.).
        els.headRow.style.gridTemplateColumns = cols;
        syncHeadWidth();
    }

    /**
     * Keep header & row content the same width: the sum of the column widths
     * (or the scroll container width when columns fit without scrolling).
     */
    function syncHeadWidth() {
        const body = els.bodyScroll;
        let sum = 0;
        const children = els.headRow.children;
        for (let i = 0; i < children.length; i++) {
            sum += children[i].getBoundingClientRect().width;
        }
        const w = Math.max(Math.ceil(sum), body.clientWidth);
        if (els.headRow.style.width !== w + 'px') {
            els.headRow.style.width = w + 'px';
        }
        if (els.rowSpacer.style.width !== w + 'px') {
            els.rowSpacer.style.width = w + 'px';
        }
    }

    function buildRow(key, index, cols) {
        const row = document.createElement('div');
        row.className = 'grid-row' + (selected.has(key) ? ' selected' : '');
        row.style.top = index * ROW_H + 'px';
        row.style.gridTemplateColumns = cols;
        row.dataset.key = key;
        row.dataset.idx = String(index);

        const sel = document.createElement('div');
        sel.className = 'cell selcol';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(key);
        cb.dataset.key = key;
        cb.title = '选择行';
        sel.appendChild(cb);
        row.appendChild(sel);

        const keyCell = document.createElement('div');
        keyCell.className = 'cell keycol';
        keyCell.dataset.key = key;
        keyCell.title = '双击重命名 key';
        keyCell.textContent = key;
        row.appendChild(keyCell);
        row.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'gridRow' }));

        for (const code of visibleLangs) {
            const cell = document.createElement('div');
            cell.className = 'cell langcell';
            cell.dataset.key = key;
            cell.dataset.code = code;
            cell.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'gridValue' }));
            const p = pendingCells.get(keyOfCell(key, code));
            const value = p ? p.value : getVal(key, code);
            if (value === '') {
                cell.classList.add('empty');
            }
            appendValue(cell, value);
            row.appendChild(cell);
        }
        return row;
    }

    /** Create a header cell with a drag-to-resize / double-click-to-fit handle. */
    function createHeaderCell(cellClass, colId, label) {
        const cell = document.createElement('div');
        cell.className = cellClass;
        if (colId === 'key') {
            cell.dataset.action = 'sort-key';
        } else {
            cell.dataset.code = colId;
        }
        cell.title = colId === 'key' ? '点击排序' : '点击按该语言排序';
        cell.appendChild(document.createTextNode(label));

        const handle = document.createElement('div');
        handle.className = 'col-resize';
        handle.title = '拖动调整列宽 · 双击自适应内容';
        handle.dataset.col = colId;

        let drag = null;
        const minW = colId === 'key' ? COL_MIN.key : COL_MIN.lang;
        handle.addEventListener('pointerdown', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            try {
                handle.setPointerCapture(ev.pointerId);
            } catch {
                // ignore
            }
            drag = {
                x: ev.clientX,
                w: cell.getBoundingClientRect().width || minW
            };
            handle.classList.add('dragging');
            document.body.classList.add('colresizing');
        });
        handle.addEventListener('pointermove', (ev) => {
            if (!drag) {
                return;
            }
            ev.preventDefault();
            setColSpec(colId, drag.w + (ev.clientX - drag.x));
            applyColTemplates();
        });
        const endDrag = () => {
            if (!drag) {
                return;
            }
            drag = null;
            handle.classList.remove('dragging');
            document.body.classList.remove('colresizing');
            syncHeadWidth();
        };
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', endDrag);
        handle.addEventListener('dblclick', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            autofitColumn(colId);
        });
        cell.appendChild(handle);
        return cell;
    }

    function renderHeader() {
        const head = els.headRow;
        head.textContent = '';
        head.style.gridTemplateColumns = colsTemplate();
        head.style.display = 'grid';
        head.style.alignItems = 'center';

        const selCol = document.createElement('div');
        selCol.className = 'cell selcol';
        checkAllInput = document.createElement('input');
        checkAllInput.type = 'checkbox';
        checkAllInput.title = '全选';
        checkAllInput.checked = rowsCache.length > 0 && rowsCache.every((k) => selected.has(k));
        selCol.appendChild(checkAllInput);
        head.appendChild(selCol);

        const keyMark = sort.kind === 'key' ? (sort.dir === 1 ? ' ▴' : ' ▾') : '';
        head.appendChild(createHeaderCell('cell keycol head-key', 'key', 'key' + keyMark));

        for (const code of visibleLangs) {
            const name = data.langs.find((l) => l.code === code);
            const mark = sort.kind === 'lang' && sort.code === code ? (sort.dir === 1 ? ' ▴' : ' ▾') : '';
            const label = (name ? name.name : code) + mark;
            const cls = 'cell langcol' + (code === primary ? ' current' : '');
            head.appendChild(createHeaderCell(cls, code, label));
        }
        window.requestAnimationFrame(syncHeadWidth);
    }

    // ------------------------------------------------------------- selection
    function setRowSelected(key, on) {
        if (on) {
            selected.add(key);
        } else {
            selected.delete(key);
        }
        updateSelectionUi();
    }
    function updateSelectionUi() {
        els.del.disabled = selected.size === 0;
        els.btnDeleteOne.disabled = !detailKey;
        if (checkAllInput) {
            checkAllInput.checked = rowsCache.length > 0 && rowsCache.every((k) => selected.has(k));
        }
        const rows = els.rowSpacer.querySelectorAll('.grid-row');
        rows.forEach((r) => {
            r.classList.toggle('selected', selected.has(r.dataset.key));
            const cb = r.querySelector('input[type=checkbox]');
            if (cb) {
                cb.checked = selected.has(r.dataset.key);
            }
        });
    }
    function clearSelection() {
        selected.clear();
        updateSelectionUi();
    }
    function updateUndoButtons() {
        els.undo.disabled = !canUndo;
        els.redo.disabled = !canRedo;
    }

    function onRowClicked(key, index, ev) {
        if (ev.target && ev.target.tagName === 'INPUT') {
            const on = ev.target.checked;
            setRowSelected(key, on);
            lastClickIdx = index;
            ev.stopPropagation();
            return;
        }
        if (ev.shiftKey && lastClickIdx >= 0) {
            const a = Math.min(lastClickIdx, index);
            const b = Math.max(lastClickIdx, index);
            for (let i = a; i <= b; i++) {
                selected.add(rowsCache[i]);
            }
            updateSelectionUi();
            return;
        }
        if (ev.ctrlKey || ev.metaKey) {
            setRowSelected(key, !selected.has(key));
            lastClickIdx = index;
            return;
        }
        clearSelection();
        selected.add(key);
        lastClickIdx = index;
        updateSelectionUi();
    }

    // --------------------------------------------------------- completion
    /**
     * Attach a completion popup to an input/textarea.
     * @param {HTMLInputElement|HTMLTextAreaElement} input
     * @param {(query: string) => Array<{label:string, detail?:string, replaceWhole?:boolean}>} getItems
     * @returns {{close: () => void}}
     */
    function attachCompletion(input, getItems) {
        let box = null;
        let items = [];
        let idx = -1;
        let open = false;
        let suppressT = 0;

        function ensureBox() {
            if (!box) {
                box = document.createElement('div');
                box.className = 'completion-popup';
                document.body.appendChild(box);
            }
            return box;
        }
        function close() {
            open = false;
            if (box) {
                box.classList.remove('open');
                box.textContent = '';
            }
        }
        function position() {
            const rect = input.getBoundingClientRect();
            if (!rect || rect.width === 0) {
                close();
                return;
            }
            const b = ensureBox();
            const w = Math.min(Math.max(rect.width, 300), 560);
            const estH = Math.min(items.length * 22 + 8, 220);
            let top = rect.bottom + 3;
            let left = rect.left;
            if (top + estH > window.innerHeight - 6) {
                top = Math.max(6, rect.top - estH - 3);
            }
            left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
            b.style.width = w + 'px';
            b.style.top = top + 'px';
            b.style.left = left + 'px';
        }
        function choose(i) {
            const it = items[i];
            if (!it) {
                return;
            }
            if (it.replaceWhole) {
                input.value = it.label;
                const pos = it.label.length;
                input.setSelectionRange(pos, pos);
            } else {
                const s = input.selectionStart != null ? input.selectionStart : input.value.length;
                const e = input.selectionEnd != null ? input.selectionEnd : s;
                const text = input.value;
                input.value = text.slice(0, s) + it.label + text.slice(e);
                const pos = s + it.label.length;
                input.setSelectionRange(pos, pos);
            }
            suppressT = Date.now() + 300;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            close();
            input.focus();
        }
        function render() {
            if (Date.now() < suppressT) {
                return;
            }
            items = getItems(input.value) || [];
            if (!items.length) {
                close();
                return;
            }
            const b = ensureBox();
            idx = 0;
            b.textContent = '';
            items.forEach((it, i) => {
                const row = document.createElement('div');
                row.className = 'c-row' + (i === idx ? ' sel' : '');
                const l = document.createElement('span');
                l.className = 'l';
                l.textContent = it.label;
                row.appendChild(l);
                if (it.detail) {
                    const k = document.createElement('span');
                    k.className = 'k';
                    k.textContent = it.detail;
                    row.appendChild(k);
                }
                row.addEventListener('mousedown', (ev) => ev.preventDefault());
                row.addEventListener('click', () => choose(i));
                b.appendChild(row);
            });
            open = true;
            b.classList.add('open');
            position();
        }
        function nav(d) {
            if (!items.length) {
                return;
            }
            idx = (idx + d + items.length) % items.length;
            const rows = box.querySelectorAll('.c-row');
            rows.forEach((r, j) => r.classList.toggle('sel', j === idx));
            const sel = rows[idx];
            if (sel) {
                sel.scrollIntoView({ block: 'nearest' });
            }
        }
        const onKey = (ev) => {
            if (!open || !items.length) {
                return; // let the owning control handle Enter/Escape normally
            }
            if (ev.key === 'ArrowDown') {
                ev.preventDefault(); ev.stopPropagation(); nav(1); return;
            }
            if (ev.key === 'ArrowUp') {
                ev.preventDefault(); ev.stopPropagation(); nav(-1); return;
            }
            if (ev.key === 'Enter' || ev.key === 'Tab') {
                ev.preventDefault(); ev.stopPropagation();
                choose(idx < 0 ? 0 : idx);
                return;
            }
            if (ev.key === 'Escape') {
                ev.preventDefault(); ev.stopPropagation();
                close();
                return;
            }
        };
        input.addEventListener('keydown', onKey, true);
        input.addEventListener('input', () => window.setTimeout(render, 0));
        input.addEventListener('focus', () => window.setTimeout(render, 0));
        input.addEventListener('blur', () => window.setTimeout(close, 120));
        const reposition = () => { if (open) { position(); } };
        document.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return { close };
    }

    function describeKey(key) {
        const missing = [];
        for (const lang of data.langs) {
            if (getVal(key, lang.code) === '') {
                missing.push(lang.code);
            }
        }
        if (missing.length === 0) {
            return t('complete');
        }
        return t('missing') + ' ' + missing.slice(0, 3).join(' ') + (missing.length > 3 ? '…' : '');
    }

    /** Completion items for key inputs (existing keys, then Minecraft prefixes). */
    function keySuggestions(query) {
        const q = String(query).trim().toLowerCase();
        if (!q) {
            return [];
        }
        const out = [];
        for (const k of data.keys) {
            if (k.toLowerCase().includes(q)) {
                out.push({ label: k, detail: describeKey(k), replaceWhole: true });
                if (out.length >= 60) {
                    break;
                }
            }
        }
        if (out.length === 0) {
            for (const p of KEY_PREFIXES) {
                if (p.length > q.length && p.startsWith(q)) {
                    out.push({ label: p, detail: t('prefix'), replaceWhole: true });
                    if (out.length >= 30) {
                        break;
                    }
                }
            }
        }
        return out;
    }

    /** Completion items for value inputs: %-placeholders seen in other languages. */
    function placeholderSuggestions(key, code, query) {
        const q = String(query);
        const tokens = new Set();
        for (const lang of data.langs) {
            if (lang.code === code) {
                continue;
            }
            const v = getVal(key, lang.code);
            if (!v) {
                continue;
            }
            for (const tk of placeholdersOf(v)) {
                tokens.add(tk);
            }
        }
        if (tokens.size === 0) {
            if (!q.startsWith('%')) {
                return [];
            }
            for (const c of COMMON_PLACEHOLDERS) {
                if (c.startsWith(q)) {
                    tokens.add(c);
                }
            }
        }
        const arr = [...tokens]
            .filter((tk) => !q || tk.startsWith(q))
            .sort();
        return arr.map((tk) => ({ label: tk, detail: t('placeholder'), replaceWhole: false }));
    }

    // ------------------------------------------------------------- editing
    function commitInline() {
        if (!activeInline) {
            return;
        }
        const { key, code, isKey, input } = activeInline;
        const raw = input.value;
        endInlineEdit();
        if (isKey) {
            const newKey = raw.trim();
            if (newKey && newKey !== key) {
                if (data.keys.includes(newKey)) {
                    showNotice('error', `${t('keyExistsWarn')}: ${newKey}`, null);
                } else {
                    sendOp({ type: 'renameKey', oldKey: key, newKey });
                }
            }
        } else if (raw !== getVal(key, code)) {
            sendOp({ type: 'setValue', key, code, value: raw });
        }
    }

    function endInlineEdit() {
        const a = activeInline;
        activeInline = null;
        if (a && a.input) {
            try {
                a.input.blur(); // triggers blur handler, which no-ops now (activeInline cleared)
            } catch {
                // ignore
            }
        }
        renderWindow();
    }

    function startInlineEdit(cell, key, code, isKey) {
        if (activeInline) {
            commitInline();
        }
        const baseValue = isKey ? key : getVal(key, code);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-input';
        input.value = baseValue;
        input.spellcheck = false;
        input.autocomplete = 'off';
        cell.textContent = '';
        cell.appendChild(input);
        attachFieldUndo(input);
        activeInline = { cell, key, code, isKey, input, baseValue };
        if (isKey) {
            attachCompletion(input, (q) => keySuggestions(q));
        }
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                commitInline();
            } else if (ev.key === 'Escape') {
                endInlineEdit();
            }
        });
        input.addEventListener('blur', () => {
            if (activeInline && activeInline.input === input) {
                commitInline();
            }
        });
        input.focus();
        input.select();
    }

    function scheduleCellCommit(key, code, value, delay) {
        const ck = keyOfCell(key, code);
        const old = pendingCells.get(ck);
        if (old && old.timer) {
            clearTimeout(old.timer);
        }
        const timer = setTimeout(() => {
            const pending = pendingCells.get(ck);
            if (pending) {
                pendingCells.delete(ck);
                if (pending.value !== getVal(key, code)) {
                    sendOp({ type: 'setValue', key, code, value: String(pending.value) });
                }
            }
        }, delay);
        pendingCells.set(ck, { value, timer });
    }

    function flushCellOnly(key, code) {
        const ck = keyOfCell(key, code);
        const pending = pendingCells.get(ck);
        if (!pending) {
            return;
        }
        if (pending.timer) {
            clearTimeout(pending.timer);
        }
        pendingCells.delete(ck);
        if (pending.value !== getVal(key, code)) {
            sendOp({ type: 'setValue', key, code, value: String(pending.value) });
        }
    }

    /** Inline (in-cell) textarea editor for one value. */
    function startCellEdit(key, code, cell) {
        if (activeInline) {
            commitInline();
        }
        const baseValue = getVal(key, code);
        const textarea = document.createElement('textarea');
        textarea.className = 'inline-input';
        textarea.value = baseValue;
        textarea.spellcheck = false;
        textarea.autocomplete = 'off';
        textarea.rows = 1;
        cell.textContent = '';
        cell.appendChild(textarea);
        attachFieldUndo(textarea);
        activeInline = { cell, key, code, isKey: false, input: textarea, baseValue };
        attachCompletion(textarea, (q) => placeholderSuggestions(key, code, q));
        textarea.addEventListener('input', () => {
            scheduleCellCommit(key, code, textarea.value, 700);
        });
        textarea.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                flushCellOnly(key, code);
                endInlineEdit();
            } else if (ev.key === 'Escape') {
                cancelCellPending(key, code);
                endInlineEdit();
            }
        });
        textarea.addEventListener('blur', () => {
            flushCellOnly(key, code);
            if (activeInline && activeInline.input === textarea) {
                endInlineEdit();
            }
        });
        textarea.focus();
        textarea.select();
    }

    // ------------------------------------------------------------- detail
    /** Languages shown in the detail panel = currently visible columns. */
    function detailLanguages() {
        return data.langs.filter((lang) => visibleLangs.includes(lang.code));
    }

    /**
     * Editable "key" row at the top of the detail panel. Renaming commits on
     * Enter/blur (synced to every language file), Escape reverts.
     */
    function appendDetailKeyEditor(rows, key) {
        const wrap = document.createElement('div');
        wrap.className = 'detail-lang';
        const rowEl = document.createElement('div');
        rowEl.className = 'dl-key-row';
        const tag = document.createElement('span');
        tag.className = 'key-tag';
        tag.textContent = 'key';
        rowEl.appendChild(tag);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'dl-key-input';
        input.value = key;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.title = t('uiKeyTitle');
        rowEl.appendChild(input);
        attachFieldUndo(input);
        attachCompletion(input, (q) => keySuggestions(q));

        const hint = document.createElement('span');
        hint.className = 'dl-key-hint';
        hint.textContent = t('keyHint');
        rowEl.appendChild(hint);
        wrap.appendChild(rowEl);
        rows.appendChild(wrap);

        let committed = false;
        const commit = () => {
            if (committed) {
                return;
            }
            const raw = input.value.trim();
            if (key === '') {
                // Creating a brand-new key straight in the detail editor.
                if (!draftNew || els.detail.classList.contains('hidden')) {
                    return; // already canceled / closing — do nothing
                }
                if (!raw) {
                    closeDetail(); // empty draft → just cancel, no error
                    return;
                }
                if (data.keys.includes(raw)) {
                    // Already exists → abandon the draft and jump to it.
                    draftNew = false;
                    closeDetail();
                    clearSelection();
                    selected.add(raw);
                    refreshRows();
                    scrollKeyIntoView(raw);
                    openDetail(raw);
                    updateSelectionUi();
                    showNotice('info', `${t('existing')}: ${raw}`, null, 2200);
                    return;
                }
                committed = true;
                draftNew = false;
                const code = primary || (data.langs[0] && data.langs[0].code) || '';
                sendOp({ type: 'addKey', key: raw, code, value: '' });
                pendingAddKey = raw;
                return;
            }
            if (!raw) {
                showNotice('error', t('keyEmptyWarn'), null);
                input.focus();
                return;
            }
            if (raw === key) {
                return; // no change; allow further edits
            }
            if (data.keys.includes(raw)) {
                showNotice('error', `${t('keyExistsWarn')}: ${raw}`, null);
                input.focus();
                return;
            }
            committed = true;
            sendOp({ type: 'renameKey', oldKey: key, newKey: raw });
        };
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                ev.stopPropagation();
                commit();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                if (key === '') {
                    closeDetail(); // cancel an empty draft
                    return;
                }
                if (!committed) {
                    input.value = key;
                    input.setSelectionRange(key.length, key.length);
                }
            }
        });
        input.addEventListener('blur', commit);
        input.addEventListener('focus', () => input.select());
    }

    function openDetail(key) {
        if (activeInline) {
            commitInline();
        }
        flushPending();
        detailKey = key;
        els.btnDeleteOne.disabled = false;
        const rows = els.detailRows;
        rows.textContent = '';
        appendDetailKeyEditor(rows, key);

        for (const lang of detailLanguages()) {
            const wrap = document.createElement('div');
            wrap.className = 'detail-lang';
            const l = document.createElement('div');
            l.className = 'dl-label';
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.textContent = lang.name;
            l.appendChild(chip);
            if (lang.code === primary) {
                const tag = document.createElement('span');
                tag.textContent = locale === 'zh' ? '(当前文件)' : '(current)';
                tag.style.opacity = '0.7';
                l.appendChild(tag);
            }
            wrap.appendChild(l);
            const ta = document.createElement('textarea');
            ta.spellcheck = false;
            ta.autocomplete = 'off';
            const val = getVal(key, lang.code);
            ta.value = val;
            // Initial height follows the number of lines, capped at 8 rows.
            const lineCount = val ? val.split('\n').length : 1;
            ta.rows = Math.min(8, Math.max(2, lineCount));
            ta.dataset.code = lang.code;
            ta.classList.toggle('empty', val === '');
            attachFieldUndo(ta);
            attachCompletion(ta, (q) => placeholderSuggestions(key, lang.code, q));
            ta.addEventListener('input', () => {
                ta.classList.toggle('empty', ta.value === '');
                scheduleCellCommit(key, lang.code, ta.value, 600);
                updatePlaceholderWarn(key);
            });
            ta.addEventListener('blur', () => {
                flushCellOnly(key, lang.code);
            });
            wrap.appendChild(ta);
            rows.appendChild(wrap);
        }
        els.detail.classList.remove('hidden');
        if (els.dockDivider) {
            els.dockDivider.style.display = '';
        }
        applyDockLayout();
        updatePlaceholderWarn(key);
    }

    // -------------------------------------------------- detail panel layout
    // Dock modes: 'bottom' | 'left' | 'right' | 'full'. Sizes are remembered
    // separately for bottom (height) and side (width) docking.
    let detailDock = 'bottom';
    let dockBottomH = null;   // px, only set once the user drags
    let dockSideW = 460;      // px width when docked left/right

    function setDock(mode) {
        detailDock = mode;
        applyDockLayout();
    }
    function applyDockLayout() {
        const ws = els.workspace;
        const divider = els.dockDivider;
        if (!ws || !divider || els.detail.classList.contains('hidden')) {
            if (divider) {
                divider.style.display = 'none';
            }
            return;
        }
        const isBottom = detailDock === 'bottom';
        const isSide = detailDock === 'left' || detailDock === 'right';
        const isFull = detailDock === 'full';

        ws.className = 'dock-' + detailDock;
        els.detail.classList.toggle('fullscreen', isFull);
        els.detail.classList.toggle('hidden', false);

        // Flex order inside the workspace: grid & divider & detail placement.
        const grid = els.gridWrap;
        const detail = els.detail;
        if (isBottom) {
            grid.style.order = '0';
            divider.style.order = '1';
            detail.style.order = '2';
            divider.style.width = '';
            divider.style.height = '';
            divider.style.flexBasis = '';
            detail.style.width = '';
            detail.style.height = dockBottomH ? dockBottomH + 'px' : '';
            detail.style.maxHeight = dockBottomH ? 'none' : '';
        } else if (isSide) {
            detail.style.order = detailDock === 'left' ? '0' : '2';
            divider.style.order = detailDock === 'left' ? '1' : '1';
            grid.style.order = detailDock === 'left' ? '2' : '0';
            detail.style.height = '';
            detail.style.maxHeight = 'none';
            detail.style.width = dockSideW + 'px';
            divider.style.width = '';
            divider.style.height = '';
            divider.style.flexBasis = '';
        }
        if (isFull) {
            // Fullscreen overlays the whole webview: drop any leftover inline
            // sizing/order from the previous dock so inset:0 really fills it.
            divider.style.display = 'none';
            detail.style.width = '';
            detail.style.height = '';
            detail.style.maxHeight = '';
            detail.style.order = '';
            grid.style.order = '';
            divider.style.order = '';
        } else {
            divider.style.display = '';
        }
        divider.title = isBottom
            ? t('divBottomTitle2')
            : t('divSideTitle2');

        window.requestAnimationFrame(renderWindow);
        syncUndockButtons();
    }
    function syncUndockButtons() {
        const group = els.dockBtnGroup;
        if (!group) {
            return;
        }
        group.querySelectorAll('button').forEach((b) => {
            b.classList.toggle('active', b.dataset.dock === detailDock);
        });
    }
    /** Called on user layout actions: remember sizes (host globalState) and dock
     *  position (also written to the `detailDock` setting by the host). */
    function persistDockState() {
        post({
            type: 'layoutChange',
            dock: detailDock,
            bottomH: dockBottomH || null,
            sideW: dockSideW
        });
    }
    function dockMaxFor(isSide) {
        if (isSide) {
            return Math.max(200, window.innerWidth - 320);
        }
        return Math.max(120, window.innerHeight - 200);
    }

    function updatePlaceholderWarn(key) {
        const sets = new Map();
        for (const lang of detailLanguages()) {
            const v = getVal(key, lang.code);
            if (v === '') {
                continue;
            }
            sets.set(lang.code, placeholdersOf(v));
        }
        const first = sets.size ? [...sets.values()][0] : null;
        const mismatch = [];
        if (first !== null) {
            for (const [code, ph] of sets) {
                if (ph.length !== first.length || ph.some((p, i) => p !== first[i])) {
                    mismatch.push(code);
                }
            }
        }
        const warn = els.placeholderWarn;
        if (mismatch.length) {
            warn.textContent = t('plWarn', { c: mismatch.join(', ') });
            warn.title = t('plWarnTitle');
            warn.classList.remove('hidden');
        } else {
            warn.classList.add('hidden');
        }
    }

    function closeDetail() {
        flushPending();
        detailKey = null;
        draftNew = false;
        els.detail.classList.add('hidden');
        if (els.dockDivider) {
            els.dockDivider.style.display = 'none';
        }
        els.placeholderWarn.classList.add('hidden');
    }

    // ----------------------------------------- themed modal dialogs
    // window.confirm / window.prompt are blocked inside VS Code webviews, so we
    // render our own theme-styled modal for confirmations and text input.
    let modalLayer = null;
    let pendingModal = null;
    function isModalOpen() {
        return pendingModal !== null;
    }
    function closeModal(value) {
        const r = pendingModal;
        pendingModal = null;
        if (modalLayer) {
            modalLayer.classList.add('hidden');
            modalLayer.textContent = '';
        }
        if (r) {
            r(value);
        }
    }
    function modalBox() {
        if (!modalLayer) {
            modalLayer = document.createElement('div');
            modalLayer.className = 'modal-layer hidden';
            modalLayer.addEventListener('mousedown', (ev) => {
                if (ev.target === modalLayer) {
                    closeModal(null);
                }
            });
            document.body.appendChild(modalLayer);
        }
        modalLayer.classList.remove('hidden');
        modalLayer.textContent = '';
        const box = document.createElement('div');
        box.className = 'modal-box';
        modalLayer.appendChild(box);
        return box;
    }
    function modalButton(label, accent) {
        const b = document.createElement('button');
        b.className = 'tb' + (accent ? ' accent' : '');
        b.textContent = label;
        return b;
    }
    /**
     * Themed confirm dialog. Without `rememberLabel` it resolves to a boolean;
     * with one it resolves to `true` / `'always'` / `false`.
     */
    function uiConfirm(message, okLabel, cancelLabel, rememberLabel) {
        return new Promise((resolve) => {
            pendingModal = resolve;
            const box = modalBox();
            const msg = document.createElement('div');
            msg.className = 'modal-msg';
            msg.textContent = message;
            box.appendChild(msg);
            let remember = null;
            if (rememberLabel) {
                const row = document.createElement('label');
                row.className = 'modal-remember';
                remember = document.createElement('input');
                remember.type = 'checkbox';
                row.appendChild(remember);
                row.appendChild(document.createTextNode(rememberLabel));
                box.appendChild(row);
            }
            const btns = document.createElement('div');
            btns.className = 'modal-btns';
            const cancel = modalButton(cancelLabel || t('mCancel'));
            const ok = modalButton(okLabel || t('mOk'), true);
            cancel.addEventListener('click', () => closeModal(false));
            ok.addEventListener('click', () => {
                closeModal(remember && remember.checked ? 'always' : true);
            });
            btns.append(cancel, ok);
            box.appendChild(btns);
            ok.focus();
        });
    }
    function uiPrompt(message, value, okLabel, placeholder) {
        return new Promise((resolve) => {
            pendingModal = resolve;
            const box = modalBox();
            const msg = document.createElement('div');
            msg.className = 'modal-msg';
            msg.textContent = message;
            box.appendChild(msg);
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'modal-input';
            input.value = value || '';
            input.spellcheck = false;
            if (placeholder) {
                input.placeholder = placeholder;
            }
            box.appendChild(input);
            const btns = document.createElement('div');
            btns.className = 'modal-btns';
            const cancel = modalButton(t('mCancel'));
            const ok = modalButton(okLabel || t('mOk'), true);
            cancel.addEventListener('click', () => closeModal(null));
            ok.addEventListener('click', () => closeModal(input.value));
            const onEnter = (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    closeModal(input.value);
                }
            };
            input.addEventListener('keydown', onEnter);
            btns.append(cancel, ok);
            box.appendChild(btns);
            input.focus();
            input.select();
        });
    }

    async function removeKeys(keyList) {
        if (!keyList.length) {
            return;
        }
        if (confirmDelete) {
            let msg = `确定要从所有 ${data.langs.length} 个语言文件中删除 ${keyList.length} 个 key 吗？`;
            if (keyList.length <= 10) {
                msg += `\n\n${keyList.join('\n')}`;
            }
            msg += '\n\n此操作可撤销 (Ctrl+Z)。';
            const res = await uiConfirm(msg, t('mDelOk'), t('mCancel'), t('mDoNotAsk'));
            if (res === false) {
                return;
            }
            if (res === 'always') {
                // Remember the choice & write it to the VS Code setting.
                confirmDelete = false;
                post({ type: 'setConfirmDelete', value: false });
            }
        }
        sendOp({ type: 'removeKeys', keys: keyList });
    }

    function scrollKeyIntoView(key) {
        let idx = rowsCache.indexOf(key);
        if (idx < 0) {
            refreshRows();
            idx = rowsCache.indexOf(key);
            if (idx < 0) {
                return;
            }
        }
        const body = els.bodyScroll;
        const top = idx * ROW_H;
        if (top < body.scrollTop || top > body.scrollTop + body.clientHeight - ROW_H) {
            body.scrollTop = Math.max(0, top - body.clientHeight / 2);
        }
    }

    // ---------------------------------------------------------------- toolbar
    function renderLangChips() {
        const wrap = els.langChips;
        wrap.textContent = '';
        const total = data.keys.length;
        for (const lang of data.langs) {
            let missing = 0;
            for (const k of data.keys) {
                if (getVal(k, lang.code) === '') {
                    missing++;
                }
            }
            const chip = document.createElement('span');
            chip.className = 'lang-chip' +
                (visibleLangs.includes(lang.code) ? '' : ' off') +
                (lang.code === primary ? ' primary' : '') +
                (missing > 0 ? ' missing' : '');
            chip.title = `${lang.name} · 已翻译 ${total - missing}/${total} · 点击显示/隐藏列`;
            chip.dataset.code = lang.code;
            const dot = document.createElement('span');
            dot.className = 'dot';
            chip.appendChild(dot);
            chip.appendChild(document.createTextNode(`${lang.code} ${total - missing}/${total}`));
            chip.addEventListener('click', () => {
                toggleLangColumn(lang.code);
            });
            wrap.appendChild(chip);
        }
        if (checkAllInput) {
            checkAllInput.disabled = data.langs.length === 0;
        }
    }

    function toggleLangColumn(code) {
        if (visibleLangs.length === 1 && visibleLangs[0] === code) {
            showNotice('warn', t('langOneWarn'), null);
            return;
        }
        const i = visibleLangs.indexOf(code);
        if (i >= 0) {
            visibleLangs.splice(i, 1);
        } else {
            visibleLangs.push(code);
        }
        renderHeader();
        renderLangChips();
        refreshRows();
        // The detail panel below only shows the visible columns, so keep it in sync.
        if (detailKey) {
            openDetail(detailKey);
        }
    }

    function updateStatsText() {
        const total = data.keys.length;
        const l = data.langs.length;
        const parts = [t('stFmt', { t: total, l })];
        const p = primary || (data.langs[0] && data.langs[0].code);
        if (p) {
            const shown = data.langs.find((x) => x.code === p);
            const name = shown ? shown.name : p;
            let trn = 0;
            for (const k of data.keys) {
                if (getVal(k, p) !== '') {
                    trn++;
                }
            }
            parts.push(t('stCur', { name, tr: trn, t: total }));
        }
        if (data.broken.length) {
            parts.push(t('stBad', { n: data.broken.length }));
        }
        if (visibleLangs.length < l) {
            parts.push(t('stCols', { v: visibleLangs.length, c: l }));
        }
        els.statText.textContent = parts.join(' · ');
    }

    function showNotice(level, text, action, timeoutMs) {
        const existing = [...els.notices.querySelectorAll('.notice')].some((n) =>
            n.classList.contains(level) && n.querySelector('.n-text').textContent === text);
        if (existing) {
            return;
        }
        const id = 'n' + Date.now() + Math.random().toString(36).slice(2);
        notices.push({ id, level, text, action });
        if (notices.length > 4) {
            const removed = notices.shift();
            const old = document.getElementById(removed.id);
            if (old) {
                old.remove();
            }
        }
        const el = document.createElement('div');
        el.className = 'notice ' + level;
        el.id = id;
        const txt = document.createElement('span');
        txt.className = 'n-text';
        txt.textContent = text;
        el.appendChild(txt);
        if (action) {
            const b = document.createElement('button');
            b.textContent = action.label;
            b.addEventListener('click', () => {
                post({ type: 'noticeAction', id: action.id });
                el.remove();
            });
            el.appendChild(b);
        }
        const closeB = document.createElement('button');
        closeB.textContent = '✕';
        closeB.title = '关闭';
        closeB.addEventListener('click', () => {
            el.remove();
        });
        el.appendChild(closeB);
        els.notices.appendChild(el);
        if (timeoutMs && level === 'info') {
            setTimeout(() => {
                const n = document.getElementById(id);
                if (n) {
                    n.remove();
                }
            }, timeoutMs);
        }
    }

    // ------------------------------------------------- add via detail draft
    // "＋ 添加" reuses the detail editor: it opens the panel with an empty key
    // field; typing the key and pressing Enter creates it (all languages gain an
    // empty placeholder row) and editing continues in the same place.
    function startCreateKey() {
        if (data.langs.length === 0) {
            showNotice('warn', t('langOneWarn'), null);
            return;
        }
        if (activeInline) {
            commitInline();
        }
        flushPending();
        draftNew = true;
        clearSelection();
        updateSelectionUi();
        openDetail('');
        const input = els.detailRows ? els.detailRows.querySelector('.dl-key-input') : null;
        if (input) {
            input.focus();
        }
        els.btnDeleteOne.disabled = true;
    }
    let pendingAddKey = null;

    // --------------------------------------------------------- local apply of ops
    function applyOpLocally(op) {
        if (op.type === 'setValue') {
            let byLang = data.values[op.key];
            if (!byLang) {
                byLang = {};
                data.values[op.key] = byLang;
            }
            if (op.value === '') {
                delete byLang[op.code];
            } else {
                byLang[op.code] = op.value;
            }
        } else if (op.type === 'addKey') {
            data.keys.push(op.key);
            if (op.value !== '') {
                let byLang = data.values[op.key];
                if (!byLang) {
                    byLang = {};
                    data.values[op.key] = byLang;
                }
                byLang[op.code] = op.value;
            }
        } else if (op.type === 'removeKeys') {
            const gone = new Set(op.keys);
            data.keys = data.keys.filter((k) => !gone.has(k));
            for (const k of op.keys) {
                delete data.values[k];
            }
            for (const k of op.keys) {
                selected.delete(k);
            }
            if (detailKey && gone.has(detailKey)) {
                closeDetail();
            }
        } else if (op.type === 'renameKey') {
            const i = data.keys.indexOf(op.oldKey);
            if (i >= 0) {
                data.keys[i] = op.newKey;
            }
            if (data.values[op.oldKey]) {
                data.values[op.newKey] = data.values[op.oldKey];
                delete data.values[op.oldKey];
            }
            if (selected.has(op.oldKey)) {
                selected.delete(op.oldKey);
                selected.add(op.newKey);
            }
            if (detailKey === op.oldKey) {
                detailKey = op.newKey;
                openDetail(detailKey);
            }
        }
        // Clear pending entries superseded by the echo.
        for (const [ck, pending] of pendingCells) {
            const sep = ck.indexOf('\u0000');
            const key = ck.slice(0, sep);
            const code = ck.slice(sep + 1);
            const hit = (op.type === 'setValue' && key === op.key && code === op.code) ||
                (op.type === 'renameKey' && key === op.oldKey) ||
                (op.type === 'removeKeys' && op.keys.includes(key));
            if (hit) {
                if (pending.timer) {
                    clearTimeout(pending.timer);
                }
                pendingCells.delete(ck);
            }
        }
        if (pendingAddKey && op.type === 'addKey' && op.key === pendingAddKey) {
            pendingAddKey = null;
            selected.add(op.key);
            if (detailKey) {
                closeDetail();
            }
            refreshRows();
            scrollKeyIntoView(op.key);
            openDetail(op.key);
            updateSelectionUi();
            return;
        }
        const editingSameCell = op.type === 'setValue' && activeInline && !activeInline.isKey &&
            activeInline.key === op.key && activeInline.code === op.code;
        if (editingSameCell) {
            updateStats();
            return;
        }
        refreshRows();
        updateStats();
    }

    // ---------------------------------------------------------------- receive
    window.addEventListener('message', (ev) => {
        const msg = ev.data;
        if (!msg || !msg.type) {
            return;
        }
        if (msg.canUndo !== undefined) {
            canUndo = !!msg.canUndo;
            canRedo = !!msg.canRedo;
            updateUndoButtons();
        }
        switch (msg.type) {
            case 'init': {
                primary = msg.primaryCode || null;
                confirmDelete = !!(msg.config && msg.config.confirmDelete);
                locale = msg.locale === 'en' ? 'en' : 'zh';
                els.folderBadge.textContent = msg.folderName || '';
                els.folderBadge.title = msg.folderPath || '';
                if (msg.bindName) {
                    els.bindInfo.textContent = `${t('uiCur')}: ${msg.bindName}`;
                }
                translateStatic();
                document.documentElement.style.setProperty('--empty-marker', JSON.stringify(t('missingCell')));
                break;
            }
            case 'uiConfig':
                applyUiConfig(msg);
                break;
            case 'clipboard': {
                if (pendingPasteInfo && typeof msg.text === 'string') {
                    const t0 = pendingPasteInfo.t;
                    pendingPasteInfo = null;
                    if (t0 && t0.isConnected && (t0.tagName === 'INPUT' || t0.tagName === 'TEXTAREA')) {
                        const s0 = t0.selectionStart != null ? t0.selectionStart : t0.value.length;
                        const e0 = t0.selectionEnd != null ? t0.selectionEnd : s0;
                        t0.value = t0.value.slice(0, s0) + msg.text + t0.value.slice(e0);
                        const pos = s0 + msg.text.length;
                        try {
                            t0.setSelectionRange(pos, pos);
                        } catch {
                            // ignore
                        }
                        t0.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
                break;
            }
            case 'config':
                if (msg.confirmDelete !== undefined) {
                    confirmDelete = !!msg.confirmDelete;
                }
                if (msg.detailDock) {
                    detailDock = msg.detailDock;
                    applyDockLayout();
                }
                if (msg.newlineEscape !== undefined) {
                    showNewlineEscape = !!msg.newlineEscape;
                    refreshRows();
                }
                break;
            case 'layoutCfg': {
                if (msg.dock) {
                    detailDock = msg.dock;
                }
                if (typeof msg.bottomH === 'number') {
                    dockBottomH = msg.bottomH;
                }
                if (typeof msg.sideW === 'number') {
                    dockSideW = msg.sideW;
                }
                applyDockLayout();
                break;
            }
            case 'snapshot': {
                data.langs = msg.langs || [];
                data.broken = msg.broken || [];
                data.keys = msg.keys || [];
                data.values = msg.values || {};
                data.folderName = msg.folderName || data.folderName;
                data.folderPath = msg.folderPath || data.folderPath;
                if (!visibleLangs.length) {
                    visibleLangs = data.langs.map((l) => l.code);
                }
                for (const k of [...selected]) {
                    if (!data.keys.includes(k)) {
                        selected.delete(k);
                    }
                }
                if (detailKey && !data.keys.includes(detailKey)) {
                    closeDetail();
                }
                renderHeader();
                refreshRows();
                updateStats();
                if (detailKey) {
                    openDetail(detailKey);
                }
                break;
            }
            case 'cmdUndo': {
                performUndoRedo(false);
                break;
            }
            case 'cmdRedo': {
                performUndoRedo(true);
                break;
            }
            case 'cmdAddKey': {
                // Only act when the focus is in the table or a key field — never
                // while typing inside a translation textarea or a dialog input.
                const t0 = document.activeElement;
                const editingValue = t0 && (t0.tagName === 'TEXTAREA' ||
                    (t0.tagName === 'INPUT' && t0.closest && t0.closest('.modal-layer')) ||
                    (t0.classList && t0.classList.contains('inline-input') &&
                     t0.closest && t0.closest('.langcell')));
                if (editingValue) {
                    break;
                }
                startCreateKey();
                break;
            }
            case 'op': {
                applyOpLocally(msg.op);
                break;
            }
            case 'opError': {
                showNotice('error', msg.error || t('opErrorTxt'), { id: 'reload', label: t('reload') });
                requestSnapshot();
                break;
            }
            case 'notice': {
                if (msg.level === 'info') {
                    showNotice('info', msg.text, msg.action, 4000);
                } else {
                    showNotice(msg.level || 'warn', msg.text, msg.action);
                }
                break;
            }
            default:
                break;
        }
    });

    // ---- native context-menu state (commands come back from the host) ----
    let ctxRow = { key: null, code: null };
    let ctxField = null; // the input/textarea the context menu was opened on
    let pendingPasteInfo = null; // { t } while a clipboard read is in flight
    function entryText(key) {
        const lines = [];
        for (const lang of data.langs) {
            lines.push(`[${lang.code}] ${getVal(key, lang.code)}`);
        }
        return [key, ...lines].join(String.fromCharCode(10));
    }
    function contextAction(cmd) {
        if (!ctxRow || !ctxRow.key) {
            return;
        }
        const { key, code } = ctxRow;
        if (cmd === 'copyKey') {
            post({ type: 'copy', text: key });
        } else if (cmd === 'copyValue' && code) {
            post({ type: 'copy', text: getVal(key, code) });
        } else if (cmd === 'copyEntry') {
            post({ type: 'copy', text: entryText(key) });
        } else if (cmd === 'deleteContextKey') {
            removeKeys([key]);
        }
        ctxRow = { key: null, code: null };
    }

    // ---- unicode encode/decode for the detail editor buttons ----
    // Encoding escapes NON-ASCII characters (such as the section sign or CJK)
    // as uXXXX sequences; ASCII letters, digits and symbols are kept as-is.
    function unicodeEscapeText(text) {
        const bs = String.fromCharCode(92);
        let out = '';
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c > 0x7e) {
                out += bs + 'u' + c.toString(16).toUpperCase().padStart(4, '0');
            } else {
                out += text[i];
            }
        }
        return out;
    }
    function unicodeDecodeText(text) {
        const bs = String.fromCharCode(92);
        return String(text).replace(
            new RegExp(bs + bs + 'u([0-9a-fA-F]{4})', 'g'),
            (m, h) => String.fromCharCode(parseInt(h, 16))
        );
    }
    function unicodeTargetTextarea() {
        const active = document.activeElement;
        if (active && active.tagName === 'TEXTAREA' && active.dataset.code && active.closest('#detail')) {
            return active;
        }
        const code = primary || (data.langs[0] && data.langs[0].code);
        return code && els.detailRows
            ? els.detailRows.querySelector('textarea[data-code="' + CSS.escape(code) + '"]')
            : null;
    }
    function applyUnicodeToText(mode) {
        if (!detailKey) {
            return;
        }
        const ta = unicodeTargetTextarea();
        if (!ta || !ta.dataset.code) {
            return;
        }
        const code = ta.dataset.code;
        const v = mode === 'decode' ? unicodeDecodeText(ta.value) : unicodeEscapeText(ta.value);
        cancelCellPending(detailKey, code);
        ta.value = v;
        ta.classList.toggle('empty', v === '');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        updatePlaceholderWarn(detailKey);
    }

    // Central undo/redo used by both the contributed keybindings and the
    // in-webview fallback. While a text field is focused it only touches that
    // field's own edits; otherwise it drives the model undo/redo (silently
    // ignoring requests when there is nothing to undo/redo).
    function performUndoRedo(isRedo) {
        const t = document.activeElement;
        const field = (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) ? t : null;
        if (field) {
            const fu = field.fieldUndo;
            if (fu) {
                if (isRedo ? fu.redo() : fu.undo()) {
                    // handled at field level
                }
            }
            return;
        }
        if (isRedo ? !canRedo : !canUndo) {
            return;
        }
        flushPending();
        post({ type: isRedo ? 'redo' : 'undo' });
    }

    function updateStats() {
        renderLangChips();
        updateStatsText();
        updateSelectionUi();
    }

    // ------------------------------------------------- detail nav & jump
    /** Focus the value editor of the current language inside the detail pane. */
    function focusDetailValue() {
        if (!detailKey) {
            return;
        }
        const code = primary || (data.langs[0] && data.langs[0].code);
        if (!code) {
            return;
        }
        const ta = els.detailRows ? els.detailRows.querySelector('textarea[data-code="' + CSS.escape(code) + '"]') : null;
        if (ta) {
            ta.focus();
            const len = ta.value.length;
            try {
                ta.setSelectionRange(len, len);
            } catch {
                // ignore
            }
        }
    }

    /** Move the detail editor to the previous/next key of the current list. */
    function navigateDetail(dir) {
        if (!detailKey || draftNew) {
            return;
        }
        if (rowsCache.length === 0) {
            return;
        }
        let idx = rowsCache.indexOf(detailKey);
        if (idx === -1) {
            idx = dir > 0 ? -1 : rowsCache.length;
        }
        let next = idx + dir;
        if (next < 0) {
            next = rowsCache.length - 1;
        }
        if (next >= rowsCache.length) {
            next = 0;
        }
        const target = rowsCache[next];
        flushPending(); // commit pending edits of the current key first
        clearSelection();
        selected.add(target);
        detailKey = target;
        refreshRows();
        scrollKeyIntoView(target);
        openDetail(target);
        updateSelectionUi();
        focusDetailValue();
    }

    /** Quick-jump to a specific translation key (supports partial match). */
    async function jumpToKey() {
        const answer = await uiPrompt(t('jumpPrompt'), detailKey || '', t('mOk'), t('jumpPh'));
        if (answer === null) {
            return;
        }
        const q = String(answer).trim();
        if (!q) {
            return;
        }
        const lower = q.toLowerCase();
        let target = data.keys.find((k) => k.toLowerCase() === lower);
        if (!target) {
            target = data.keys.find((k) => k.toLowerCase().includes(lower));
        }
        if (!target) {
            showNotice('warn', `${t('jumpNone')}: ${q}`, null, 2600);
            return;
        }
        // Make sure filters can't hide the target row.
        if (filterText || onlyMissing) {
            filterText = '';
            els.filter.value = '';
            onlyMissing = false;
            els.onlyMissingChk.checked = false;
            refreshRows();
        }
        clearSelection();
        selected.add(target);
        refreshRows();
        scrollKeyIntoView(target);
        openDetail(target);
        updateSelectionUi();
        focusDetailValue();
    }

    // ---------------------------------------------------------------- events
    function bindEvents() {
        els.undo.addEventListener('click', () => {
            flushPending();
            post({ type: 'undo' });
        });
        els.redo.addEventListener('click', () => {
            flushPending();
            post({ type: 'redo' });
        });
        els.reload.addEventListener('click', async () => {
            const ok = await uiConfirm(t('reloadConfirm'), t('reload'), t('mCancel'));
            if (ok) {
                flushPending();
                post({ type: 'reload' });
            }
        });
        els.add.addEventListener('click', startCreateKey);
        els.del.addEventListener('click', () => {
            removeKeys([...selected]);
        });
        attachFieldUndo(els.filter);

        els.filter.addEventListener('input', () => {
            filterText = els.filter.value.trim();
            clearSelection();
            els.bodyScroll.scrollTop = 0;
            refreshRows();
        });
        els.onlyMissingChk.addEventListener('change', () => {
            onlyMissing = els.onlyMissingChk.checked;
            els.bodyScroll.scrollTop = 0;
            refreshRows();
        });

        els.headRow.addEventListener('click', (ev) => {
            if (ev.target.closest('.col-resize')) {
                return; // resize handle interactions don't sort
            }
            const cell = ev.target.closest('.cell');
            if (!cell) {
                return;
            }
            if (cell.classList.contains('keycol')) {
                // key: none → key asc → key desc → none
                if (sort.kind !== 'key') {
                    sort = { kind: 'key', code: null, dir: 1 };
                } else if (sort.dir === 1) {
                    sort = { kind: 'key', code: null, dir: -1 };
                } else {
                    sort = { kind: 'none', code: null, dir: 1 };
                }
            } else if (cell.classList.contains('langcol')) {
                const code = cell.dataset.code;
                if (sort.kind === 'lang' && sort.code === code) {
                    sort = { kind: 'lang', code, dir: sort.dir === 1 ? -1 : 1 };
                } else {
                    sort = { kind: 'lang', code, dir: 1 };
                }
            } else {
                return;
            }
            refreshRows();
            renderHeader();
        });
        els.headRow.addEventListener('change', (ev) => {
            const input = ev.target;
            if (!input || input.type !== 'checkbox') {
                return;
            }
            if (input.checked) {
                clearSelection();
                rowsCache.forEach((k) => selected.add(k));
            } else {
                clearSelection();
            }
            updateSelectionUi();
        });

        els.bodyScroll.addEventListener('scroll', () => {
            window.requestAnimationFrame(renderWindow);
        }, { passive: true });

        els.rowSpacer.addEventListener('click', (ev) => {
            const row = ev.target.closest('.grid-row');
            if (!row) {
                return;
            }
            const key = row.dataset.key;
            const idx = Number(row.dataset.idx);
            const cell = ev.target.closest('.cell');
            if (ev.target.tagName === 'INPUT' && ev.target.type === 'checkbox') {
                onRowClicked(key, idx, ev);
                return;
            }
            if (cell && cell.classList.contains('keycol') && ev.detail === 2) {
                startInlineEdit(cell, key, key, true);
                return;
            }
            if (cell && cell.classList.contains('langcell')) {
                if (ev.detail === 2) {
                    startCellEdit(key, cell.dataset.code, cell);
                    return;
                }
                if (ev.detail === 1 && ev.button === 0) {
                    onRowClicked(key, idx, ev);
                    if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
                        openDetail(key);
                    }
                    return;
                }
            }
            if (ev.detail === 2) {
                return;
            }
            onRowClicked(key, idx, ev);
            openDetail(key);
        });

        els.btnCopyKey.addEventListener('click', () => {
            if (detailKey) {
                post({ type: 'copy', text: detailKey });
                showNotice('info', t('copied') + ': ' + detailKey, null, 2000);
            }
        });
        els.btnDeleteOne.addEventListener('click', () => {
            if (detailKey) {
                removeKeys([detailKey]);
            }
        });
        els.btnCloseDetail.addEventListener('click', closeDetail);

        window.addEventListener('keydown', (ev) => {
            const inField = (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA');
            if (ev.key === '/' && !inField) {
                ev.preventDefault();
                els.filter.focus();
                return;
            }
            if (ev.key === 'Escape') {
                if (isModalOpen()) {
                    closeModal(null); // a modal always wins over the rest
                    return;
                }
                if (activeInline) {
                    endInlineEdit();
                    return;
                }
                if (!els.detail.classList.contains('hidden')) {
                    closeDetail();
                    return;
                }
                return;
            }
            const mod = ev.ctrlKey || ev.metaKey;
            if (mod && !ev.altKey) {
                const t = ev.target;
                const editingTranslation = t && (t.tagName === 'TEXTAREA' ||
                    (t.classList && t.classList.contains('inline-input') && t.closest && t.closest('.langcell')) ||
                    (t.tagName === 'INPUT' && t.closest && t.closest('.modal-layer')));
                const gk = ev.key;
                if (gk === 'Enter' && !editingTranslation) {
                    // Ctrl+Enter / Ctrl+Shift+Enter → add a new key (grid/key focus only).
                    ev.preventDefault();
                    startCreateKey();
                    return;
                }
                const inDetailPane = !!(t && t.closest && t.closest('#detail'));
                if (!ev.shiftKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && inDetailPane && detailKey) {
                    // Ctrl+↑ / Ctrl+↓ inside the detail panel → previous/next key.
                    ev.preventDefault();
                    navigateDetail(ev.key === 'ArrowUp' ? -1 : 1);
                    return;
                }
                const isUndoKey = ev.key === 'z' || ev.key === 'Z';
                const isRedoKey = ev.key === 'y' || ev.key === 'Y';
                if (isUndoKey || isRedoKey) {
                    ev.preventDefault();
                    performUndoRedo(ev.shiftKey || isRedoKey);
                    return;
                }
            }
            if ((ev.key === 'Delete' || ev.key === 'Backspace') && !inField && selected.size) {
                ev.preventDefault();
                removeKeys([...selected]);
            }
        });

        window.addEventListener('resize', () => {
            renderWindow();
        });
        window.setInterval(syncHeadWidth, 1500);

        // Re-render the virtual list when its container resizes (e.g. detail drag).
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => window.requestAnimationFrame(renderWindow));
            ro.observe(els.bodyScroll);
        }

        // ---- detail panel: dock controls + prev/next navigation ----
        const head = els.detail.querySelector('.detail-head');
        const title = head.querySelector('.head-title, [data-i18n="detailTitle"]');
        const mkBtn = (glyph, text, titleText) => {
            const b = document.createElement('button');
            b.className = 'tb small';
            b.title = titleText;
            b.textContent = glyph + (text ? ' ' + text : '');
            return b;
        };

        // prev / next group (inserted right after the title)
        const nav = document.createElement('div');
        nav.className = 'detail-nav';
        const btnPrev = mkBtn('↑', '', t('navPrevT'));
        const btnNext = mkBtn('↓', '', t('navNextT'));
        const btnJump = mkBtn('⤷', '', t('navJumpT'));
        btnPrev.addEventListener('click', () => navigateDetail(-1));
        btnNext.addEventListener('click', () => navigateDetail(1));
        btnJump.addEventListener('click', jumpToKey);
        nav.append(btnPrev, btnNext, btnJump);
        if (title) {
            title.after(nav);
        } else {
            head.insertBefore(nav, head.firstChild);
        }

        // dock buttons (inserted before the close button)
        const dockGroup = document.createElement('div');
        dockGroup.className = 'dock-btn-group';
        const dockDefs = [
            ['bottom', '⤓', t('dockBottomT')],
            ['left', '⤪', t('dockLeftT')],
            ['right', '⤩', t('dockRightT')],
            ['full', '⤢', t('dockFullT')]
        ];
        for (const [mode, glyph, hint] of dockDefs) {
            const b = mkBtn(glyph, '', hint);
            b.dataset.dock = mode;
            b.addEventListener('click', () => {
                setDock(mode);
                persistDockState();
            });
            dockGroup.appendChild(b);
        }
        els.dockBtnGroup = dockGroup;
        // Encode / decode unicode escapes in the focused/primary language editor.
        const uGroup = document.createElement('div');
        uGroup.className = 'dock-btn-group';
        const btnUEncode = mkBtn('A→U', '', '转码：非 ASCII 转为 uXXXX（英文与 ASCII 符号不变）');
        const btnUDecode = mkBtn('U→A', '', '解码：uXXXX 还原为字符');
        btnUEncode.addEventListener('click', () => applyUnicodeToText('encode'));
        btnUDecode.addEventListener('click', () => applyUnicodeToText('decode'));
        uGroup.append(btnUEncode, btnUDecode);
        const closeBtn = head.querySelector('#btnCloseDetail');
        if (closeBtn) {
            head.insertBefore(dockGroup, closeBtn);
            head.insertBefore(uGroup, dockGroup);
        } else {
            head.appendChild(dockGroup);
            head.appendChild(uGroup);
        }
        syncUndockButtons();

        // ---- resizable divider between the grid and the detail panel ----
        els.dockDivider = document.createElement('div');
        els.dockDivider.id = 'dockDivider';
        els.gridWrap.after(els.dockDivider);

        const isSideDock = () => detailDock === 'left' || detailDock === 'right';
        const sideSign = () => (detailDock === 'left' ? 1 : -1);

        let dDrag = null;
        const dockMove = (ev) => {
            if (!dDrag) {
                return;
            }
            ev.preventDefault();
            if (detailDock === 'bottom') {
                const px = dDrag.base + (dDrag.startY - ev.clientY);
                dockBottomH = Math.max(120, Math.min(px, dockMaxFor(false)));
                els.detail.style.height = dockBottomH + 'px';
                els.detail.style.maxHeight = 'none';
            } else if (isSideDock()) {
                const px = dDrag.base + (ev.clientX - dDrag.startX) * sideSign();
                dockSideW = Math.max(220, Math.min(px, dockMaxFor(true)));
                els.detail.style.width = dockSideW + 'px';
            }
            window.requestAnimationFrame(renderWindow);
        };
        const dockEnd = () => {
            if (!dDrag) {
                return;
            }
            dDrag = null;
            els.dockDivider.classList.remove('dragging');
            document.body.classList.remove('dock-resizing');
            persistDockState();
        };
        els.dockDivider.addEventListener('pointerdown', (ev) => {
            if (detailDock === 'full') {
                return;
            }
            ev.preventDefault();
            try {
                els.dockDivider.setPointerCapture(ev.pointerId);
            } catch {
                // ignore
            }
            dDrag = {
                startX: ev.clientX,
                startY: ev.clientY,
                base: detailDock === 'bottom' ? els.detail.offsetHeight : els.detail.offsetWidth
            };
            els.dockDivider.classList.add('dragging');
            document.body.classList.add('dock-resizing');
        });
        els.dockDivider.addEventListener('pointermove', dockMove);
        els.dockDivider.addEventListener('pointerup', dockEnd);
        els.dockDivider.addEventListener('pointercancel', dockEnd);
        applyDockLayout();

        // ---- custom right-click context menu (rows + text fields) ----
        // VS Code's native webview menus are unreliable in some setups, so we
        // render our own stable menu. Rows get copy/delete actions; text fields
        // get cut/copy/paste/select-all (clipboard reads go through the host).
        const ctxMenuEl = document.createElement('div');
        ctxMenuEl.className = 'ctx-menu hidden';
        document.body.appendChild(ctxMenuEl);

        const hideCtxMenu = () => {
            ctxMenuEl.classList.add('hidden');
            ctxMenuEl.textContent = '';
        };
        const showCtxMenu = (x, y, items) => {
            ctxMenuEl.textContent = '';
            for (const it of items) {
                if (it === '-') {
                    const sep = document.createElement('div');
                    sep.className = 'ctx-sep';
                    ctxMenuEl.appendChild(sep);
                    continue;
                }
                const el = document.createElement('div');
                el.className = 'ctx-item' + (it.danger ? ' danger' : '');
                const l = document.createElement('span');
                l.className = 'l';
                l.textContent = it.label;
                el.appendChild(l);
                if (it.hint) {
                    const h = document.createElement('span');
                    h.className = 'hint';
                    h.textContent = it.hint;
                    el.appendChild(h);
                }
                el.addEventListener('mousedown', (ev) => ev.preventDefault());
                el.addEventListener('click', () => {
                    hideCtxMenu();
                    it.run();
                });
                ctxMenuEl.appendChild(el);
            }
            const w = ctxMenuEl.offsetWidth || 230;
            const h = ctxMenuEl.offsetHeight || 140;
            ctxMenuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
            ctxMenuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
            ctxMenuEl.classList.remove('hidden');
        };
        document.addEventListener('pointerdown', (ev) => {
            if (!ctxMenuEl.classList.contains('hidden') && !ctxMenuEl.contains(ev.target)) {
                hideCtxMenu();
            }
        });
        document.addEventListener('scroll', hideCtxMenu, true);
        window.addEventListener('resize', hideCtxMenu);

        // Text-field editing actions.
        const fieldMenuItems = () => {
            const exec = (cmd) => {
                const t = ctxField;
                if (!t || !t.isConnected || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) {
                    return;
                }
                t.focus();
                if (cmd === 'cut') {
                    document.execCommand('cut');
                } else if (cmd === 'copy') {
                    document.execCommand('copy');
                } else if (cmd === 'select') {
                    t.select();
                }
            };
            const paste = () => {
                const t = ctxField;
                if (!t || !t.isConnected || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) {
                    return;
                }
                t.focus();
                pendingPasteInfo = { t };
                post({ type: 'readClipboard' });
            };
            const items = [];
            items.push({ label: t('mCut'), run: () => exec('cut') });
            items.push({ label: t('mCopy'), run: () => exec('copy') });
            items.push({ label: t('mPaste'), run: paste });
            items.push({ label: t('mSelAll'), run: () => exec('select') });
            return items;
        };
        // Paste result arrives back from the host.

        const rowMenuItems = (row, cell) => {
            const key = row.dataset.key || '';
            const code = cell && cell.dataset.code ? cell.dataset.code : null;
            ctxRow = { key, code };
            const items = [];
            items.push({
                label: t('ctxCopyKey'),
                run: () => contextAction('copyKey')
            });
            if (code) {
                items.push({
                    label: t('ctxCopyVal', { c: code }),
                    run: () => contextAction('copyValue')
                });
            }
            items.push({ label: t('ctxCopyRow'), run: () => contextAction('copyEntry') });
            items.push('-');
            items.push({
                label: selected.size > 1
                    ? t('ctxDeleteSel', { n: selected.size })
                    : t('ctxDelete'),
                danger: true,
                run: () => (selected.size > 1 ? removeKeys([...selected]) : removeKeys([key]))
            });
            return items;
        };

        document.addEventListener('contextmenu', (ev) => {
            const t = ev.target;
            const editing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
            const row = t && t.closest ? t.closest('.grid-row') : null;
            if (!editing && !row) {
                return; // keep the default menu elsewhere
            }
            ev.preventDefault();
            if (editing) {
                ctxRow = { key: null, code: null };
                ctxField = t;
                showCtxMenu(ev.clientX, ev.clientY, fieldMenuItems());
            } else {
                if (!row.dataset.key) {
                    return;
                }
                ctxField = null;
                showCtxMenu(ev.clientX, ev.clientY, rowMenuItems(row, t.closest('.cell')));
            }
        }, true);

        window.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && !ctxMenuEl.classList.contains('hidden')) {
                hideCtxMenu();
            }
        });
    }
    // ---------------------------------------------------------------- boot
    document.addEventListener('DOMContentLoaded', () => {
        const saved = vscode.getState() || {};
        try {
            els.app.classList.remove('hidden');
            document.body.setAttribute('data-kind', 'dark');

            // Wrap grid + detail in a workspace so the detail can dock bottom /
            // left / right / fullscreen.
            const ws = document.createElement('div');
            ws.id = 'workspace';
            els.app.insertBefore(ws, els.detail);
            ws.appendChild(els.gridWrap);
            ws.appendChild(els.detail);
            els.workspace = ws;

            // Header lives inside the scroll container so columns stay aligned
            // when the grid scrolls horizontally (wider-than-viewport columns).
            els.bodyScroll.insertBefore(els.headRow, els.rowSpacer);

            bindEvents();
            renderHeader();
            refreshRows();

            if (saved.filter) {
                els.filter.value = saved.filter;
            }
        } catch (err) {
            console.error('[minecraft-language-editor] init error:', err);
            const failEl = document.getElementById('initFail');
            if (failEl) {
                failEl.classList.remove('hidden');
                failEl.textContent = t('errInitTxt') + ': ' +
                    (err instanceof Error ? err.message : String(err)) +
                    '\n' + ((err && err.stack) || '');
            }
        } finally {
            // Always tell the extension host we are ready so it pushes the data,
            // even if part of the UI setup above failed.
            post({ type: 'ready' });
        }
    });

    window.addEventListener('beforeunload', () => {
        const s = vscode.getState() || {};
        s.filter = els.filter.value;
        vscode.setState(s);
    });
})();
