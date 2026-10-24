/*
 * Custom Markdown Viewer for GNOME Sushi (Nautilus Previewer)
 * Renders Markdown files with GitHub-flavored formatting, syntax highlighting,
 * in-preview navigation for linked .md files (with Back/Forward history),
 * persistent HeaderBar controls + bottom hover toolbar, and keyboard shortcuts.
 */

const {Gdk, Gio, GLib, GObject, Gtk, GtkSource} = imports.gi;

var WebKit2;
try {
    imports.gi.versions.WebKit2 = '4.1';
    WebKit2 = imports.gi.WebKit2;
} catch (e) {
    try {
        imports.gi.versions.WebKit2 = '4.0';
        WebKit2 = imports.gi.WebKit2;
    } catch (e2) {
    }
}

const Renderer = imports.ui.renderer;
const Utils = imports.ui.utils;

const MARKDOWN_EXTS = ['.md', '.markdown', '.mkd', '.mdown', '.mdtxt', '.mdtext'];

function _isAvailable() {
    return WebKit2 !== undefined;
}

function _isDarkTheme() {
    try {
        let settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        let scheme = settings.get_string('color-scheme');
        if (scheme === 'prefer-dark')
            return true;
        if (scheme === 'prefer-light')
            return false;
        let gtkTheme = settings.get_string('gtk-theme') || '';
        if (gtkTheme.toLowerCase().includes('dark'))
            return true;
    } catch (e) {
        // Settings schema may be unavailable; fall through to Gtk.Settings
    }
    let gtkSettings = Gtk.Settings.get_default();
    return gtkSettings ? !!gtkSettings.gtk_application_prefer_dark_theme : true;
}

