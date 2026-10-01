@echo off
echo =======================================================
echo   MarkdownX MathJax 离线资源一键本地化下载脚本
echo =======================================================
echo.
set TARGET_DIR=%~dp0..\public\mathjax
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

echo [1/2] 正在下载矢量 SVG 引擎 (tex-svg.js)...
powershell -Command "Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js' -OutFile '%TARGET_DIR%\tex-svg.js' -UseBasicParsing"

echo [2/2] 正在下载高速 CHTML 引擎 (tex-chtml.js)...
powershell -Command "Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js' -OutFile '%TARGET_DIR%\tex-chtml.js' -UseBasicParsing"

echo.
echo =======================================================
echo   下载完成！MathJax 离线文件已保存在 public\mathjax
echo   现在您可以断网执行 pnpm tauri build 进行 100%% 纯离线打包！
echo =======================================================
pause
