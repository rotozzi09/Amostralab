import Cocoa
import WebKit
import UniformTypeIdentifiers

final class WebUIURLSchemeHandler: NSObject, WKURLSchemeHandler {
    private let webRootURL: URL

    init(webRootURL: URL) {
        self.webRootURL = webRootURL
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: "WorkestraPiano", code: 404))
            return
        }

        var relPath = url.path
        if relPath.isEmpty || relPath == "/" {
            relPath = "/index.html"
        }
        if relPath.hasPrefix("/") {
            relPath.removeFirst()
        }

        // Prevent path traversal
        let cleanComponents = (relPath as NSString).pathComponents.filter { $0 != ".." && $0 != "." && $0 != "/" }
        let fileURL = cleanComponents.reduce(webRootURL) { $0.appendingPathComponent($1) }

        guard let data = try? Data(contentsOf: fileURL) else {
            let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(Data("Not Found".utf8))
            urlSchemeTask.didFinish()
            return
        }

        let ext = fileURL.pathExtension.lowercased()
        let mime: String
        switch ext {
        case "html": mime = "text/html; charset=utf-8"
        case "css": mime = "text/css; charset=utf-8"
        case "js", "mjs": mime = "text/javascript; charset=utf-8"
        case "json": mime = "application/json; charset=utf-8"
        case "wasm": mime = "application/wasm"
        case "png": mime = "image/png"
        case "jpg", "jpeg": mime = "image/jpeg"
        case "svg": mime = "image/svg+xml"
        case "wav": mime = "audio/wav"
        default: mime = "application/octet-stream"
        }

        let headers: [String: String] = [
            "Content-Type": mime,
            "Content-Length": "\(data.count)",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*"
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Synchronous local bundle reads finish immediately
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var engine: AudioMidiEngine!
    private var schemeHandler: WebUIURLSchemeHandler!
    private let backgroundQueue = DispatchQueue(label: "com.amostralab.workestrapiano.io", qos: .userInitiated)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        setupMainMenu()

        let webRoot = Bundle.main.resourceURL?.appendingPathComponent("WebUI", isDirectory: true)
            ?? Bundle.main.bundleURL
        self.schemeHandler = WebUIURLSchemeHandler(webRootURL: webRoot)

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: "app")
        config.userContentController.add(self, name: "workestraNative")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let contentRect = NSRect(x: 0, y: 0, width: 1460, height: 860)
        window = NSWindow(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "WorkestraPiano — Native CoreAudio"
        window.minSize = NSSize(width: 1024, height: 600)
        window.backgroundColor = NSColor(calibratedRed: 0.08, green: 0.08, blue: 0.09, alpha: 1.0)
        window.center()

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView?.addSubview(webView)

        self.engine = AudioMidiEngine { [weak self] type, payload in
            self?.sendNativeEvent(type: type, payload: payload)
        }

        if let url = URL(string: "app://localhost/index.html") {
            webView.load(URLRequest(url: url))
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu

        appMenu.addItem(NSMenuItem(title: "Abrir Pasta de Sons (~/Music/WorkestraPiano)", action: #selector(openSoundsFolder), keyEquivalent: "o"))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Recarregar Painel", action: #selector(reloadPanel), keyEquivalent: "r"))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Sair do WorkestraPiano", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        let windowItem = NSMenuItem()
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "Janela")
        windowItem.submenu = windowMenu
        windowMenu.addItem(NSMenuItem(title: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "Tela Cheia", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f"))

        NSApp.mainMenu = mainMenu
    }

    @objc private func openSoundsFolder() {
        NSWorkspace.shared.open(engine.soundsRootURL)
    }

    @objc private func reloadPanel() {
        webView.reload()
    }

    // MARK: - Native <-> JS Bridge

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else {
            return
        }
        let payload = body["payload"] as? [String: Any] ?? [:]

        if let reqId = (body["reqId"] as? NSNumber)?.intValue {
            if type == "pickSoundFiles" {
                handlePickSoundFiles(reqId: reqId, module: payload["module"] as? String ?? "piano")
                return
            }
            if type == "pickPadAudioFile" {
                handlePickPadAudioFile(reqId: reqId)
                return
            }
            if type == "pickPadTimbreFile" {
                handlePickPadTimbreFile(reqId: reqId)
                return
            }
            if type == "openAudioMidiSetup" {
                let appURL = URL(fileURLWithPath: "/System/Applications/Utilities/Audio MIDI Setup.app")
                if FileManager.default.fileExists(atPath: appURL.path) {
                    NSWorkspace.shared.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
                    resolveRequest(reqId: reqId, ok: true, data: ["opened": true], error: nil)
                } else {
                    let legacyURL = URL(fileURLWithPath: "/Applications/Utilities/Audio MIDI Setup.app")
                    if FileManager.default.fileExists(atPath: legacyURL.path) {
                        NSWorkspace.shared.openApplication(at: legacyURL, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
                        resolveRequest(reqId: reqId, ok: true, data: ["opened": true], error: nil)
                    } else {
                        resolveRequest(reqId: reqId, ok: true, data: ["opened": false], error: nil)
                    }
                }
                return
            }
            if type == "copyToClipboard" {
                let text = payload["text"] as? String ?? ""
                NSPasteboard.general.clearContents()
                let ok = NSPasteboard.general.setString(text, forType: .string)
                resolveRequest(reqId: reqId, ok: true, data: ["copied": ok], error: nil)
                return
            }
            backgroundQueue.async {
                do {
                    let result = try self.engine.handleRequest(type: type, payload: payload)
                    DispatchQueue.main.async {
                        self.resolveRequest(reqId: reqId, ok: true, data: result, error: nil)
                    }
                } catch {
                    DispatchQueue.main.async {
                        self.resolveRequest(reqId: reqId, ok: false, data: nil, error: error.localizedDescription)
                    }
                }
            }
        } else {
            engine.handleFireAndForget(type: type, payload: payload)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        engine.emitCurrentStatesToWebUI()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("WorkestraPiano WebView didFail navigation: %@", error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("WorkestraPiano WebView didFailProvisionalNavigation: %@", error.localizedDescription)
    }

    private func handlePickSoundFiles(reqId: Int, module: String) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.title = "Selecionar timbres para \(module.capitalized)"
        let exts = ["sf2", "npno", "nsmp", "nsmp3", "nsmp4", "svz", "wav"]
        panel.allowedContentTypes = exts.compactMap { UTType(filenameExtension: $0) }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK else {
                self.resolveRequest(reqId: reqId, ok: true, data: [], error: nil)
                return
            }
            let files: [[String: Any]] = panel.urls.map { url in
                let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
                let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
                return [
                    "name": url.lastPathComponent,
                    "size": size,
                    "path": url.path
                ]
            }
            self.resolveRequest(reqId: reqId, ok: true, data: files, error: nil)
        }
    }

    private func handlePickPadAudioFile(reqId: Int) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.title = "Selecionar amostra de áudio para o Pad"
        let exts = ["wav", "aif", "aiff", "mp3", "m4a", "aac", "flac", "caf"]
        panel.allowedContentTypes = exts.compactMap { UTType(filenameExtension: $0) }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else {
                self.resolveRequest(reqId: reqId, ok: true, data: nil, error: nil)
                return
            }
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
            let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
            self.resolveRequest(reqId: reqId, ok: true, data: [
                "name": url.lastPathComponent,
                "size": size,
                "path": url.path
            ], error: nil)
        }
    }

    private func handlePickPadTimbreFile(reqId: Int) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.title = "Selecionar timbre para os Pads"
        let exts = ["sf2", "npno", "nsmp", "nsmp3", "nsmp4", "svz", "wav", "aif", "aiff", "mp3", "m4a", "aac", "flac", "caf"]
        panel.allowedContentTypes = exts.compactMap { UTType(filenameExtension: $0) }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else {
                self.resolveRequest(reqId: reqId, ok: true, data: nil, error: nil)
                return
            }
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
            let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
            self.resolveRequest(reqId: reqId, ok: true, data: [
                "name": url.lastPathComponent,
                "size": size,
                "path": url.path
            ], error: nil)
        }
    }

    private func resolveRequest(reqId: Int, ok: Bool, data: Any?, error: String?) {
        let dataJSON: String
        if let data = data,
           let raw = try? JSONSerialization.data(withJSONObject: data, options: []),
           let str = String(data: raw, encoding: .utf8) {
            dataJSON = str
        } else {
            dataJSON = "null"
        }

        let errJSON: String
        if let error = error,
           let raw = try? JSONSerialization.data(withJSONObject: [error], options: []),
           let str = String(data: raw, encoding: .utf8),
           str.count >= 2 {
            errJSON = String(str.dropFirst().dropLast())
        } else {
            errJSON = "null"
        }

        let js = "window.__workestraNativeResolve && window.__workestraNativeResolve(\(reqId), \(ok ? "true" : "false"), \(dataJSON), \(errJSON));"
        if Thread.isMainThread {
            webView.evaluateJavaScript(js, completionHandler: nil)
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.webView?.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }

    private func sendNativeEvent(type: String, payload: [String: Any]) {
        guard let rawType = try? JSONSerialization.data(withJSONObject: [type], options: []),
              let typeArrStr = String(data: rawType, encoding: .utf8),
              typeArrStr.count >= 2,
              let rawData = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let dataStr = String(data: rawData, encoding: .utf8) else {
            return
        }
        let typeLiteral = String(typeArrStr.dropFirst().dropLast())
        let js = "window.__workestraNativeEvent && window.__workestraNativeEvent(\(typeLiteral), \(dataStr));"
        if Thread.isMainThread {
            webView.evaluateJavaScript(js, completionHandler: nil)
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.webView?.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }
}
