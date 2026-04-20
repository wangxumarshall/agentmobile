#!/bin/bash
# agentmobile 启动脚本
# 在宿主机（WSL2）上直接运行: bash start.sh
# 或: PORT=5000 bash start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "错误: .env 文件不存在"
    echo "请复制 .env.example 并填写配置: cp .env.example .env"
    exit 1
fi

# 检查 node_modules
if [ ! -d node_modules ]; then
    echo "安装依赖..."
    npm install
fi

# 检查前端构建
if [ ! -d frontend/dist ]; then
    echo "构建前端..."
    cd frontend && npm install && npm run build && cd ..
fi

# 加载环境变量并启动
set -a
source .env
set +a

export PORT="${PORT:-5000}"

echo "启动 agentmobile on :$PORT ..."
exec node server.js
