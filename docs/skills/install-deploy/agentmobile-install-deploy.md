# agentmobile 安装与部署 Skill

## 目标

在一台新机器或现有主机上完成 agentmobile 的安装、构建、部署、服务重启、健康检查和失败回滚。

## 安装前检查

```bash
node --version
tmux -V
npm --version
systemctl --version || true
pm2 --version || true
```

- Node.js 需要 20+
- `tmux` 必须可用
- 默认使用 systemd，确认 `sudo -n true` 可通过
- 若 systemd 不可用，`setup.js` 可自动 fallback 到 PM2

## 安装步骤

```bash
git clone <repo> agentmobile
cd agentmobile
node scripts/setup.js
```

`setup.js` 的预期行为：

- 优先安装并启用 `agentmobile.service`
- 若 systemd 不可用，则自动 fallback 到 PM2
- 自动创建首个 `tmux` session

## 支持的 Agent CLI

至少安装你要使用的 CLI，并验证命令可从 shell 中直接找到：

```bash
claude --version
codex --version
trae-cli --version || trae --version
opencode --version
```

常见安装方式：

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
```

如果 CLI 安装在用户目录，确保其 bin 目录位于 `PATH` 中，例如：

```bash
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
```

## 部署流程

```bash
npm install
cd frontend && npm install && npm run build && cd ..
sudo systemctl restart agentmobile
```

如果当前机器是 PM2 fallback 部署，则改用：

```bash
pm2 restart agentmobile
```

## 健康检查

服务重启后必须验证：

```bash
systemctl status agentmobile --no-pager
ss -ltnp | grep ':5000'
curl -I http://127.0.0.1:5000/
```

预期结果：

- `agentmobile` 为 `active (running)`
- 5000 端口在监听
- 首页返回 `HTTP/1.1 200 OK`

## 失败回滚

如果服务重启后不可达，立即回滚到上一个可工作的代码版本，并再次重启服务。

最小回滚流程：

```bash
git log --oneline -n 5
git checkout <previous-good-commit>
cd frontend && npm run build && cd ..
sudo systemctl restart agentmobile
curl -I http://127.0.0.1:5000/
```

如果当前机器是 PM2 fallback 部署：

```bash
pm2 restart agentmobile
```

## 常见故障

### Claude / Codex / Trae / OpenCode 报 `command not found`

- 先确认 CLI 已安装
- 再确认 `command -v <cli>` 能返回绝对路径
- 若 shell 可用但服务不可用，优先检查 service 的 `PATH`

### `r / b / q` 无效

- 这些逻辑在 agent 启动脚本里实现
- 确认对应脚本已部署到最新版本

### 启动后页面打不开

- 看 `journalctl -u agentmobile -n 100 --no-pager`
- 检查 `frontend/dist` 是否已重新构建
