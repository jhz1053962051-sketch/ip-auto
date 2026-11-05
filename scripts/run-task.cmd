@echo off
rem 计划任务入口：由 scripts/task.mjs 注册的 ip-auto-daily 调用
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo. >> "logs\task.log"
echo ===== %date% %time% start ===== >> "logs\task.log"
"C:\Program Files\nodejs\node.exe" "C:\Users\J1053\Documents\ip-auto\src\run.mjs" >> "logs\task.log" 2>&1
set RC=%ERRORLEVEL%
echo ===== %date% %time% end rc=%RC% ===== >> "logs\task.log"
endlocal & exit /b %RC%
