@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js 20 or higher is required. Install it from https://nodejs.org and run this launcher again.
    pause
    exit /b 1
)

if not exist "node_modules\.bin\tsx.cmd" (
    rem better-sqlite3 ships a prebuilt win32-x64 binary; skip node-gyp, which needs a full C++ toolchain.
    echo Installing dependencies for the first run...
    call npm install --ignore-scripts
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

if not exist ".env" (
    if exist ".env.example" copy /y ".env.example" ".env" >nul
)

echo Starting NikoStory2 at http://127.0.0.1:3000
start "" http://127.0.0.1:3000
call npm start

echo.
echo The server stopped.
pause
