@echo off
rem 计划任务入口：由 scripts/task.mjs 注册的 ip-auto-daily 调用
rem 三条硬规矩：
rem   1) 先清空代理环境变量 —— 探测必须直连，走 7897 会让 pages.dev 握手失败
rem   2) 不能写 "endlocal & exit /b %RC%" —— 复合行里 %RC% 会在解析期展开，返回码恒 0
rem   3) 副线（直连节点、发布）失败不许影响主线的返回码
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
set "https_proxy="
set "http_proxy="
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "all_proxy="
echo. >> "logs\task.log"
echo ===== %date% %time% start ===== >> "logs\task.log"
"C:\Program Files\nodejs\node.exe" "C:\Users\J1053\Documents\ip-auto\src\run.mjs" >> "logs\task.log" 2>&1
set RC=%ERRORLEVEL%
echo ===== collect end rc=%RC% ===== >> "logs\task.log"
rem 副线一：直连节点（公共代理池波动大，失败保留上一轮产物）
"C:\Program Files\nodejs\node.exe" "C:\Users\J1053\Documents\ip-auto\scripts\make-direct-sub.mjs" --max 300 --max-ms 2500 >> "logs\task.log" 2>&1
echo ===== direct end rc=%ERRORLEVEL% ===== >> "logs\task.log"
rem 副线二：把带 real_ms 的本机产物推上去（CI 测不出真实延迟）
"C:\Program Files\nodejs\node.exe" "C:\Users\J1053\Documents\ip-auto\scripts\publish.mjs" >> "logs\task.log" 2>&1
echo ===== publish end rc=%ERRORLEVEL% ===== >> "logs\task.log"
echo ===== %date% %time% end rc=%RC% ===== >> "logs\task.log"
exit /b %RC%
