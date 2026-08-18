@echo off
REM ============================================================
REM  agentmobile 一键连接器 (Windows)
REM  双击运行: 自动建 SSH 隧道并打开浏览器访问本服务
REM  关闭本窗口 = 断开连接 (浏览器随之无法访问)
REM ============================================================
chcp 65001 >nul
setlocal

REM ---- 配置(按需修改) ----
set HOST=123.60.114.33
set SSHPORT=33455
set USER=sdc
set LOCAL_PORT=5000
set REMOTE_PORT=5000
set BROWSE_URL=http://127.0.0.1:%LOCAL_PORT%/

REM ---- 检查 ssh 是否可用 ----
where ssh >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 ssh。Windows 10/11 应自带 OpenSSH，
  echo        设置 - 应用 - 可选功能 - 添加 "OpenSSH 客户端" 后重试。
  pause
  exit /b 1
)

echo ============================================================
echo  agentmobile 一键连接
echo  服务器: %HOST%:%SSHPORT% (用户 %USER%)
echo  浏览器将打开: %BROWSE_URL%
echo  保持此窗口开着 = 连接有效;关闭窗口 = 断开
echo ============================================================
echo.
echo 正在连接服务器(首次会提示输入密码)...

REM ---- 后台: 等隧道端口就绪后打开浏览器 ----
start "" cmd /c "for /L %%i in (1,1,30) do ( powershell -NoProfile -Command \"try{(Invoke-WebRequest -Uri %BROWSE_URL% -TimeoutSec 2 -UseBasicParsing).StatusCode|Out-Null; exit 0}catch{exit 1}\" && start \"\" %BROWSE_URL% && exit /b ) & timeout /t 1 >nul"

REM ---- 前台 SSH: 本地 %LOCAL_PORT% -> 服务器 %REMOTE_PORT% ----
ssh -N -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 ^
    -L %LOCAL_PORT%:127.0.0.1:%REMOTE_PORT% -p %SSHPORT% %USER%@%HOST%

echo.
echo 连接已断开。如需重连,再次双击本脚本。
pause
