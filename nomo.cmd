@echo off
setlocal
set "NOMO_ROOT=%~dp0"
node "%NOMO_ROOT%packages\cli\bin\nomo.mjs" %*
exit /b %ERRORLEVEL%