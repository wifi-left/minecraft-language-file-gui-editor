'use strict';

// Integration tests that exercise the real FolderModel (vscode API, filesystem,
// document writes, undo/redo). Run with `npx vscode-test` (extension host).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { ModelRegistry } = require('../src/model');

describe('FolderModel integration', function () {
    this.timeout(30000);

    let dir;
    let enPath;
    let zhPath;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mclang-gui-test-'));
        enPath = path.join(dir, 'en_us.json');
        zhPath = path.join(dir, 'zh_cn.json');
        fs.writeFileSync(enPath, '{\n  "a": "A",\n  "b": "B"\n}\n', 'utf8');
        fs.writeFileSync(zhPath, '{\n  "a": "甲",\n  "c": "丙"\n}\n', 'utf8');
    });

    afterEach(() => {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    async function makeModel() {
        const registry = new ModelRegistry();
        const model = await registry.getOrCreate({}, vscode.Uri.file(dir));
        return { registry, model };
    }

    it('loads both languages and persists edits to disk', async () => {
        const { registry, model } = await makeModel();
        const messages = [];
        model.attachPanel((m) => messages.push(m));

        assert.deepStrictEqual(model.langs, ['en_us', 'zh_cn']);
        assert.strictEqual(model.snapshot().keys.length, 3);

        const res = await model.doOp({ type: 'setValue', key: 'a', code: 'zh_cn', value: '甲甲' }, '');
        assert.strictEqual(res.ok, true);
        assert.ok(fs.readFileSync(zhPath, 'utf8').includes('"a": "甲甲"'));
        assert.ok(!fs.readFileSync(enPath, 'utf8').includes('甲甲'));
        // op echo broadcast
        assert.ok(messages.some((m) => m.type === 'op' && m.op.type === 'setValue'));
        registry.disposeModel(model);
    });

    it('addKey writes placeholders to every language file, undo removes them', async () => {
        const { registry, model } = await makeModel();
        await model.doOp({ type: 'addKey', key: 'item.minecraft.stick', code: 'en_us', value: 'Stick' }, '');
        const en = fs.readFileSync(enPath, 'utf8');
        const zh = fs.readFileSync(zhPath, 'utf8');
        assert.ok(en.includes('"item.minecraft.stick": "Stick"'));
        assert.ok(zh.includes('"item.minecraft.stick": ""'));

        assert.strictEqual(model.canUndo(), true);
        await model.undo('');
        assert.ok(!fs.readFileSync(enPath, 'utf8').includes('item.minecraft.stick'));
        assert.ok(!fs.readFileSync(zhPath, 'utf8').includes('item.minecraft.stick'));
        assert.strictEqual(model.canRedo(), true);

        await model.redo('');
        assert.ok(fs.readFileSync(zhPath, 'utf8').includes('"item.minecraft.stick": ""'));
        registry.disposeModel(model);
    });

    it('removeKeys deletes across files and undo restores exact content', async () => {
        const { registry, model } = await makeModel();
        await model.doOp({ type: 'removeKeys', keys: ['a'] }, '');
        const en = fs.readFileSync(enPath, 'utf8');
        const zh = fs.readFileSync(zhPath, 'utf8');
        assert.ok(!en.includes('"a"'));
        assert.ok(!zh.includes('"a"'));

        await model.undo('');
        const en2 = fs.readFileSync(enPath, 'utf8');
        const zh2 = fs.readFileSync(zhPath, 'utf8');
        assert.ok(en2.includes('"a": "A"'));
        assert.ok(zh2.includes('"a": "甲"'));
        registry.disposeModel(model);
    });

    it('keeps key order and BOM/newline format when rewriting', async () => {
        // replace files with distinctive formatting
        fs.writeFileSync(zhPath, '\uFEFF{\r\n\t"a": "甲",\r\n\t"c": "丙"\r\n}', 'utf8');
        const { registry, model } = await makeModel();
        await model.doOp({ type: 'setValue', key: 'c', code: 'zh_cn', value: '丙丙' }, '');
        const zh = fs.readFileSync(zhPath, 'utf8');
        assert.ok(zh.startsWith('\uFEFF'));
        assert.ok(zh.includes('\r\n'));
        assert.ok(zh.includes('\t"a": "甲",'));
        assert.ok(zh.includes('"c": "丙丙"'));
        assert.ok(!zh.endsWith('\n')); // original had no trailing newline
        registry.disposeModel(model);
    });

    it('isolates a broken file and never rewrites it', async () => {
        fs.writeFileSync(zhPath, '{ not valid json', 'utf8');
        const { registry, model } = await makeModel();
        assert.deepStrictEqual(model.langs, ['en_us']);
        assert.strictEqual(model.snapshot().broken.length, 1);
        await model.doOp({ type: 'setValue', key: 'a', code: 'en_us', value: 'AAA' }, '');
        const zh = fs.readFileSync(zhPath, 'utf8');
        assert.strictEqual(zh, '{ not valid json'); // untouched
        registry.disposeModel(model);
    });

    it('opens normally when a sibling file is empty or has invalid JSON', async () => {
        // zh_cn.json is empty, ja_jp.json is broken JSON — neither may block loading.
        fs.writeFileSync(zhPath, '', 'utf8');
        const jaPath = path.join(dir, 'ja_jp.json');
        fs.writeFileSync(jaPath, '{ oops', 'utf8');

        const { registry, model } = await makeModel();
        assert.deepStrictEqual(model.langs, ['en_us', 'zh_cn']); // empty file is editable
        const broken = model.snapshot().broken.map((b) => b.name);
        assert.deepStrictEqual(broken, ['ja_jp.json']);

        // Adding a key must reach en_us + the empty zh_cn, and skip the broken file.
        const res = await model.doOp({ type: 'addKey', key: 'new.key', code: 'en_us', value: 'N' }, '');
        assert.strictEqual(res.ok, true);
        assert.ok(fs.readFileSync(enPath, 'utf8').includes('"new.key": "N"'));
        assert.ok(fs.readFileSync(zhPath, 'utf8').includes('"new.key": ""'));
        assert.strictEqual(fs.readFileSync(jaPath, 'utf8'), '{ oops'); // untouched

        registry.disposeModel(model);
    });

    it('opens and edits a folder whose only file is empty', async () => {
        fs.rmSync(zhPath); // only en_us remains, and it is empty
        fs.writeFileSync(enPath, '', 'utf8');
        const { registry, model } = await makeModel();
        assert.deepStrictEqual(model.langs, ['en_us']);
        await model.doOp({ type: 'addKey', key: 'a.b', code: 'en_us', value: 'X' }, '');
        const text = fs.readFileSync(enPath, 'utf8');
        assert.ok(text.includes('"a.b": "X"'));
        registry.disposeModel(model);
    });
});
