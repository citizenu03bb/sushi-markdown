// Drives MarkdownRenderer through real link clicks inside the WebView and
// checks the rendered page, history stack, toolbar state and raw buffer after
// every step. Usage: gjs tests/navigation.js <fixture-dir>

const {Gio, GLib} = imports.gi;
const res = Gio.Resource.load('/usr/share/sushi/org.gnome.NautilusPreviewer.src.gresource');
res._register();
imports.searchPath.unshift('resource:///org/gnome/NautilusPreviewer/js');
window.pkg = { pkgdatadir: '/usr/share/sushi', name: 'org.gnome.NautilusPreviewer' };
window._ = (s) => s;
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Gdk = '3.0';
imports.gi.versions.GtkSource = '4';
imports.gi.versions.EvinceDocument = '3.0';
imports.gi.versions.EvinceView = '3.0';
imports.gi.versions.Gst = '1.0';
imports.gi.versions.GstTag = '1.0';
imports.gi.versions.Soup = '3.0';
const {Gtk} = imports.gi;
Gtk.init(null);

const WebKit2 = imports.gi.WebKit2;
const MimeHandler = imports.ui.mimeHandler;

const fixtureDir = ARGV[0];
const TIMEOUT_MS = 8000;

function assertEq(actual, expected, what) {
    if (actual !== expected)
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function delay(ms) {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function evalJs(r, code) {
    return new Promise((resolve, reject) => {
        r._webView.run_javascript(code, null, (view, result) => {
            try {
                resolve(view.run_javascript_finish(result).get_js_value());
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Run `action` and resolve once a new page has finished loading in the WebView.
function expectLoad(r, action, what) {
    return new Promise((resolve, reject) => {
        let timeoutId = 0;
        let handlerId = r._webView.connect('load-changed', (view, event) => {
            if (event !== WebKit2.LoadEvent.FINISHED)
                return;
            r._webView.disconnect(handlerId);
            GLib.source_remove(timeoutId);
            // Let queued fragment scrolling run before inspecting the page
            delay(150).then(resolve);
        });
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MS, () => {
            r._webView.disconnect(handlerId);
            reject(new Error(`${what}: page never loaded (navigation was dropped)`));
            return GLib.SOURCE_REMOVE;
        });
        Promise.resolve(action()).catch(reject);
    });
}

function click(r, href) {
    let sel = JSON.stringify(`a[href="${href}"]`);
    return evalJs(r, `(() => {
        let a = document.querySelector(${sel});
        if (!a) return false;
        a.click();
        return true;
    })()`).then((found) => {
        if (!found.to_boolean())
            throw new Error(`No link with href ${href} on page`);
    });
}

function pressKey(r, init) {
    return evalJs(r, `window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(init)}))`);
}

async function heading(r) {
    return (await evalJs(r, 'document.querySelector("h1").textContent')).to_string();
}

async function scrollY(r) {
    return (await evalJs(r, 'window.scrollY')).to_double();
}

function rawText(r) {
    let buf = r._rawBuffer;
    return buf.get_text(buf.get_start_iter(), buf.get_end_iter(), false);
}

async function expectPage(r, window, {h1, file, index, length}) {
    assertEq(await heading(r), h1, 'rendered <h1>');
    assertEq(r._file.get_basename(), file, 'current file');
    assertEq(window.get_title(), file, 'window title');
    assertEq(r._historyIndex, index, 'history index');
    assertEq(r._history.length, length, 'history length');
    assertEq(r._backBtn.get_sensitive(), index > 0, 'Back button sensitivity');
    assertEq(r._forwardBtn.get_sensitive(), index < length - 1, 'Forward button sensitivity');
    // The raw source view must follow navigation, not keep the previous file
    for (let i = 0; i < 50 && !rawText(r).includes(`# ${h1}`); i++)
        await delay(20);
    if (!rawText(r).includes(`# ${h1}`))
        throw new Error(`Raw buffer does not show ${file}`);
}

async function step(name, fn) {
    try {
        await fn();
        print(`   OK: ${name}`);
    } catch (e) {
        throw new Error(`${name}: ${e.message}`);
    }
}

async function main() {
    let klass = MimeHandler.getKlass('text/markdown');
    let start = Gio.File.new_for_path(GLib.build_filenamev([fixtureDir, 'a.md']));
    let info = start.query_info('*', Gio.FileQueryInfoFlags.NONE, null);
    // Sushi titles the window after the previewed file; the renderer must keep
    // it in sync while navigating
    let window = new Gtk.Window({title: 'a.md', default_width: 800, default_height: 600});

    // Rendering is asynchronous, so the first load cannot finish before we listen
    let r = new klass(start, info);
    void r.toolbar;
    window.add(r);
    window.show_all();

    await step('initial file renders', async () => {
        await expectLoad(r, () => {}, 'initial load');
        await expectPage(r, window, {h1: 'Page A', file: 'a.md', index: 0, length: 1});
    });

    await step('relative link a.md -> b.md', async () => {
        await expectLoad(r, () => click(r, 'b.md'), 'click b.md');
        await expectPage(r, window, {h1: 'Page B', file: 'b.md', index: 1, length: 2});
    });

    await step('cross-file #fragment link scrolls to the anchor', async () => {
        await expectLoad(r, () => click(r, './a.md#deep-section'), 'click ./a.md#deep-section');
        await expectPage(r, window, {h1: 'Page A', file: 'a.md', index: 2, length: 3});
        if (await scrollY(r) <= 0)
            throw new Error('Page did not scroll to #deep-section');
    });

    await step('Back / Forward walk the history', async () => {
        await expectLoad(r, () => r._goBack(), 'back');
        await expectPage(r, window, {h1: 'Page B', file: 'b.md', index: 1, length: 3});
        await expectLoad(r, () => r._goBack(), 'back');
        await expectPage(r, window, {h1: 'Page A', file: 'a.md', index: 0, length: 3});
        await expectLoad(r, () => r._goForward(), 'forward');
        await expectPage(r, window, {h1: 'Page B', file: 'b.md', index: 1, length: 3});
    });

    await step('Back at the start of history is a no-op', async () => {
        await expectLoad(r, () => r._goBack(), 'back');
        assertEq(r._historyIndex, 0, 'history index');
        r._goBack();
        await delay(300);
        await expectPage(r, window, {h1: 'Page A', file: 'a.md', index: 0, length: 3});
    });

    await step('new link after going back truncates forward history', async () => {
        await expectLoad(r, () => click(r, 'sub/'), 'click sub/');
        await expectPage(r, window, {h1: 'Sub Readme', file: 'README.md', index: 1, length: 2});
    });

    await step('link inside a subdirectory resolves against that directory', async () => {
        await expectLoad(r, () => click(r, 'c.md'), 'click c.md');
        await expectPage(r, window, {h1: 'Page C', file: 'c.md', index: 2, length: 3});
    });

    await step('link to the current directory opens its README', async () => {
        await expectLoad(r, () => click(r, './'), 'click ./');
        await expectPage(r, window, {h1: 'Sub Readme', file: 'README.md', index: 3, length: 4});
    });

    await step('../ link back to the parent directory', async () => {
        await expectLoad(r, () => click(r, '../a.md'), 'click ../a.md');
        await expectPage(r, window, {h1: 'Page A', file: 'a.md', index: 4, length: 5});
    });

    await step('extensionless link resolves guide -> guide.md', async () => {
        await expectLoad(r, () => click(r, 'guide'), 'click guide');
        await expectPage(r, window, {h1: 'Guide', file: 'guide.md', index: 5, length: 6});
    });

    await step('LaTeX formulas are typeset after in-preview navigation', async () => {
        let count = 0;
        for (let i = 0; i < 50 && count < 2; i++) {
            await delay(100);
            count = (await evalJs(r, 'document.querySelectorAll(".math mjx-container svg").length')).to_int32();
        }
        assertEq(count, 2, 'typeset MathJax formulas');
    });

    await step('Alt+Left / Alt+Right / Backspace shortcuts navigate', async () => {
        await expectLoad(r, () => pressKey(r, {key: 'ArrowLeft', altKey: true}), 'Alt+Left');
        await expectPage(r, window, {h1: 'Page A', file: 'a.md', index: 4, length: 6});
        await expectLoad(r, () => pressKey(r, {key: 'ArrowRight', altKey: true}), 'Alt+Right');
        await expectPage(r, window, {h1: 'Guide', file: 'guide.md', index: 5, length: 6});
        await expectLoad(r, () => pressKey(r, {key: 'Backspace'}), 'Backspace');
        await expectPage(r, window, {h1: 'Page A', file: 'a.md', index: 4, length: 6});
    });

    await step('link to a file name with spaces and parentheses', async () => {
        await expectLoad(r, () => click(r, 'notes%20(draft).md'), 'click notes (draft).md');
        await expectPage(r, window, {h1: 'Draft Notes', file: 'notes (draft).md', index: 5, length: 6});
    });

    await step('self link with #fragment scrolls without reloading or pushing history', async () => {
        let reloaded = false;
        let id = r._webView.connect('load-changed', () => {
            reloaded = true;
        });
        await click(r, 'notes%20(draft).md#the-end');
        await delay(800);
        r._webView.disconnect(id);
        if (reloaded)
            throw new Error('Self link reloaded the page');
        await expectPage(r, window, {h1: 'Draft Notes', file: 'notes (draft).md', index: 5, length: 6});
        if (await scrollY(r) <= 0)
            throw new Error('Page did not scroll to #the-end');
    });

    await step('rapid successive clicks end on the last target', async () => {
        await expectLoad(r, () => {
            r._handleLinkUri(start.get_parent().get_child('b.md').get_uri());
            r._handleLinkUri(start.get_parent().get_child('guide.md').get_uri());
        }, 'rapid clicks');
        await delay(500);
        await expectPage(r, window, {h1: 'Guide', file: 'guide.md', index: 7, length: 8});
    });
}

let exitCode = 0;
main().catch((e) => {
    printerr(`FAIL: ${e.message}`);
    exitCode = 1;
}).finally(() => {
    Gtk.main_quit();
});
Gtk.main();
imports.system.exit(exitCode);
