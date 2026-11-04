import AppKit
import AVFoundation
import WebKit

/// Web 版を WKWebView で表示し、蓋の角度とビューポートの位置を流し込む薄いラッパー。
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate,
    WKScriptMessageHandler
{
    /// 開いているページの URL。同梱版を使う場合はサーバーの起動後に決まる。
    private var url: URL!
    private let startFullscreen: Bool
    private let startPath: String?
    private let plyDirArg: URL?
    private static let plyDirKey = "plyDirectory"
    private var server: LocalServer?
    private var window: NSWindow!
    private var webView: WKWebView!
    private let sensor = LidAngleSensor()
    private var timer: Timer?
    private var lastSentAngle: Double?
    private var pageReady = false

    init(url: URL?, startPath: String?, plyDir: URL?, startFullscreen: Bool) {
        self.url = url
        self.startPath = startPath
        plyDirArg = plyDir
        self.startFullscreen = startFullscreen
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMenu()

        let screen = NSScreen.builtIn ?? NSScreen.main!
        window = NSWindow(
            contentRect: screen.visibleFrame.insetBy(dx: 120, dy: 80),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false,
            screen: screen
        )
        window.title = "Pseudo 3D Window"
        window.collectionBehavior = [.fullScreenPrimary]
        window.delegate = self

        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "native")
        // Web 側の JS エラーを Swift のログに転送する
        config.userContentController.addUserScript(WKUserScript(
            source: """
            addEventListener('error', e => webkit.messageHandlers.native.postMessage('jserror: ' + e.message + ' @' + e.filename + ':' + e.lineno));
            addEventListener('unhandledrejection', e => webkit.messageHandlers.native.postMessage('jserror: ' + (e.reason && e.reason.stack || e.reason)));
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true } // Safari の開発メニューから検証できる
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        print(sensor.isAvailable
            ? "lid angle sensor: \(sensor.read().map { "\($0)°" } ?? "?")"
            : "lid angle sensor: not available (web 側のスライダーを使う)")

        // 同梱版のサーバーを起動し、カメラ許可を取ってからページを読み込む
        // (WKWebView の getUserMedia より先に、アプリとしてのカメラ許可を取っておく)
        // 送信ブロックの登録はページの読み込みより前に済ませる
        installTelemetryBlocker(into: config.userContentController) { [weak self] in
            self?.prepareURL {
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    DispatchQueue.main.async {
                        if !granted { print("camera access denied") }
                        self?.load()
                    }
                }
            }
        }

        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            self?.sendLidAngleIfChanged()
        }

        if startFullscreen { window.toggleFullScreen(nil) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: - 利用ログ送信のブロック

    /// MediaPipe (tasks-vision) は利用状況の統計 (タスクの種類、処理時間、実行回数など) を
    /// 60 秒ごとに odml.pa.googleapis.com へ送る。止めるオプションがないので、WebView 側で通信を遮断する。
    /// MediaPipe は送信に失敗すると以後の送信をやめる。
    private static let blockedHosts = ["odml.pa.googleapis.com"]

    private func installTelemetryBlocker(into controller: WKUserContentController, _ done: @escaping () -> Void) {        let rules = Self.blockedHosts.map { host in
            [
                "trigger": ["url-filter": "^https?://" + NSRegularExpression.escapedPattern(for: host) + "[:/]"],
                "action": ["type": "block"],
            ]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: rules),
              let json = String(data: data, encoding: .utf8)
        else { return done() }
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "telemetry-blocker",
            encodedContentRuleList: json
        ) { list, error in
            DispatchQueue.main.async {
                if let list {
                    controller.add(list)
                    print("telemetry blocker: \(Self.blockedHosts.joined(separator: ", "))")
                } else {
                    print("telemetry blocker failed: \(error.map { "\($0)" } ?? "unknown")")
                }
                done()
            }
        }
    }

    // MARK: - 読み込み

    /// URL が指定されていなければ、同梱の Web 版 (Resources/web, Resources/ply-data) を内蔵サーバーで配信する。
    private func prepareURL(_ done: @escaping () -> Void) {
        let done = { [weak self] in
            // --path で最初に開くページを指定できる
            if let self, let p = self.startPath, let u = self.url,
               var c = URLComponents(url: u, resolvingAgainstBaseURL: false)
            {
                c.path = p
                self.url = c.url
            }
            done()
        }
        if url != nil { return done() }
        let res = Bundle.main.resourceURL!
        let web = res.appendingPathComponent("web")
        guard FileManager.default.fileExists(atPath: web.appendingPathComponent("index.html").path) else {
            print("bundled web not found; falling back to the dev server")
            url = URL(string: "http://localhost:5173/")
            return done()
        }
        do {
            let s = try LocalServer(webRoot: web, plyRoot: plyDirectory)
            server = s
            s.start { [weak self] result in
                switch result {
                case let .success(port):
                    print("serving bundled web at http://127.0.0.1:\(port)/")
                    self?.url = URL(string: "http://127.0.0.1:\(port)/")
                case let .failure(err):
                    print("local server failed: \(err); falling back to the dev server")
                    self?.url = URL(string: "http://localhost:5173/")
                }
                done()
            }
        } catch {
            print("local server failed: \(error); falling back to the dev server")
            url = URL(string: "http://localhost:5173/")
            done()
        }
    }

    private func load() {
        pageReady = false
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        var items = (comps.queryItems ?? []).filter { !["lid", "displayW", "displayH"].contains($0.name) }
        if let a = sensor.read() {
            items.append(URLQueryItem(name: "lid", value: String(format: "%.1f", a)))
        }
        if let mm = window.screen?.physicalSizeMm {
            items.append(URLQueryItem(name: "displayW", value: String(format: "%.2f", mm.width)))
            items.append(URLQueryItem(name: "displayH", value: String(format: "%.2f", mm.height)))
        }
        comps.queryItems = items.isEmpty ? nil : items
        print("loading \(comps.url!.absoluteString)")
        webView.load(URLRequest(url: comps.url!))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        sendAll()
        // 起動確認用: 少し待ってから Web 側の HUD の内容をログに出す
        for delay in [4.0, 10.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self else { return }
                let visible = self.window.occlusionState.contains(.visible)
                self.webView.evaluateJavaScript("document.getElementById('hud')?.textContent") { v, _ in
                    print("--- web HUD (+\(Int(delay))s, window visible: \(visible)) ---\n\(v as? String ?? "")")
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // 開発サーバーが起動していない場合など。案内を出して 2 秒後に再試行する。
        let html = """
        <body style="background:#111;color:#ddd;font:15px -apple-system;display:grid;place-items:center;height:100vh;margin:0">
        <div style="text-align:center"><p>\(url.absoluteString) に接続できません</p>
        <p style="opacity:.6">web/ で <code>npm run dev</code> を起動してください。自動で再接続します。</p></div></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.load() }
    }

    // MARK: - カメラ許可

    @available(macOS 12.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        // 指定した URL のオリジンにだけ、確認なしでカメラを許可する
        let sameOrigin = origin.host == url.host && origin.protocol == url.scheme
        decisionHandler(sameOrigin && type == .camera ? .grant : .prompt)
    }

    // MARK: - ファイル選択 (<input type="file">)

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // MARK: - Web への値の流し込み

    private func js(_ s: String) {
        webView.evaluateJavaScript(s) { _, err in
            if let err { print("js error: \(err)\n  in: \(s)") }
        }
    }

    /// 値は window.__native に書き込み、Web 側が毎フレーム読む。
    /// Web のモジュールがまだ実行されていなくても値が失われない。
    private func setNative(_ key: String, _ jsonValue: String) {
        js("(window.__native = window.__native || {}).\(key) = \(jsonValue)")
    }

    private func sendLidAngleIfChanged() {
        guard pageReady, let a = sensor.read(), a != lastSentAngle else { return }
        lastSentAngle = a
        setNative("lidAngle", "\(a)")
    }

    /// WKWebView の画面上の位置 (CSS px = pt, 画面左上原点) を渡す。
    private func sendViewport() {
        guard pageReady, let screen = window.screen else { return }
        let r = window.convertToScreen(webView.convert(webView.bounds, to: nil))
        let sf = screen.frame
        let left = r.minX - sf.minX
        let top = sf.maxY - r.maxY
        setNative("viewport", "{left:\(left),top:\(top),width:\(r.width),height:\(r.height)}")
        // ウィンドウが別の画面に移ったときのために、画面の物理サイズも毎回送る
        if let mm = screen.physicalSizeMm {
            setNative("display", "{widthMm:\(mm.width),heightMm:\(mm.height)}")
        }
    }

    private func sendAll() {
        lastSentAngle = nil
        sendViewport()
        sendLidAngleIfChanged()
    }

    func windowDidMove(_ notification: Notification) { sendViewport() }
    func windowDidResize(_ notification: Notification) { sendViewport() }
    func windowDidChangeScreen(_ notification: Notification) { sendViewport() }
    func windowDidEnterFullScreen(_ notification: Notification) { sendViewport() }
    func windowDidExitFullScreen(_ notification: Notification) { sendViewport() }

    // MARK: - Web からのメッセージ

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.body as? String {
        case "toggleFullscreen": window.toggleFullScreen(nil)
        case "ready": // Web 側の初期化が終わった (再読み込み時も届く)
            pageReady = true
            sendAll()
        case let s? where s.hasPrefix("jserror: "): print(s)
        default: break
        }
    }

    // MARK: - メニュー

    @objc private func reload(_ sender: Any?) { load() }

    /// 同じサーバーの別のページへ切り替える (アプリ起動中は open --args が効かないため)
    private func navigate(path: String) {
        guard let current = url, var c = URLComponents(url: current, resolvingAgainstBaseURL: false) else { return }
        c.path = path
        url = c.url!
        load()
    }

    // MARK: - PLY フォルダ (元モデルの規約上配布できるか未確認なので同梱せず、ユーザーが選ぶ)

    /// --ply-dir で指定したフォルダ、なければ前回選んだフォルダ
    private var plyDirectory: URL? {
        if let plyDirArg { return plyDirArg }
        guard let path = UserDefaults.standard.string(forKey: Self.plyDirKey) else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    @objc private func choosePlyFolder(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "PLY の連番ファイル (*.ply) が入ったフォルダを選んでください"
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let dir = panel.url, let self else { return }
            UserDefaults.standard.set(dir.path, forKey: Self.plyDirKey)
            print("ply folder: \(dir.path)")
            if let server = self.server {
                server.plyRoot = dir
                self.navigate(path: "/ply")
            }
        }
    }

    @objc private func showLicenses(_ sender: Any?) {
        guard let f = Bundle.main.resourceURL?.appendingPathComponent("web/THIRD_PARTY_LICENSES.txt"),
              FileManager.default.fileExists(atPath: f.path)
        else { return }
        NSWorkspace.shared.open(f)
    }

    @objc private func showVRM(_ sender: Any?) { navigate(path: "/") }
    @objc private func showPLY(_ sender: Any?) { navigate(path: "/ply") }

    private func makeMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Pseudo 3D Window", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let reload = NSMenuItem(title: "Reload", action: #selector(reload(_:)), keyEquivalent: "r")
        reload.target = self
        viewMenu.addItem(reload)
        viewMenu.addItem(.separator())
        for (title, action, key) in [
            ("VRM", #selector(showVRM(_:)), "1"),
            ("PLY アニメーション", #selector(showPLY(_:)), "2"),
        ] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.target = self
            viewMenu.addItem(item)
        }
        let plyFolder = NSMenuItem(title: "PLY フォルダを選択…", action: #selector(choosePlyFolder(_:)), keyEquivalent: "o")
        plyFolder.target = self
        viewMenu.addItem(plyFolder)
        viewMenu.addItem(.separator())
        let fs = NSMenuItem(title: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fs)
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let helpItem = NSMenuItem()
        let helpMenu = NSMenu(title: "Help")
        let licenses = NSMenuItem(title: "サードパーティのライセンス", action: #selector(showLicenses(_:)), keyEquivalent: "")
        licenses.target = self
        helpMenu.addItem(licenses)
        helpItem.submenu = helpMenu
        main.addItem(helpItem)

        return main
    }
}

extension NSScreen {
    var displayID: CGDirectDisplayID? {
        deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
    }

    /// 表示領域の物理サイズ (mm)。EDID 由来。取れなければ nil。
    var physicalSizeMm: CGSize? {
        guard let id = displayID else { return nil }
        let s = CGDisplayScreenSize(id)
        return s.width > 0 && s.height > 0 ? s : nil
    }

    /// 内蔵ディスプレイ
    static var builtIn: NSScreen? {
        screens.first { s in s.displayID.map { CGDisplayIsBuiltin($0) != 0 } ?? false }
    }
}
