'use strict';

const assert = require('assert');
const detection = require('../src/detection');
const langSet = require('../src/langSet');

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

describe('detection', () => {
    it('recognizes Minecraft language file names', () => {
        assert.strictEqual(detection.langCodeFromFileName('en_us.json'), 'en_us');
        assert.strictEqual(detection.langCodeFromFileName('zh_cn.json'), 'zh_cn');
        assert.strictEqual(detection.langCodeFromFileName('EN_US.json'), 'en_us');
        assert.strictEqual(detection.langCodeFromFileName('fil_ph.json'), 'fil_ph');
        assert.strictEqual(detection.langCodeFromFileName('en.json'), 'en');
        assert.strictEqual(detection.langCodeFromFileName('package.json'), null);
        assert.strictEqual(detection.langCodeFromFileName('package-lock.json'), null);
        assert.strictEqual(detection.langCodeFromFileName('settings.json'), null);
        assert.strictEqual(detection.langCodeFromFileName('data.json'), null);
        assert.strictEqual(detection.isLangFileName('en_us.json'), true);
        assert.strictEqual(detection.isLangFileName('foo.bar.json'), false);
    });

    it('analyzes flat maps and rejects other structures', () => {
        const ok = detection.analyzeFile('en_us.json', '{\n  "a.b": "x",\n  "c": ""\n}\n');
        assert.strictEqual(ok.flat, true);
        assert.deepStrictEqual(ok.order, ['a.b', 'c']);
        assert.strictEqual(ok.indent, '  ');
        assert.strictEqual(ok.trailingNewline, true);
        assert.strictEqual(ok.crlf, false);

        const bom = detection.analyzeFile('zh_cn.json', '\uFEFF{ "a": "1" }');
        assert.strictEqual(bom.bom, true);
        assert.strictEqual(bom.flat, true);

        const bad = detection.analyzeFile('zh_cn.json', '{ not json');
        assert.strictEqual(bad.parseOk, false);
        assert.ok(bad.error);

        const nested = detection.analyzeFile('zh_cn.json', '{ "a": { "b": "c" } }');
        assert.strictEqual(nested.parseOk, true);
        assert.strictEqual(nested.flat, false);
    });

    it('treats empty/blank files as valid empty language files (not parse errors)', () => {
        for (const text of ['', '   ', '\n', '\uFEFF', '\uFEFF\r\n']) {
            const a = detection.analyzeFile('zh_cn.json', text);
            assert.strictEqual(a.parseOk, true, JSON.stringify(text));
            assert.strictEqual(a.flat, true);
            assert.deepStrictEqual(a.value, {});
            assert.deepStrictEqual(a.order, []);
        }
        const st = langSet.buildState([{ code: 'en_us', name: 'en_us.json', text: '' }]);
        assert.deepStrictEqual(st.langs, ['en_us']);
        assert.deepStrictEqual(st.keys, []);
        assert.deepStrictEqual(st.broken, []);
        assert.ok(!st.files.en_us.indent); // no indent detectable in an empty file
    });

    it('serializes an empty language file as {}', () => {
        const st = langSet.buildState([{ code: 'zh_cn', name: 'zh_cn.json', text: '' }]);
        assert.strictEqual(langSet.serializeFile(st, 'zh_cn', '  '), '{}');
    });

    it('confirms a folder only when it looks like a language set', () => {
        const mk = (name, text) => ({ name, analysis: detection.analyzeFile(name, text) });
        // two flat files -> confirmed
        let r = detection.confirmFolder([
            mk('en_us.json', '{ "block.x": "X" }'),
            mk('zh_cn.json', '{ "block.x": "X" }')
        ]);
        assert.strictEqual(r.confirmed, true);

        // single file without dotted keys -> not confirmed
        r = detection.confirmFolder([mk('en_us.json', '{ "hello": "Hi" }')]);
        assert.strictEqual(r.confirmed, false);

        // single file with dotted keys -> confirmed
        r = detection.confirmFolder([mk('en_us.json', '{ "item.minecraft.stick": "Stick" }')]);
        assert.strictEqual(r.confirmed, true);

        // everything broken -> not confirmed, broken listed
        r = detection.confirmFolder([mk('en_us.json', '{ oops')]);
        assert.strictEqual(r.confirmed, false);
        assert.deepStrictEqual(r.broken, ['en_us.json']);
    });
});

// ---------------------------------------------------------------------------
// langSet
// ---------------------------------------------------------------------------

