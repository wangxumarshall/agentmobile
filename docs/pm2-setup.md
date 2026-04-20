# PM2 配置与启动指南 (agentmobile)

## ecosystem.config.js 内容
```js
module.exports = {
  apps: [{
    name: 'agentmobile',
    script: './server.js',
    cwd: '/mnt/c/Users/libra/work/agentmobile',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production'  // 可选：生产环境
    },
    // 日志路径（默认 ~/.pm2/logs）
    error_file: './logs/agentmobile-error.log',
    out_file: './logs/agentmobile-out.log',
    log_file: './logs/agentmobile-combined.log',
    time: true  // 日志带时间戳
  }]
};
```

## 启动命令序列
```bash
# 1. 先停止并删除当前 agentmobile 进程（安全清理）
pm2 stop agentmobile
pm2 delete agentmobile

# 2. 创建 ecosystem.config.js（如果手动创建，复制上方内容）
# cat > ecosystem.config.js << 'EOF'  # (粘贴内容) EOF

# 3. 确保日志目录存在
mkdir -p logs

# 4. 用新配置启动（会自动 save + startup）
pm2 start ecosystem.config.js

# 5. 保存配置（pm2 重启系统时自动恢复）
pm2 save

# 6. 查看状态
pm2 status agentmobile

# 7. (可选) pm2 startup（系统开机自启 pm2）
pm2 startup
```

## 验证
- `pm2 env agentmobile | grep CLAUDE_CONFIG_DIR`：应为空（清理成功）。
- `pm2 logs agentmobile`：查看日志。
- **回滚**：`pm2 delete agentmobile && rm ecosystem.config.js pm2-setup.md logs/agentmobile*.log`。

**日期**：2026-04-05
