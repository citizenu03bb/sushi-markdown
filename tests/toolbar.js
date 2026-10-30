// Embeds MarkdownRenderer in Sushi's real MainWindow (where the bottom toolbar
// is an overlay over the page) and checks that the toolbar does not swallow
// clicks on page content: a <summary> scrolled just above the bottom edge must
// stay clickable. Usage: gjs tests/toolbar.js <markdown-file>

const {Gio, GLib} = imports.gi;
const res = Gio.Resource.load('/usr/share/sushi/org.gnome.NautilusPreviewer.src.gresource');
res._register();
imports.searchPath.unshift('resource:///org/gnome/NautilusPreviewer/js');
window.pkg = { pkgdatadir: '/usr/share/sushi', name: 'org.gnome.NautilusPreviewer' };
window._ = (s) => s;
String.prototype.format = imports.format.format;
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Gdk = '3.0';
imports.gi.versions.GtkSource = '4';
imports.gi.versions.EvinceDocument = '3.0';
imports.gi.versions.EvinceView = '3.0';
imports.gi.versions.Gst = '1.0';
imports.gi.versions.GstTag = '1.0';
imports.gi.versions.Soup = '3.0';
const {Gtk} = imports.gi;

const MainWindow = imports.ui.mainWindow;

const TIMEOUT_MS = 8000;
// RendererToolbar hides after 1.5 s without pointer motion, then crossfades
const FADE_OUT_MS = 1500 + 600;

function assert(cond, what) {
    if (!cond)
        throw new Error(what);
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
                resolve(view.run_javascript_finish(result).get_js_value().to_string());
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function waitFor(what, fn) {
    for (let waited = 0; waited < TIMEOUT_MS; waited += 50) {
        let value = fn();
        if (value)
            return value;
        await delay(50);
    }
    throw new Error(`Timed out waiting for ${what}`);
}

async function step(name, fn) {
    try {
        await fn();
        print(`   OK: ${name}`);
    } catch (e) {
        throw new Error(`${name}: ${e.message}`);
    }
}

// The toolbar's allocation in WebView coordinates
function toolbarRect(r) {
    let tb = r._toolbar;
    let [, x, y] = tb.translate_coordinates(r._webView, 0, 0);
    let alloc = tb.get_allocation();
    return {x, y, width: alloc.width, height: alloc.height};
}

function contains(rect, x, y) {
    return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

let win = null;

async function main(app) {
    let file = Gio.File.new_for_path(ARGV[0]);
    win = new MainWindow.MainWindow(app);
    win.setFile(file);

    let r = await waitFor('the Markdown renderer', () => win._renderer && win._renderer._webView && win._renderer);
    await waitFor('the page to load', () => r._webView.estimated_load_progress === 1 && !r._webView.is_loading);
    await waitFor('the toolbar to be shown', () => r._toolbar && r._toolbar.get_mapped());

    // Put the <summary> right above the bottom margin, where the toolbar sits
    let summary = JSON.parse(await evalJs(r, `JSON.stringify((() => {
        const s = document.querySelector('summary');
        window.scrollTo(0, 0);
        const b = s.getBoundingClientRect();
        window.scrollBy(0, b.bottom - innerHeight + 32 + 24);
        const c = s.getBoundingClientRect();
        return {x: c.left + 20, y: (c.top + c.bottom) / 2};
    })())`));

    await step('toolbar is only as wide as its buttons', async () => {
        r._toolbar.resetTimeout();
        let tb = toolbarRect(r);
        let boxWidth = r._toolbar.box.get_allocation().width;
        let pageWidth = r._webView.get_allocated_width();
        assert(tb.width <= boxWidth + 1,
            `toolbar is ${tb.width}px wide but its buttons only need ${boxWidth}px (page is ${pageWidth}px)`);
    });

    await step('a <summary> in the bottom band is not covered by the toolbar', async () => {
        r._toolbar.resetTimeout();
        let tb = toolbarRect(r);
        assert(!contains(tb, summary.x, summary.y),
            `toolbar ${JSON.stringify(tb)} covers the summary at ${summary.x},${summary.y}`);
        let hit = await evalJs(r, `document.elementFromPoint(${summary.x}, ${summary.y}).tagName`);
        assert(hit === 'SUMMARY', `page hit-tests ${hit} at the summary position`);
    });

    await step('faded-out toolbar leaves no invisible input area', async () => {
        await delay(FADE_OUT_MS);
        assert(!r._toolbar.reveal_child, 'toolbar did not fade out');
        assert(!r._toolbar.get_visible(), 'faded-out toolbar is still visible and catches input');
    });

    await step('pointer motion brings the toolbar back', async () => {
        r._toolbar.resetTimeout();
        await waitFor('the toolbar to reappear',
            () => r._toolbar.get_visible() && r._toolbar.get_mapped() && r._toolbar.child_revealed);
    });

    await step('clicking the summary expands the details', async () => {
        let open = await evalJs(r, `(() => {
            document.elementFromPoint(${summary.x}, ${summary.y}).click();
            return String(document.querySelector('details').open);
        })()`);
        assert(open === 'true', 'details did not open');
    });
}

let exitCode = 0;
let app = new Gtk.Application({ application_id: 'org.example.SushiMarkdownToolbarTest',
                                flags: Gio.ApplicationFlags.NON_UNIQUE });
app.connect('activate', () => {
    app.hold();
    main(app).catch((e) => {
        printerr(`FAIL: ${e.message}`);
        exitCode = 1;
    }).finally(() => {
        // The window holds the application; close it on failure too
        if (win)
            win.destroy();
        app.release();
    });
});
app.run([]);
imports.system.exit(exitCode);
