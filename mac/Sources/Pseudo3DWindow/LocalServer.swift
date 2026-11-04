import Foundation
import Network

/// アプリに同梱した Web 版を配信する、127.0.0.1 だけで待ち受ける最小の HTTP サーバー。
///
/// 独自 URL スキーム (WKURLSchemeHandler) ではなく HTTP にしているのは、
/// getUserMedia (カメラ) が安全なコンテキストでしか使えず、http://127.0.0.1 はそれに該当するため。
final class LocalServer {
    private let listener: NWListener
    private let webRoot: URL
    private let lock = NSLock()
    private var _plyRoot: URL?
    /// PLY の連番が入ったフォルダ。元モデルの規約上配布できるか確認できていないのでアプリには同梱せず、ユーザーが選んだ場所から配信する。
    var plyRoot: URL? {
        get { lock.withLock { _plyRoot } }
        set { lock.withLock { _plyRoot = newValue?.standardizedFileURL } }
    }
    static let plyFps = 15
    private let queue = DispatchQueue(label: "LocalServer", attributes: .concurrent)

    init(webRoot: URL, plyRoot: URL?) throws {
        self.webRoot = webRoot.standardizedFileURL
        _plyRoot = plyRoot?.standardizedFileURL
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any) // 外部からは接続できない
        listener = try NWListener(using: params)
    }

    /// 待ち受けを開始し、使えるようになったらポート番号を返す。
    func start(_ ready: @escaping (Result<UInt16, Error>) -> Void) {
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let port = self?.listener.port?.rawValue { DispatchQueue.main.async { ready(.success(port)) } }
            case let .failed(err):
                DispatchQueue.main.async { ready(.failure(err)) }
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            conn.start(queue: self.queue)
            self.receive(conn, buffer: Data())
        }
        listener.start(queue: queue)
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                self.handle(conn, head: String(decoding: buf[..<end.lowerBound], as: UTF8.self))
            } else if isComplete || error != nil || buf.count > 64 * 1024 {
                conn.cancel()
            } else {
                self.receive(conn, buffer: buf)
            }
        }
    }

    private func handle(_ conn: NWConnection, head: String) {
        let parts = head.split(separator: "\r\n", maxSplits: 1).first?.split(separator: " ") ?? []
        guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else {
            return respond(conn, status: "405 Method Not Allowed")
        }
        let rawPath = String(parts[1]).split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
        if rawPath == "/ply-data/index.json" {
            // フレーム一覧はその場で作る (データフォルダに何も足さなくて済むように)
            guard let index = frameIndex() else { return respond(conn, status: "404 Not Found") }
            return respond(conn, status: "200 OK", type: "application/json", body: index, length: index.count)
        }
        guard let path = rawPath.removingPercentEncoding, let file = resolve(path) else {
            return respond(conn, status: "404 Not Found")
        }
        guard let body = try? Data(contentsOf: file, options: .alwaysMapped) else {
            return respond(conn, status: "500 Internal Server Error")
        }
        respond(conn, status: "200 OK", type: Self.mimeType(file.pathExtension), body: parts[0] == "HEAD" ? nil : body,
                length: body.count)
    }

    private func frameIndex() -> Data? {
        guard let root = plyRoot,
              let names = try? FileManager.default.contentsOfDirectory(atPath: root.path)
        else { return nil }
        let frames = names.filter { $0.lowercased().hasSuffix(".ply") }.sorted()
        guard !frames.isEmpty else { return nil }
        return try? JSONSerialization.data(withJSONObject: ["fps": Self.plyFps, "frames": frames])
    }

    /// URL のパスを同梱ファイルに対応づける。ルートの外を指すものや存在しないものは nil。
    private func resolve(_ path: String) -> URL? {
        let prefix = "/ply-data/"
        let (root, rel): (URL, String)
        if path.hasPrefix(prefix) {
            guard let plyRoot else { return nil }
            (root, rel) = (plyRoot, String(path.dropFirst(prefix.count)))
        } else {
            (root, rel) = (webRoot, String(path.dropFirst()))
        }
        let file = root.appendingPathComponent(rel).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/") || file.path == root.path else { return nil }

        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue { return file }
        // /ply のような拡張子のないパスはページなので index.html を返す (SPA のフォールバック)
        if root == webRoot, (isDir.boolValue || file.pathExtension.isEmpty) {
            return webRoot.appendingPathComponent("index.html")
        }
        return nil
    }

    private func respond(_ conn: NWConnection, status: String, type: String = "text/plain", body: Data? = nil,
                         length: Int = 0)
    {
        let header = """
        HTTP/1.1 \(status)\r
        Content-Type: \(type)\r
        Content-Length: \(length)\r
        Cache-Control: no-cache\r
        Connection: close\r
        \r

        """
        conn.send(content: Data(header.utf8), completion: .idempotent)
        conn.send(content: body, contentContext: .defaultMessage, isComplete: true, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    private static func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "wasm": return "application/wasm" // WebAssembly.instantiateStreaming に必要
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        default: return "application/octet-stream"
        }
    }
}
