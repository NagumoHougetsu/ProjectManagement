@echo off
chcp 65001 > nul
echo ========================================================
echo.
echo      次世代アートWBSツール EXE化ビルドプログラム
echo.
echo   ※ この処理には数分かかる場合があります。
echo.
echo ========================================================
echo.

echo PyInstallerをインストールしています...
pip install pyinstaller

echo.
echo ビルドを開始します...
pyinstaller --noconfirm --onefile --windowed --name "NagumoGantt" --add-data "templates;templates" --add-data "static;static" app.py

echo.
echo ========================================================
echo.
echo ビルドが完了しました！
echo 「dist」フォルダの中に「NagumoGantt.exe」が作成されています。
echo 会社での検証時は、この「app.exe」と「data」フォルダを一緒にZIPで固めて持っていくと確実です。（※--add-dataで内包していますが、読み書きするCSVフォルダは外に出しておく方が運用上安全な場合があります）
echo.
pause
