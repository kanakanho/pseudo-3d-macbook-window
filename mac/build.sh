#!/bin/bash
# Web 版をビルドし、Swift のラッパーと一緒に .app バンドルにまとめる。
#   - カメラ許可 (TCC) には Info.plist 付きのバンドルが必要なので、素の実行ファイルではなく .app にする
#   - web/dist を Contents/Resources/web に同梱する
#   - PLY データは元モデルの規約上配布できるか確認できていないので同梱しない (フォルダのドロップか View → PLY フォルダを選択… で読み込む)
#
# 環境変数:
#   VERSION=1.2.3  アプリのバージョン (CFBundleShortVersionString / CFBundleVersion)。署名の前に書き込む
#   UNIVERSAL=1    Apple Silicon と Intel の両方で動くバイナリにする
set -euo pipefail
cd "$(dirname "$0")"
WEB=../web

echo "==> web build"
npm --prefix "$WEB" run build

echo "==> swift build"
SWIFT_ARGS=(-c release)
if [[ "${UNIVERSAL:-0}" == 1 ]]; then SWIFT_ARGS+=(--arch arm64 --arch x86_64); fi
swift build "${SWIFT_ARGS[@]}"
BIN="$(swift build "${SWIFT_ARGS[@]}" --show-bin-path)/Pseudo3DWindow"
APP="build/Pseudo3DWindow.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/"
cp Resources/Info.plist "$APP/Contents/"
cp -R "$WEB/dist" "$APP/Contents/Resources/web"

if [[ -n "${VERSION:-}" ]]; then
  echo "==> version $VERSION"
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$APP/Contents/Info.plist"
fi

# PLY が紛れ込んでいたら失敗させる (元モデルの規約上の扱いは README 参照)
if [[ -n "$(find "$APP" -iname '*.ply' -print -quit)" ]]; then
  echo "error: .ply files must not be bundled" >&2
  exit 1
fi

echo "==> codesign"
codesign --force --sign - "$APP"

echo "built: $(pwd)/$APP ($(lipo -archs "$APP/Contents/MacOS/Pseudo3DWindow"))"
