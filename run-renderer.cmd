@echo off
set "PATH=C:\Program Files\nodejs;%~dp0node_modules\.bin;%PATH%"
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" "%~dp0node_modules\vite\bin\vite.js" --host 127.0.0.1 --configLoader native
