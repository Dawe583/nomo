@echo off
setlocal
set "VOID_ROOT=%~dp0"
node "%VOID_ROOT%packages\cli\bin\void.mjs" %*
exit /b %ERRORLEVEL%
