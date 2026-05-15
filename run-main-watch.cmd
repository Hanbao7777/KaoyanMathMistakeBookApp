@echo off
set "PATH=C:\Program Files\nodejs;%~dp0node_modules\.bin;%PATH%"
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" "%~dp0node_modules\typescript\bin\tsc" -p tsconfig.main.json --watch