function _isMarkdownFile(file) {
    let basename = (file.get_basename() || '').toLowerCase();
    if (MARKDOWN_EXTS.some((ext) => basename.endsWith(ext)))
        return true;

    try {
        let info = file.query_info(
            Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        let contentType = info.get_content_type();
        if (contentType === 'text/markdown' || contentType === 'text/x-markdown')
            return true;
    } catch (e) {
        // query_info may fail; fall through to extension-based check
    }
    return false;
}

function _resolveLocalTarget(fileUri) {
    let candidate = Gio.File.new_for_uri(fileUri);

    if (candidate.query_exists(null)) {
        try {
            let fileType = candidate.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
            if (fileType === Gio.FileType.DIRECTORY) {
                for (let readme of ['README.md', 'readme.md', 'index.md', 'INDEX.md']) {
                    let child = candidate.get_child(readme);
                    if (child.query_exists(null))
                        return child;
                }
            }
        } catch (e) {
            // query_file_type may fail on some filesystems; treat as regular file
        }
        return candidate;
    }

    // Support extensionless Markdown links (e.g. [Guide](./guide))
    for (let ext of ['.md', '.markdown']) {
        let withExt = Gio.File.new_for_uri(fileUri + ext);
        if (withExt.query_exists(null))
            return withExt;
    }

    return null;
}

var Klass = _isAvailable() ? GObject.registerClass({
    Implements: [Renderer.Renderer],
    Properties: {
        fullscreen: GObject.ParamSpec.boolean('fullscreen', '', '',
                                              GObject.ParamFlags.READABLE,
                                              false),
        ready: GObject.ParamSpec.boolean('ready', '', '',
                                         GObject.ParamFlags.READABLE,
                                         false)
    },
}, class MarkdownRenderer extends Gtk.Stack {
    get ready() {
        return !!this._ready;
    }

    get fullscreen() {
        return !!this._fullscreen;
    }

    _init(file, fileInfo) {
        super._init({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 150,
            hexpand: true,
            vexpand: true
        });

        this._file = file;
        this._fileInfo = fileInfo;
        this._cancellable = new Gio.Cancellable();
        this._dark = _isDarkTheme();
        this._pendingFragment = null;
        this._currentBaseUri = null;
        this._headerBox = null;

        // Navigation history stack for linked .md files
        this._history = [{ file: file, fragment: null }];
        this._historyIndex = 0;

        // 1. Rendered Markdown view (WebKit2.WebView)
        this._webView = new WebKit2.WebView({
            hexpand: true,
            vexpand: true
        });

        let bgRgba = new Gdk.RGBA();
        bgRgba.parse(this._dark ? '#1e1e1e' : '#ffffff');
        this._webView.set_background_color(bgRgba);

        // Disable default right-click context menu
        this._webView.connect('context-menu', () => true);

        // Wake up the bottom hover toolbar when moving the mouse inside WebView
        this._webView.add_events(Gdk.EventMask.POINTER_MOTION_MASK);
        this._webView.connect('motion-notify-event', () => {
            if (this._toolbar)
                this._toolbar.resetTimeout();
            return false;
        });

        // Scroll to pending #fragment once HTML finishes loading
        this._webView.connect('load-changed', (view, loadEvent) => {
            if (loadEvent === WebKit2.LoadEvent.FINISHED && this._pendingFragment !== null) {
                let frag = this._pendingFragment;
                this._pendingFragment = null;
                let escaped = JSON.stringify(frag);
                this._webView.run_javascript(
                    `if (window.__sushiScrollTo) window.__sushiScrollTo(${escaped});`,
                    null,
                    null
                );
            }
        });

        // Intercept all link clicks and custom sushi-md:// shortcut actions
        this._webView.connect('decide-policy', (view, decision, decisionType) => {
            if (decisionType === WebKit2.PolicyDecisionType.NAVIGATION_ACTION ||
                decisionType === WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION) {
                let navAction = decision.get_navigation_action();
                let navType = navAction.get_navigation_type();
                let uri = navAction.get_request().get_uri() || '';

                if (uri.startsWith('sushi-md://')) {
                    this._handleLinkUri(uri);
                    decision.ignore();
                    return true;
                }

                // Allow the initial load_html(stdout, baseUri) call
                if (decisionType === WebKit2.PolicyDecisionType.NAVIGATION_ACTION &&
                    navType === WebKit2.NavigationType.OTHER &&
                    (uri === this._currentBaseUri || uri === 'about:blank')) {
                    return false;
                }

                if (navType === WebKit2.NavigationType.LINK_ACTIVATED ||
                    decisionType === WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION ||
                    uri.startsWith('file://')) {
                    if (this._handleLinkUri(uri)) {
                        decision.ignore();
                        return true;
                    }
                }
            }
            return false;
        });

        // Mouse Back/Forward buttons (8/9)
        this._webView.connect('button-press-event', (widget, event) => {
            let [, button] = event.get_button();
            if (button === 8) {
                this._goBack();
                return true;
            } else if (button === 9) {
                this._goForward();
                return true;
            }
            return false;
        });

        this.add_named(this._webView, 'rendered');

        // 2. Raw Markdown source view (GtkSource.View inside Gtk.ScrolledWindow)
        this._rawScrolled = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true
        });
        this._rawBuffer = this._createRawBuffer();
        this._sourceView = new GtkSource.View({
            buffer: this._rawBuffer,
            editable: false,
            cursor_visible: false,
            monospace: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            show_line_numbers: true,
            left_margin: 12,
            right_margin: 12,
            top_margin: 12,
            bottom_margin: 12
        });
        this._sourceView.add_events(Gdk.EventMask.POINTER_MOTION_MASK);
        this._sourceView.connect('motion-notify-event', () => {
            if (this._toolbar)
                this._toolbar.resetTimeout();
            return false;
        });
        this._rawScrolled.add(this._sourceView);
        this.add_named(this._rawScrolled, 'raw');

        this.connect('hierarchy-changed', () => {
            this._attachWindowControls();
        });

        this.show_all();
        this.set_visible_child_name('rendered');

        this._loadFileContent(file, null);
        this.connect('destroy', this._onDestroy.bind(this));
    }

    _attachWindowControls() {
        let toplevel = this.get_toplevel();
        if (!toplevel || toplevel === this || this._headerBox)
            return;

        // 1. Register window-level keyboard accelerators (Alt+Left, Alt+Right, BackSpace, Ctrl+U)
        let application = Gio.Application.get_default();
        let actionGroup = new Gio.SimpleActionGroup();

        let backAction = new Gio.SimpleAction({ name: 'back' });
        backAction.connect('activate', () => this._goBack());
        actionGroup.add_action(backAction);

        let forwardAction = new Gio.SimpleAction({ name: 'forward' });
        forwardAction.connect('activate', () => this._goForward());
        actionGroup.add_action(forwardAction);

        let toggleRawAction = new Gio.SimpleAction({ name: 'toggle-raw' });
        toggleRawAction.connect('activate', () => this._toggleRawView());
        actionGroup.add_action(toggleRawAction);

        toplevel.insert_action_group('md', actionGroup);
        this.insert_action_group('md', actionGroup);

        if (application) {
            application.set_accels_for_action('md.back', ['<Alt>Left', 'BackSpace']);
            application.set_accels_for_action('md.forward', ['<Alt>Right']);
            application.set_accels_for_action('md.toggle-raw', ['<Control>u']);
        }

        // 2. Add always-visible Back / Forward / Raw-toggle buttons to the top HeaderBar
        if (toplevel._titlebar) {
            this._headerBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6
            });

            let navBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 0
            });
            navBox.get_style_context().add_class('linked');

            this._headerBackBtn = Gtk.Button.new_from_icon_name('go-previous-symbolic', Gtk.IconSize.BUTTON);
            this._headerBackBtn.set_tooltip_text('Back (Alt+Left)');
            this._headerBackBtn.set_sensitive(this._historyIndex > 0);
            this._headerBackBtn.connect('clicked', () => this._goBack());
            navBox.add(this._headerBackBtn);

            this._headerForwardBtn = Gtk.Button.new_from_icon_name('go-next-symbolic', Gtk.IconSize.BUTTON);
            this._headerForwardBtn.set_tooltip_text('Forward (Alt+Right)');
            this._headerForwardBtn.set_sensitive(this._historyIndex < this._history.length - 1);
            this._headerForwardBtn.connect('clicked', () => this._goForward());
            navBox.add(this._headerForwardBtn);

            this._headerBox.add(navBox);

            this._headerToggleBtn = Gtk.Button.new_from_icon_name('utilities-terminal-symbolic', Gtk.IconSize.BUTTON);
            this._headerToggleBtn.set_tooltip_text('Toggle Raw Markdown Source (Ctrl+U)');
            this._headerToggleBtn.connect('clicked', () => this._toggleRawView());
            this._headerBox.add(this._headerToggleBtn);

            this._headerBox.show_all();
            toplevel._titlebar.pack_start(this._headerBox);
        }
    }

    _onDestroy() {
        this._cancellable.cancel();
        if (this._headerBox) {
            this._headerBox.destroy();
            this._headerBox = null;
        }
    }

    _toggleRawView() {
        let showingRendered = this.get_visible_child_name() === 'rendered';
        let nextMode = showingRendered ? 'raw' : 'rendered';
        this.set_visible_child_name(nextMode);

        let iconName = nextMode === 'raw' ? 'text-x-generic-symbolic' : 'utilities-terminal-symbolic';
        let tooltip = nextMode === 'raw' ? 'Show Rendered Markdown (Ctrl+U)' : 'Show Raw Markdown Source (Ctrl+U)';

        if (this._toggleBtn && this._toggleBtn.image) {
            this._toggleBtn.image.icon_name = iconName;
            this._toggleBtn.set_tooltip_text(tooltip);
        }
        if (this._headerToggleBtn && this._headerToggleBtn.get_image()) {
            this._headerToggleBtn.get_image().icon_name = iconName;
            this._headerToggleBtn.set_tooltip_text(tooltip);
        }
    }

    _handleLinkUri(uri) {
        if (!uri)
            return false;

        // 0. Internal keyboard action triggers from WebKit2 DOM
        if (uri === 'sushi-md://back') {
            this._goBack();
            return true;
        }
        if (uri === 'sushi-md://forward') {
            this._goForward();
            return true;
        }
        if (uri === 'sushi-md://toggle-raw') {
            this._toggleRawView();
            return true;
        }

        // 1. External web / mail links -> open in default browser
        if (uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('mailto:')) {
            try {
                Gio.AppInfo.launch_default_for_uri(uri, null);
            } catch (e) {
                logError(e, `Failed to open external URI: ${uri}`);
            }
            return true;
        }

        // 2. Local file:// links
        if (uri.startsWith('file://')) {
            let hashIdx = uri.indexOf('#');
            let fileUri = hashIdx !== -1 ? uri.slice(0, hashIdx) : uri;
            let fragment = hashIdx !== -1 ? decodeURIComponent(uri.slice(hashIdx + 1)) : null;

            // Same-document anchor link
            if (fileUri === this._file.get_uri() || fileUri === this._currentBaseUri) {
                if (fragment !== null) {
                    let escaped = JSON.stringify(fragment);
                    this._webView.run_javascript(
                        `if (window.__sushiScrollTo) window.__sushiScrollTo(${escaped});`,
                        null,
                        null
                    );
                }
                return true;
            }

            let targetFile = _resolveLocalTarget(fileUri);
            if (!targetFile)
                return true;

            if (_isMarkdownFile(targetFile)) {
                this._navigateToMarkdown(targetFile, fragment, true);
                return true;
            }

            // Non-Markdown local file (e.g. image, PDF, source code) -> let Sushi preview it
            let toplevel = this.get_toplevel();
            if (toplevel && typeof toplevel.setFile === 'function') {
                toplevel.setFile(targetFile);
            } else {
                try {
                    Gio.AppInfo.launch_default_for_uri(targetFile.get_uri(), null);
                } catch (e) {
                    logError(e, `Failed to open ${targetFile.get_uri()}`);
                }
            }
            return true;
        }

        return false;
    }

    _navigateToMarkdown(targetFile, fragment, pushHistory) {
        if (pushHistory) {
            this._history = this._history.slice(0, this._historyIndex + 1);
            this._history.push({ file: targetFile, fragment: fragment || null });
            this._historyIndex = this._history.length - 1;
        }

        this._file = targetFile;
        this._updateToolbarSensitivity();
        this._updateWindowHeader(targetFile);
        this._loadFileContent(targetFile, fragment);
    }

    _goBack() {
        if (this._historyIndex <= 0)
            return;
        this._historyIndex--;
        let entry = this._history[this._historyIndex];
        this._file = entry.file;
        this._updateToolbarSensitivity();
        this._updateWindowHeader(entry.file);
        this._loadFileContent(entry.file, entry.fragment);
    }

    _goForward() {
        if (this._historyIndex >= this._history.length - 1)
            return;
        this._historyIndex++;
        let entry = this._history[this._historyIndex];
        this._file = entry.file;
        this._updateToolbarSensitivity();
        this._updateWindowHeader(entry.file);
        this._loadFileContent(entry.file, entry.fragment);
    }

    _updateWindowHeader(targetFile) {
        let toplevel = this.get_toplevel();
        if (toplevel && toplevel !== this) {
            toplevel.file = targetFile;
            if (typeof toplevel.set_title === 'function')
                toplevel.set_title(targetFile.get_basename());
            if (typeof toplevel._updateTitlebar === 'function')
                toplevel._updateTitlebar();
        }
    }

    _updateToolbarSensitivity() {
        let canBack = this._historyIndex > 0;
        let canForward = this._historyIndex < this._history.length - 1;

        if (this._backBtn)
            this._backBtn.set_sensitive(canBack);
        if (this._forwardBtn)
            this._forwardBtn.set_sensitive(canForward);
        if (this._headerBackBtn)
            this._headerBackBtn.set_sensitive(canBack);
        if (this._headerForwardBtn)
            this._headerForwardBtn.set_sensitive(canForward);
    }

    _loadFileContent(file, fragment) {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        this._pendingFragment = fragment !== undefined ? fragment : '';

        this._loadRawBufferContent(file);
        this._renderMarkdown(file);
    }

    _renderMarkdown(file) {
        let localPath = file.get_path();
        let parent = file.get_parent();
        let baseUri = parent ? (parent.get_uri() + '/') : file.get_uri();
        this._currentBaseUri = baseUri;

        let scriptPath = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'sushi',
            'render_markdown.py'
        ]);

        if (!localPath) {
            this._webView.load_uri(file.get_uri());
            if (!this.ready)
                this.isReady();
            return;
        }

        try {
            let proc = Gio.Subprocess.new(
                ['python3', scriptPath, localPath, this._dark ? 'dark' : 'light'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, this._cancellable, (procObj, res) => {
                try {
                    let [, stdout, stderr] = procObj.communicate_utf8_finish(res);
                    if (procObj.get_successful() && stdout) {
                        this._webView.load_html(stdout, baseUri);
                    } else {
                        logError(new Error(stderr || 'Markdown render failed'));
                        this.set_visible_child_name('raw');
                    }
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'Failed to render markdown');
                }
                if (!this.ready)
                    this.isReady();
            });
        } catch (e) {
            logError(e, 'Failed to spawn render_markdown.py');
            this.set_visible_child_name('raw');
            if (!this.ready)
                this.isReady();
        }
    }

    _createRawBuffer() {
        let buffer = new GtkSource.Buffer();
        let styleManager = GtkSource.StyleSchemeManager.get_default();
        if (typeof pkg !== 'undefined' && pkg.pkgdatadir) {
            let stylePath = GLib.build_filenamev([
                pkg.pkgdatadir,
                'gtksourceview-4',
                'styles'
            ]);
            styleManager.prepend_search_path(stylePath);
        }

        let scheme = styleManager.get_scheme('builder-dark') || styleManager.get_scheme('oblivion');
        if (scheme)
            buffer.set_style_scheme(scheme);

        let langManager = GtkSource.LanguageManager.get_default();
        let language = langManager.get_language('markdown');
        if (language)
            buffer.set_language(language);

        return buffer;
    }

    _loadRawBufferContent(file) {
        let sourceFile = new GtkSource.File({ location: file });
        let loader = new GtkSource.FileLoader({
            buffer: this._rawBuffer,
            file: sourceFile
        });
        loader.load_async(0, this._cancellable, null, (ldr, result) => {
            try {
                ldr.load_finish(result);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(e, 'Failed to load raw file content');
            }
        });
    }

    populateToolbar(toolbar) {
        this._backBtn = Utils.createToolButton(this, 'go-previous-symbolic', () => {
            this._goBack();
        });
        this._backBtn.set_tooltip_text('Back (Alt+Left)');
        this._backBtn.set_sensitive(false);
        toolbar.add(this._backBtn);

        this._forwardBtn = Utils.createToolButton(this, 'go-next-symbolic', () => {
            this._goForward();
        });
        this._forwardBtn.set_tooltip_text('Forward (Alt+Right)');
        this._forwardBtn.set_sensitive(false);
        toolbar.add(this._forwardBtn);

        toolbar.add(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }));

        this._toggleBtn = Utils.createToolButton(this, 'utilities-terminal-symbolic', () => {
            this._toggleRawView();
        });
        this._toggleBtn.set_tooltip_text('Show Raw Markdown Source (Ctrl+U)');
        toolbar.add(this._toggleBtn);

        // Work around upstream GNOME Sushi 50.0 bug where _embedRenderer adds
        // this._renderer.toolbar after MainWindow.show_all() without calling
        // toolbar.show_all().
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._toolbar) {
                this._toolbar.show_all();
                this._toolbar.resetTimeout();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    static {
        WebKit2.WebContext.get_default().set_sandbox_enabled(true);
    }

    get moveOnClick() {
        return false;
    }
}) : undefined;

var mimeTypes = [];
if (_isAvailable()) {
    mimeTypes = [
        'text/markdown',
        'text/x-markdown'
    ];
}