describe('langSet', () => {
    function entries(enText, zhText) {
        return [
            { code: 'zh_cn', name: 'zh_cn.json', text: zhText },
            { code: 'en_us', name: 'en_us.json', text: enText }
        ];
    }

    it('builds a union across languages with missing = empty', () => {
        const st = langSet.buildState(entries(
            '{ "a": "A", "b": "B" }',
            '{ "a": "甲", "c": "丙" }'
        ));
        assert.deepStrictEqual(st.langs, ['en_us', 'zh_cn']);
        assert.deepStrictEqual(st.keys, ['a', 'b', 'c']); // en_us order then zh_cn extras
        assert.strictEqual(langSet.getValue('b', 'zh_cn', st), '');
        assert.strictEqual(langSet.getValue('a', 'en_us', st), 'A');
        assert.deepStrictEqual(st.broken, []);
    });

    it('isolates broken files and never includes them as languages', () => {
        const st = langSet.buildState([
            { code: 'en_us', name: 'en_us.json', text: '{ "a": "A" }' },
            { code: 'zh_cn', name: 'zh_cn.json', text: '{ oops' }
        ]);
        assert.deepStrictEqual(st.langs, ['en_us']);
        assert.strictEqual(st.broken.length, 1);
        assert.strictEqual(langSet.serializeFile(st, 'zh_cn', '  '), null);
        // broken file only listed, en file still serializes
        assert.ok(langSet.serializeFile(st, 'en_us', '  ').includes('"a"'));
    });

    it('setValue updates only one language; addKey registers in every language', () => {
        const st = langSet.buildState(entries('{ "a": "A" }', '{ "a": "甲" }'));
        let r = langSet.applyOp(st, { type: 'setValue', key: 'a', code: 'zh_cn', value: '乙' });
        assert.deepStrictEqual(r, { ok: true, applied: true });
        assert.strictEqual(langSet.getValue('a', 'zh_cn', st), '乙');
        assert.strictEqual(langSet.getValue('a', 'en_us', st), 'A');

        r = langSet.applyOp(st, { type: 'addKey', key: 'new.key', code: 'zh_cn', value: '新' });
        assert.deepStrictEqual(r, { ok: true, applied: true });
        assert.strictEqual(langSet.getValue('new.key', 'zh_cn', st), '新');
        assert.strictEqual(langSet.getValue('new.key', 'en_us', st), ''); // placeholder
        assert.ok(st.keys.includes('new.key'));

        // duplicate add rejected
        r = langSet.applyOp(st, { type: 'addKey', key: 'new.key', code: 'en_us', value: '' });
        assert.strictEqual(r.ok, false);
    });

    it('removeKeys deletes from every language at once', () => {
        const st = langSet.buildState(entries('{ "a": "A", "b": "B" }', '{ "a": "甲" }'));
        const r = langSet.applyOp(st, { type: 'removeKeys', keys: ['a'] });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(st.keys, ['b']);
        for (const code of st.langs) {
            assert.strictEqual(langSet.getValue('a', code, st), '');
        }
        const enText = langSet.serializeFile(st, 'en_us', '  ');
        assert.ok(!enText.includes('"a"'));
        assert.ok(enText.includes('"b"'));
    });

    it('renameKey renames everywhere and rejects collisions', () => {
        const st = langSet.buildState(entries('{ "a": "A" }', '{ "a": "甲", "b": "乙" }'));
        let r = langSet.applyOp(st, { type: 'renameKey', oldKey: 'a', newKey: 'c' });
        assert.strictEqual(r.ok, true);
        assert.ok(st.keys.includes('c'));
        assert.ok(!st.keys.includes('a'));
        assert.strictEqual(langSet.getValue('c', 'zh_cn', st), '甲');
        r = langSet.applyOp(st, { type: 'renameKey', oldKey: 'c', newKey: 'b' });
        assert.strictEqual(r.ok, false); // collision
    });

    it('serializes with preserved order, indent, newline and BOM', () => {
        const st = langSet.buildState(entries(
            '{\n  "a": "A",\n  "b": "B"\n}\n',
            '\uFEFF{\n\t"a": "甲",\n\t"c": "丙"\n}'
        ));
        langSet.applyOp(st, { type: 'addKey', key: 'z', code: 'en_us', value: 'Z' });

        const en = langSet.serializeFile(st, 'en_us', '  ');
        const enLines = en.split('\n');
        assert.strictEqual(enLines[1], '  "a": "A",');
        assert.ok(en.endsWith('\n'));
        // every union key present exactly once, own keys (a, b, z) before foreign tail (c)
        for (const key of ['"a"', '"b"', '"c"', '"z"']) {
            assert.strictEqual(enLines.filter((l) => l.includes(key)).length, 1, key);
        }
        const aIdx = enLines.findIndex((l) => l.includes('"a"'));
        const bIdx = enLines.findIndex((l) => l.includes('"b"'));
        const zIdx = enLines.findIndex((l) => l.includes('"z"'));
        const cIdx = enLines.findIndex((l) => l.includes('"c"'));
        assert.ok(aIdx < bIdx && bIdx < zIdx, 'own keys keep original order, new key appended');
        assert.ok(zIdx < cIdx, 'foreign keys appended after own keys');

        const zh = langSet.serializeFile(st, 'zh_cn', '  ');
        assert.ok(zh.startsWith('\uFEFF'));
        assert.ok(zh.includes('\t"a": "甲"')); // tab indent preserved
        assert.ok(!zh.endsWith('\n')); // no trailing newline in source
        const zhLines = zh.replace('\uFEFF', '').split('\n');
        assert.strictEqual(zhLines[1][0], '\t');
    });

    it('stats counts missing translations', () => {
        const st = langSet.buildState(entries('{ "a": "A", "b": "B" }', '{ "a": "甲" }'));
        const s = langSet.stats(st);
        assert.strictEqual(s.total, 2);
        assert.strictEqual(s.perLang.zh_cn.missing, 1);
        assert.strictEqual(s.perLang.en_us.missing, 0);
    });
});
