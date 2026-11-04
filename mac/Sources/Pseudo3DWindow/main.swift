import AppKit

setvbuf(stdout, nil, _IOLBF, 0) // ファイルにリダイレクトしてもログが即座に出るように

// 使い方: Pseudo3DWindow [--dev | --url <url>] [--path /ply] [--fullscreen]
//   指定なし : アプリに同梱した Web 版を内蔵サーバーで開く
//   --dev    : Vite の開発サーバー (http://localhost:5173/) を開く
//   --url    : 任意の URL を開く
//   --path   : 最初に開くページ (/ = VRM, /ply = PLY アニメーション)
//   --ply-dir: PLY の連番が入ったフォルダ (未指定なら View → PLY フォルダを選択… で選んだもの)
var url: URL?
var startPath: String?
var plyDir: URL?
var fullscreen = false
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    switch a {
    case "--url":
        if let s = args.next(), let u = URL(string: s) { url = u }
    case "--ply-dir":
        if let s = args.next() { plyDir = URL(fileURLWithPath: (s as NSString).expandingTildeInPath, isDirectory: true) }
    case "--path":
        startPath = args.next() ?? "/"
    case "--dev":
        url = URL(string: "http://localhost:5173/")
    case "--fullscreen":
        fullscreen = true
    default:
        break
    }
}

let app = NSApplication.shared
let delegate = AppDelegate(url: url, startPath: startPath, plyDir: plyDir, startFullscreen: fullscreen)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
