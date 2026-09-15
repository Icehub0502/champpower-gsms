@echo off
REM Copies the new agent definitions into .claude\agents\ and removes the old
REM .claude\CLAUDE.md so it does not conflict with the new root CLAUDE.md.
REM Run this from the repo root (double-click works).
cd /d "%~dp0"
if not exist ".claude\agents" mkdir ".claude\agents"
copy /Y "docs\agents\*.md" ".claude\agents\"
if exist ".claude\CLAUDE.md" del ".claude\CLAUDE.md"
echo.
echo Done. Agents installed and the old .claude\CLAUDE.md removed.
pause
