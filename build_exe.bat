@echo off
chcp 65001 > nul
echo ========================================================
echo.
echo      南雲式WBSツール EXE化ビルドプログラム
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
echo サンプルデータ(dataフォルダ)をdistフォルダにコピーしています...
xcopy data dist\data /E /I /Y > nul

echo.
echo ========================================================
echo.
echo ビルドが完了しました！
echo 「dist」フォルダの中に「NagumoGantt.exe」と「data（サンプル同梱）」が作成されています。
echo 会社やGitHubでの配布時は、この「dist」フォルダをそのまま丸ごとZIPで固めて配布するだけで、サンプルプロジェクトが入った状態で即座に動きます！
echo.
pause
