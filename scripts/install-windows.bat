@echo off
rem One-click install for dsh-today-llm on Windows.
rem
rem Double-click this file. It locates the DeepSeek Harness CLI next to either a
rem per-user or a machine-wide install, then installs the .tgz sitting beside
rem this script into the `desktop` profile.
rem
rem Everything is resolved at run time so the same file works for both install
rem locations and for a different profile name.

setlocal EnableDelayedExpansion
title Install dsh-today-llm

echo.
echo   dsh-today-llm installer
echo   ----------------------
echo.

set "HERE=%~dp0"

rem --- find the package to install -------------------------------------------
set "PKG="
for %%F in ("%HERE%dsh-today-llm-*.tgz") do (
  if exist "%%~fF" set "PKG=%%~fF"
)
if not defined PKG (
  echo   [X] No dsh-today-llm-*.tgz found next to this script.
  echo       Put the .tgz from the GitHub release in the same folder.
  echo.
  pause
  exit /b 1
)
echo   Package: %PKG%

rem --- find the DeepSeek Harness CLI -----------------------------------------
rem The CLI ships inside the app as resources\runtime\cli\bin\dsh.cmd.
set "DSH_CLI="
for %%R in (
  "%LOCALAPPDATA%\Programs\DeepSeek Harness"
  "%ProgramFiles%\DeepSeek Harness"
  "%ProgramFiles(x86)%\DeepSeek Harness"
) do (
  if not defined DSH_CLI if exist "%%~R\resources\runtime\cli\bin\dsh.cmd" (
    set "DSH_CLI=%%~R\resources\runtime\cli\bin\dsh.cmd"
  )
)
if not defined DSH_CLI (
  echo   [X] DeepSeek Harness not found in the usual install locations.
  echo       Install it first, or run this command yourself:
  echo         dsh plugin --profile desktop add "%PKG%"
  echo.
  pause
  exit /b 1
)
echo   Harness: !DSH_CLI!

rem --- install ---------------------------------------------------------------
echo.
echo   Installing into the "desktop" profile...
echo.
call "!DSH_CLI!" plugin --profile desktop add "%PKG%"
set "CODE=%errorlevel%"

echo.
if "%CODE%"=="0" (
  echo   [OK] Installed.
  echo        Restart DeepSeek Harness, then open Settings - Today.
) else (
  echo   [X] Install failed with exit code %CODE%.
  echo       Copy the output above into a GitHub issue.
)
echo.
pause
exit /b %CODE%
