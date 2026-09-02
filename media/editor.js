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
    let sort = { code: null, dir: 1 }; // code === null => canonical order
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
        bodyScroll: $('bodyScroll'), rowSpacer: $('rowSpacer'),
        emptyState: $('emptyState'),
        detail: $('detail'), detailRows: $('detailRows'),
        placeholderWarn: $('placeholderWarn'),
        btnCopyKey: $('btnCopyKey'), btnDeleteOne: $('btnDeleteOne'), btnCloseDetail: $('btnCloseDetail'),
        statText: $('statText')
    };
    let checkAllInput = null; // re-created with each header render

    const I18N = {
        reload: { zh: '重新加载', en: 'Reload' },
        detailTitle: { zh: '详情 —— 修改会自动保存到各语言文件', en: 'Details — edits auto-save to each file' },
        noRows: { zh: '没有匹配的 key', en: 'No matching keys' },
        noKeysHint: {
            zh: '该目录没有可编辑的翻译 key。点击右上角 “＋ 添加 key” 创建第一个翻译。',
            en: 'No editable translation keys yet. Use "+ Add key" to create one.'
        },
        brokenOnly: { zh: '没有可用的语言文件（全部解析失败或被跳过）。请先修复原始 JSON 文件。', en: 'No usable language files (all failed to parse). Fix the raw JSON first.' },
        copied: { zh: '已复制 key', en: 'Key copied' },
        prefix: { zh: '前缀', en: 'prefix' },
        complete: { zh: '完整', en: 'complete' },
        missing: { zh: '缺', en: 'missing' },
        placeholder: { zh: '占位符', en: 'placeholder' },
        existing: { zh: '已定位到该 key', en: 'Key exists — jumping to it' }
    };
    function t(key) {
        const m = I18N[key];
        return m ? m[locale] || m.zh : key;
    }
    function translateStatic() {
        document.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = t(el.dataset.i18n);
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
        const text = String(value).replace(/\r?\n/g, '\\n');
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
        if (sort.code) {
            const { code, dir } = sort;
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
        } else if (sort.dir < 0) {
            arr = arr.slice().reverse();
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

        for (const code of visibleLangs) {
            const cell = document.createElement('div');
            cell.className = 'cell langcell';
            cell.dataset.key = key;
            cell.dataset.code = code;
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

        const sortMark = sort.code === null ? (sort.dir < 0 ? ' ▾' : '') : (sort.dir === 1 ? ' ▴' : ' ▾');
        head.appendChild(createHeaderCell('cell keycol head-key', 'key', 'key' + sortMark));

        for (const code of visibleLangs) {
            const name = data.langs.find((l) => l.code === code);
            const label = (name ? name.name : code) + (sort.code === code ? (sort.dir === 1 ? ' ▴' : ' ▾') : '');
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
                    showNotice('error', `key 已存在: ${newKey}`, null);
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
        input.title = '重命名会同步到所有语言文件（Enter 提交 / Esc 还原）';
        rowEl.appendChild(input);
        attachFieldUndo(input);
        attachCompletion(input, (q) => keySuggestions(q));

        const hint = document.createElement('span');
        hint.className = 'dl-key-hint';
        hint.textContent = '改 key 后 Enter 提交（同步所有语言）';
        rowEl.appendChild(hint);
        wrap.appendChild(rowEl);
        rows.appendChild(wrap);

        let committed = false;
        const commit = () => {
            if (committed) {
                return;
            }
            const raw = input.value.trim();
            if (!raw) {
                showNotice('error', 'key 不能为空', null);
                input.focus();
                return;
            }
            if (raw === key) {
                return; // no change; allow further edits
            }
            if (data.keys.includes(raw)) {
                showNotice('error', `key 已存在: ${raw}`, null);
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
                tag.textContent = '(当前文件)';
                tag.style.opacity = '0.7';
                l.appendChild(tag);
            }
            wrap.appendChild(l);
            const ta = document.createElement('textarea');
            ta.rows = 2;
            ta.spellcheck = false;
            ta.autocomplete = 'off';
            const val = getVal(key, lang.code);
            ta.value = val;
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
        if (detailHeight) {
            applyDetailHeight(detailHeight);
        }
        els.detail.classList.remove('hidden');
        updatePlaceholderWarn(key);
    }

    // ------------------------------------------------- detail panel height
    let detailHeight = null; // px once the user drags the resizer

    function detailMaxH() {
        return Math.max(160, window.innerHeight - 170);
    }
    function applyDetailHeight(px) {
        const h = Math.max(90, Math.min(Number(px) || 240, detailMaxH()));
        els.detail.style.height = h + 'px';
        els.detail.classList.add('custom');
        detailHeight = h;
        window.requestAnimationFrame(renderWindow);
    }
    function persistDetailHeight() {
        const s = vscode.getState() || {};
        if (detailHeight) {
            s.detailH = detailHeight;
        } else {
            delete s.detailH;
        }
        vscode.setState(s);
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
            warn.textContent = `⚠ 占位符不一致: ${mismatch.join(', ')}`;
            warn.title = '不同语言之间 %s / %d / %1$s 等占位符数量或顺序不一致，游戏内可能显示错误';
            warn.classList.remove('hidden');
        } else {
            warn.classList.add('hidden');
        }
    }

    function closeDetail() {
        flushPending();
        detailKey = null;
        els.detail.classList.add('hidden');
        els.placeholderWarn.classList.add('hidden');
    }

    function removeKeys(keyList) {
        if (!keyList.length) {
            return;
        }
        if (confirmDelete && !window.confirm(`确定要从所有 ${data.langs.length} 个语言文件中删除 ${keyList.length} 个 key 吗？\n\n此操作可撤销 (Ctrl+Z)。`)) {
            return;
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
            showNotice('warn', '至少要保留一个语言列', null);
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
        const p = primary || (data.langs[0] && data.langs[0].code);
        let missing = 0;
        if (p) {
            for (const k of data.keys) {
                if (getVal(k, p) === '') {
                    missing++;
                }
            }
        }
        const broken = data.broken.length;
        let s = `📝 ${total} 个 key · ${l} 种语言`;
        if (p) {
            const shown = data.langs.find((x) => x.code === p);
            s += ` · 当前文件 ${shown ? shown.name : p}：${total - missing} 已翻译${missing ? `，${missing} 未翻译` : ''}`;
        }
        if (broken) {
            s += ` · ⚠ ${broken} 个文件解析失败`;
        }
        if (visibleLangs.length < data.langs.length) {
            s += ` · 显示 ${visibleLangs.length}/${data.langs.length} 列`;
        }
        els.statText.textContent = s;
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

    // ------------------------------------------------------------ add dialog
    function openAddBar() {
        flushPending();
        els.addBar.classList.remove('hidden');
        els.addLang.textContent = '';
        const sel = document.createElement('select');
        for (const lang of data.langs) {
            const opt = document.createElement('option');
            opt.value = lang.code;
            opt.textContent = lang.name;
            if (lang.code === primary) {
                opt.selected = true;
            }
            sel.appendChild(opt);
        }
        els.addLang.appendChild(sel);
        els.addKey.value = '';
        els.addValue.value = '';
        els.addKey.focus();
    }
    function closeAddBar() {
        els.addBar.classList.add('hidden');
    }
    function submitAdd() {
        const key = els.addKey.value.trim();
        if (!key) {
            showNotice('warn', 'key 不能为空', null);
            els.addKey.focus();
            return;
        }
        if (data.keys.includes(key)) {
            // Jump to the existing row instead of failing.
            closeAddBar();
            clearSelection();
            selected.add(key);
            refreshRows();
            scrollKeyIntoView(key);
            openDetail(key);
            updateSelectionUi();
            showNotice('info', `${t('existing')}: ${key}`, null, 2600);
            return;
        }
        const code = els.addLang.querySelector('select').value;
        const value = els.addValue.value;
        closeAddBar();
        clearSelection();
        sendOp({ type: 'addKey', key, code, value });
        pendingAddKey = key;
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
                    els.bindInfo.textContent = `当前文件: ${msg.bindName}`;
                }
                translateStatic();
                break;
            }
            case 'uiConfig':
                applyUiConfig(msg);
                break;
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
                    detailKey = null;
                    els.detail.classList.add('hidden');
                }
                renderHeader();
                refreshRows();
                updateStats();
                if (detailKey) {
                    openDetail(detailKey);
                }
                break;
            }
            case 'op': {
                applyOpLocally(msg.op);
                break;
            }
            case 'opError': {
                showNotice('error', msg.error || '操作失败', { id: 'reload', label: '重新加载' });
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

    function updateStats() {
        renderLangChips();
        updateStatsText();
        updateSelectionUi();
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
        els.reload.addEventListener('click', () => {
            if (window.confirm('从磁盘重新加载？未同步到磁盘的修改会丢失，撤销历史将被清空。')) {
                flushPending();
                post({ type: 'reload' });
            }
        });
        els.add.addEventListener('click', openAddBar);
        els.addCancel.addEventListener('click', closeAddBar);
        els.addOk.addEventListener('click', submitAdd);
        els.del.addEventListener('click', () => {
            removeKeys([...selected]);
        });

        // Static editable fields also get per-field undo/redo.
        attachFieldUndo(els.filter);
        attachFieldUndo(els.addKey);
        attachFieldUndo(els.addValue);

        // Key input completion + keyboard flow in the add bar.
        attachCompletion(els.addKey, (q) => keySuggestions(q));
        els.addKey.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                els.addValue.focus();
            }
        });
        els.addValue.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                ev.preventDefault();
                submitAdd();
            }
        });

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
                if (sort.code === null) {
                    sort = { code: null, dir: sort.dir === 1 ? -1 : 1 };
                } else {
                    sort = { code: null, dir: 1 };
                }
            } else if (cell.classList.contains('langcol')) {
                const code = cell.dataset.code;
                if (sort.code === code) {
                    sort = { code, dir: sort.dir === 1 ? -1 : 1 };
                } else {
                    sort = { code, dir: 1 };
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
                if (activeInline) {
                    endInlineEdit();
                    return;
                }
                if (!els.addBar.classList.contains('hidden')) {
                    closeAddBar();
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
                const isUndoKey = ev.key === 'z' || ev.key === 'Z';
                const isRedoKey = ev.key === 'y' || ev.key === 'Y';
                if (isUndoKey || isRedoKey) {
                    ev.preventDefault();
                    const isRedo = ev.shiftKey || isRedoKey;
                    const t = ev.target;
                    const field = (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) ? t : null;
                    if (field) {
                        // While editing: only the field's own undo/redo runs — and
                        // never a table-level op, never any toast, even when the
                        // field has nothing left to undo/redo.
                        const fu = field.fieldUndo;
                        if (fu) {
                            if (isRedo ? fu.redo() : fu.undo()) {
                                // handled at field level
                            }
                        }
                        return;
                    }
                    // Outside a field: table-level undo/redo, silently ignored when
                    // there is nothing to undo/redo (no "nothing to undo" toast).
                    if (isRedo ? !canRedo : !canUndo) {
                        return;
                    }
                    flushPending();
                    post({ type: isRedo ? 'redo' : 'undo' });
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

        // ---- draggable resizer: adjust the detail panel height ----
        const resizer = document.createElement('div');
        resizer.id = 'detailResizer';
        resizer.title = '拖动调整详情面板高度';
        resizer.setAttribute('aria-orientation', 'horizontal');
        els.detail.insertBefore(resizer, els.detail.firstChild);

        let drag = null;
        const onMove = (ev) => {
            if (!drag) {
                return;
            }
            ev.preventDefault();
            // Moving the handle up grows the panel below the grid.
            applyDetailHeight(drag.h + (drag.y - ev.clientY));
        };
        const endDrag = () => {
            if (!drag) {
                return;
            }
            drag = null;
            resizer.classList.remove('dragging');
            document.body.classList.remove('dragging');
            persistDetailHeight();
        };
        resizer.addEventListener('pointerdown', (ev) => {
            if (els.detail.classList.contains('hidden')) {
                return;
            }
            ev.preventDefault();
            try {
                resizer.setPointerCapture(ev.pointerId);
            } catch {
                // ignore
            }
            drag = { y: ev.clientY, h: els.detail.offsetHeight || 240 };
            resizer.classList.add('dragging');
            document.body.classList.add('dragging');
        });
        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', endDrag);
        resizer.addEventListener('pointercancel', endDrag);

        post({ type: 'ready' });
    }

    // ---------------------------------------------------------------- boot
    document.addEventListener('DOMContentLoaded', () => {
        const saved = vscode.getState();
        els.app.classList.remove('hidden');
        document.body.setAttribute('data-kind', 'dark');
        // Header lives inside the scroll container so columns stay aligned when
        // the grid scrolls horizontally (resizable / wider-than-viewport columns).
        els.bodyScroll.insertBefore(els.headRow, els.rowSpacer);
        bindEvents();
        renderHeader();
        refreshRows();
        if (saved && saved.filter) {
            els.filter.value = saved.filter;
        }
        if (saved && saved.detailH) {
            detailHeight = saved.detailH;
        }
    });

    window.addEventListener('beforeunload', () => {
        const s = vscode.getState() || {};
        s.filter = els.filter.value;
        if (detailHeight) {
            s.detailH = detailHeight;
        }
        vscode.setState(s);
    });
})();
