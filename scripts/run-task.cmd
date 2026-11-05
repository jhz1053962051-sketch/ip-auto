@echo off
rem 计划任务入口：由 scripts/task.mjs 注册的 ip-auto-daily 调用
rem 注意：最后一行不要写成 `endlocal & exit /b %RC%`。批处理会把整行当成一条命令
rem 先展开变量再执行，%RC% 展开时机与 endlocal 的先后关系容易踩坑，曾导致返回码恒为 0，
rem 任务失败也显示成功。这里直接 exit /b，让 cmd 自己结束 setlocal 作用域。
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"

rem 直连子线要直连公开代理，别被系统代理带偏（run.mjs 自己会经 7897 抓 VPN Gate，不受影响）
set "https_proxy="
set "http_proxy="
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "all_proxy="

echo. >> "logs\task.log"
echo ===== %date% %time% start ===== >> "logs\task.log"

rem 主线：VPN Gate 住宅节点 + 公共代理池 + Worker 复测 + 本机实测全链路 TTFB
"C:\Program Files\nodejs\node.exe" "C:\Users\J1053\Documents\ip-auto\src\run.mjs" >> "logs\task.log" 2>&1
set RC=%ERRORLEVEL%

rem 副线：直连节点（绕开 Cloudflare）。抓不到就保留上一轮产物，失败不影响主订阅，
rem 所以这里不覆盖 RC，只记一行日志。
"C:\Program Files\nodejs\node.exe" "C:\Users\J1053\Documents\ip-auto\scripts\make-direct-sub.mjs" --max 300 --max-ms 2500 >> "logs\task.log" 2>&1
echo ----- direct-sub rc=%ERRORLEVEL%（不影响主线返回码）----- >> "logs\task.log"

echo ===== %date% %time% end rc=%RC% ===== >> "logs\task.log"
exit /b %RC%
