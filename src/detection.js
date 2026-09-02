'use strict';

// Pure detection helpers for Minecraft language files (en_us.json / zh_cn.json / ...).
// No vscode dependency so these can be unit-tested with plain mocha.

/**
 * Matches Minecraft style language file names: `en_us.json`, `zh_cn.json`, `ja_jp.json`,
 * also 3-letter codes such as `fil_ph.json` and plain codes like `en.json`.
 * Case-insensitive on purpose (some packs ship `EN_US.json`).
 */
const LANG_FILE_RE = /^([a-z]{2,3}(?:_[a-z]{2,3})?)\.json$/i;

/**
 * @param {string} fileName
 * @returns {string|null} normalized lower-case language code (e.g. `en_us`) or null.
 */
function langCodeFromFileName(fileName) {
    const m = LANG_FILE_RE.exec(fileName);
    return m ? m[1].toLowerCase() : null;
}

/**
 * @param {string} fileName
 * @returns {boolean}
 */
function isLangFileName(fileName) {
    return LANG_FILE_RE.test(fileName);
}

/**
 * A Minecraft language file is a flat object mapping string keys to string values.
 * @param {unknown} value
 * @returns {boolean}
 */
function isFlatStringMap(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        return false;
    }
    for (const k in value) {
        if (typeof value[k] !== 'string') {
            return false;
        }
        if (k === '__proto__') {
            return false;
        }
    }
    return true;
}

/**
 * Analyze the text content of one candidate file.
 * @param {string} fileName
 * @param {string|Buffer} text
 * @returns {{code: string|null, parseOk: boolean, flat: boolean, value: object|null, order: string[], error?: string, bom: boolean, crlf: boolean, trailingNewline: boolean, indent: string|null}}
 */
function analyzeFile(fileName, text) {
    const code = langCodeFromFileName(fileName);
    const raw = typeof text === 'string' ? text : text.toString('utf8');
    const bom = raw.charCodeAt(0) === 0xfeff;
    const body = bom ? raw.slice(1) : raw;
    const crlf = body.includes('\r\n');
    const trailingNewline = /\n$/.test(body);
    const fmt = detectIndent(body);

    let parseOk = true;
    let flat = false;
    let value = null;
    let order = [];
    let error;

    // An empty (or blank) file is a perfectly valid, empty language file —
    // treat it as an editable file with zero translations instead of a parse error.
    if (body.trim() === '') {
        flat = true;
        value = {};
        order = [];
    } else {
        try {
            const parsed = JSON.parse(body);
            flat = isFlatStringMap(parsed);
            if (flat) {
                value = parsed;
                order = Object.keys(parsed);
            }
        } catch (e) {
            parseOk = false;
            error = e instanceof Error ? e.message : String(e);
        }
    }
    return {
        code,
        parseOk,
        flat,
        value,
        order,
        error,
        bom,
        crlf,
        trailingNewline,
        indent: fmt.indent,
        crlfBody: crlf
    };
}

/**
 * Heuristic to detect the indentation unit of a pretty-printed JSON file.
 * Looks at leading whitespace of the first property line.
 * @param {string} body text without BOM
 * @returns {{indent: string|null}}
 */
function detectIndent(body) {
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
        const m = /^([ \t]+)".*":/.exec(line);
        if (m) {
            const ws = m[1];
            if (ws[0] === '\t') {
                return { indent: ws };
            }
            return { indent: ' '.repeat(ws.length) };
        }
    }
    return { indent: null };
}

/**
 * Decide whether a folder really contains a Minecraft language set, to avoid hijacking
 * arbitrary two-letter named JSON files.
 * @param {Array<{name: string, analysis: ReturnType<typeof analyzeFile>}>} files
 * @returns {{confirmed: boolean, editable: string[], broken: string[]}}
 */
function confirmFolder(files) {
    const editable = files.filter((f) => f.analysis.flat && f.analysis.parseOk);
    const broken = files.filter((f) => !f.analysis.flat || !f.analysis.parseOk);
    const editableNames = editable.map((f) => f.name);
    if (editable.length === 0) {
        return { confirmed: false, editable: editableNames, broken: broken.map((f) => f.name) };
    }
    if (files.length >= 2 && editable.length >= 1) {
        // Several language files side by side is the typical arrangement.
        return { confirmed: true, editable: editableNames, broken: broken.map((f) => f.name) };
    }
    // A single file: only trust it when keys look like Minecraft translation keys.
    const anyDotKey = editable.some((f) => (f.analysis.order || []).some((k) => k.includes('.')));
    return { confirmed: anyDotKey, editable: editableNames, broken: broken.map((f) => f.name) };
}

/**
 * Display label for a language code (best effort, mostly for tests/tooltips).
 */
const LANG_LABELS = {
    en_us: 'English (US)', en_gb: 'English (UK)', zh_cn: '简体中文', zh_tw: '繁體中文',
    ja_jp: '日本語', ko_kr: '한국어', de_de: 'Deutsch', fr_fr: 'Français', fr_ca: 'Français (CA)',
    es_es: 'Español', es_mx: 'Español (MX)', es_ar: 'Español (AR)', pt_br: 'Português (BR)',
    pt_pt: 'Português (PT)', it_it: 'Italiano', nl_nl: 'Nederlands', ru_ru: 'Русский',
    uk_ua: 'Українська', pl_pl: 'Polski', sv_se: 'Svenska', nb_no: 'Norsk bokmål',
    fi_fi: 'Suomi', da_dk: 'Dansk', cs_cz: 'Čeština', sk_sk: 'Slovenčina', hu_hu: 'Magyar',
    ro_ro: 'Română', bg_bg: 'Български', el_gr: 'Ελληνικά', tr_tr: 'Türkçe', hr_hr: 'Hrvatski',
    sr_sp: 'Српски', lv_lv: 'Latviešu', lt_lt: 'Lietuvių', et_ee: 'Eesti', ca_es: 'Català',
    gl_es: 'Galego', eu_es: 'Euskara', af_za: 'Afrikaans', id_id: 'Bahasa Indonesia',
    ms_my: 'Bahasa Melayu', vi_vn: 'Tiếng Việt', th_th: 'ไทย', hi_in: 'हिन्दी',
    ar_sa: 'العربية', he_il: 'עברית', fa_ir: 'فارسی', ur_pk: 'اردو', bn_bd: 'বাংলা',
    ta_in: 'தமிழ்', te_in: 'తెలుగు', ml_in: 'മലയാളം', en_pt: 'Pirate Speak', tok: 'Toki Pona'
};

/**
 * @param {string} code
 * @returns {string}
 */
function labelForCode(code) {
    return LANG_LABELS[code] || code;
}

module.exports = {
    LANG_FILE_RE,
    langCodeFromFileName,
    isLangFileName,
    isFlatStringMap,
    analyzeFile,
    confirmFolder,
    labelForCode,
    LANG_LABELS
};
