// Smoke test: boot the webview UI in jsdom and push an (empty) snapshot to it,
// mirroring "open the editor with an empty/blank language file".
// Run: npm i --no-save jsdom && node scripts/smoke.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let html = readFileSync(join(root, 'media', 'editor.html'), 'utf8');
// The extension host replaces these placeholders; emulate it for the smoke test.
const fileUrl = (p) => 'file:///' + join(root, p).replace(/\\/g, '/');
html = html
    .replace(/<meta[^>]*Content-Security-Policy[^>]*>/i, '')
    .replace(/\{nonce\}/g, 'smoke')
    .replace(/\{cspSource\}/g, '')
    .replace(/\{cssUri\}/g, fileUrl('media/editor.css'))
    .replace(/\{scriptUri\}/g, fileUrl('media/editor.js'));

const sent = [];
const dom = new JSDOM(html, {
    url: 'file:///' + root.replace(/\\/g, '/') + '/',
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
        window.acquireVsCodeApi = () => ({
            postMessage: (m) => sent.push(m),
            getState: () => ({ }),
            setState: () => undefined
        });
        // minimal layout stubs so width/offset code does not blow up
        window.HTMLElement.prototype.getBoundingClientRect = function () {
            return { width: 600, height: 24, top: 0, left: 0, right: 600, bottom: 24, x: 0, y: 0 };
        };
        window.HTMLCanvasElement.prototype.getContext = function () {
            return { measureText: () => ({ width: 10 }) };
        };
        window.ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
        window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
    }
});

const { window } = dom;
const errors = [];
window.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));

// give DOMContentLoaded + ready a moment
await new Promise((r) => setTimeout(r, 100));

function send(msg) {
    const ev = typeof window.MessageEvent === 'function'
        ? new window.MessageEvent('message', { data: msg })
        : Object.assign(new window.Event('message'), { data: msg });
    window.dispatchEvent(ev);
}

try {
    send({
        type: 'init',
        primaryCode: 'en_us',
        bindName: 'en_us.json',
        folderName: 'lang',
        folderPath: '/tmp/lang',
        config: { confirmDelete: true },
        locale: 'zh'
    });
    send({ type: 'uiConfig', fontSize: 14, fontFamily: 'Consolas', themeKind: 'dark' });
    send({
        type: 'snapshot',
        folderName: 'lang',
        langs: [{ code: 'en_us', name: 'en_us.json' }],
        broken: [],
        keys: [],
        values: {},
        canUndo: false,
        canRedo: false
    });
    // also an op-like echo and empty-state render
    send({ type: 'snapshot', folderName: 'lang', langs: [{ code: 'en_us', name: 'en_us.json' }], broken: [], keys: [], values: {}, canUndo: false, canRedo: false });

    // Try opening detail on a key that exists now
    send({
        type: 'snapshot',
        folderName: 'lang',
        langs: [
            { code: 'en_us', name: 'en_us.json' },
            { code: 'zh_cn', name: 'zh_cn.json' }
        ],
        broken: [],
        keys: ['a.b', 'c.d'],
        values: { 'a.b': { en_us: 'Hello\nworld', zh_cn: '你好' } },
        canUndo: false,
        canRedo: false
    });

    const { document } = window;
    // simulate clicking first row to open the detail panel
    const row = document.querySelector('.grid-row');
    if (row) {
        row.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
    }
    await new Promise((r) => setTimeout(r, 50));
    const d = document.getElementById('detail');
    console.log('detail open?', d && !d.classList.contains('hidden'));
    console.log('detailRows children:', document.getElementById('detailRows') ? document.getElementById('detailRows').children.length : -1);
    console.log('rows mounted:', document.querySelectorAll('.grid-row').length);
    console.log('ready sent:', sent.some((m) => m.type === 'ready'));
    console.log('errors:', errors.length ? errors.join('\n') : '(none)');
    if (document.getElementById('initFail') && !document.getElementById('initFail').classList.contains('hidden')) {
        console.log('initFail text:', document.getElementById('initFail').textContent);
    }

    // English locale pass: make sure i18n switching does not throw.
    send({ type: 'init', primaryCode: 'en_us', bindName: 'en_us.json', folderName: 'lang', folderPath: '/tmp/lang', config: { confirmDelete: true }, locale: 'en' });
    await new Promise((r) => setTimeout(r, 30));
    const { document: doc2 } = window;
    console.log('en btnAdd text:', doc2.getElementById('btnAdd') ? doc2.getElementById('btnAdd').textContent : '-');
    console.log('en statText:', doc2.getElementById('statText') ? doc2.getElementById('statText').textContent : '-');
} catch (err) {
    console.error('SMOKE CRASH:', err && err.stack || err);
}
process.exit(0);
