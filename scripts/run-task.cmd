@echo off
rem 计划任务入口：由 scripts/task.mjs 注册的 ip-auto-daily 调用
rem 注意：最后一行不要写成 `endlocal & exit /b %RC%`。批处理会把整行当成一条命令
rem 先展开变量再执行，%RC% 展开时机与 endlocal 的先后关系容易踩坑，曾导致返回码恒为 0，
rem 任务失败也显示成功。这里直接 exit /b，让 cmd 自己结束 setlocal 作用域。
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo. >> "logs\task.log"
echo ===== %date% %time% start ===== >> "logs\task.log"
"C:\Program Files\nodejs\node.exe" "C:\Users\J1053\Documents\ip-auto\src\run.mjs" >> "logs\task.log" 2>&1
set RC=%ERRORLEVEL%
echo ===== %date% %time% end rc=%RC% ===== >> "logs\task.log"
exit /b %RC%
