@echo off
setlocal

set "ROOT=%~dp0"
set "RESEARCH=%ROOT%market-research"

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found in PATH.
  pause
  exit /b 1
)

if not exist "%ROOT%package.json" (
  echo ERROR: Legacy dashboard package.json was not found.
  pause
  exit /b 1
)

if not exist "%RESEARCH%\package.json" (
  echo ERROR: Market Research project was not found.
  pause
  exit /b 1
)

if not exist "%RESEARCH%\backend\.venv\Scripts\python.exe" (
  echo ERROR: Market Research backend environment is missing.
  echo Run: cd /d "%RESEARCH%" ^&^& npm run setup:api
  pause
  exit /b 1
)

if not exist "%RESEARCH%\frontend\node_modules" (
  echo ERROR: Market Research frontend dependencies are missing.
  echo Run: cd /d "%RESEARCH%" ^&^& npm run setup:ui
  pause
  exit /b 1
)

echo Starting Legacy Market Dashboard on http://localhost:4177 ...
start "Legacy Market Dashboard" /D "%ROOT%" cmd /k npm start

echo Starting Market Research API on http://127.0.0.1:8000 ...
start "Market Research API" /D "%RESEARCH%" cmd /k npm run api:start

echo Starting Market Research UI on http://localhost:4200 ...
start "Market Research UI" /D "%RESEARCH%" cmd /k npm run ui:start

echo.
echo All services were launched in separate windows.
endlocal
