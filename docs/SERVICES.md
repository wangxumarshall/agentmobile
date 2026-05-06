# SERVICES — agentmobile 服务操作手册

**Last Updated**: 2026-05-06  **锚点**: `docs/NORTH-STAR.md`

本文是服务拉取、部署、重启、日志、验证的唯一长期入口。其它文档和脚本应引用这里，避免把持久 tmux runtime 当成普通 Web 服务重启。

---

## 服务边界

systemd 部署下有三个服务：

| Service | 职责 | 普通拉代码后是否重启 |
|---|---|---|
| `agentmobile.service` | Web / API / WebSocket / node-pty bridge | 是，Web 或前端代码变更后重启 |
| `agentmobile-tmux.service` | 持久 tmux server 和正在运行的 Agent 进程 | 否，只在受控维护窗口重启 |
| `agentmobile-im.service` | Telegram / Feishu / Lark IM bridge | 仅 IM 代码或 IM 配置变更后重启 |

PM2 fallback 只管理 `agentmobile` 单进程，适用于 systemd 不可用的环境。生产和 WSL2 宿主机优先使用 systemd 双运行域。

---

## 推荐入口

优先使用仓库内的统一脚本：

```bash
npm run service:help
npm run service:status
npm run service:verify
npm run service:logs
```

对应脚本是 `scripts/service-control.sh`。它会自动识别 systemd 或 PM2 fallback，并且默认拒绝重启 `agentmobile-tmux.service`。

---

## 普通拉代码部署

### 只更新 Web / API / 前端

这是最常见路径，会拉代码、安装依赖、构建前端，只重启 `agentmobile.service`，不会碰 tmux runtime：

```bash
npm run service:pull:web
```

等价手动流程：

```bash
git pull --ff-only
npm install
cd frontend && npm install && npm run build && cd ..
sudo systemctl restart agentmobile
npm run service:verify
```

PM2 fallback：

```bash
git pull --ff-only
npm install
cd frontend && npm install && npm run build && cd ..
pm2 restart agentmobile
curl -I http://127.0.0.1:${PORT:-5000}/
```

### 同时更新 Web 和 IM bridge

```bash
npm run service:pull:all
```

这会构建前端、执行 `npm run build:im`，然后重启 Web 和已托管的 IM bridge。它仍然不会重启 `agentmobile-tmux.service`。

---

## 单服务操作

| 操作 | 推荐命令 |
|---|---|
| 查看所有服务状态 | `npm run service:status` |
| 追踪日志 | `npm run service:logs` |
| 验证 Web 可达和 runtime 存活 | `npm run service:verify` |
| 部署 Web 但不拉代码 | `npm run service:deploy:web` |
| 仅重启 Web | `npm run service:restart:web` |
| 部署并重启 IM bridge | `npm run service:deploy:im` |
| 仅重启 IM bridge | `npm run service:restart:im` |
| 安装/刷新 systemd unit 文件 | `npm run service:install-units` |
| 迁移旧安装的 tmux/Agent cgroup | `npm run service:migrate-tmux` |

`npm run service:restart:tmux` 会拒绝执行。确实需要维护 tmux runtime 时，直接运行：

```bash
scripts/service-control.sh restart-tmux --force
```

执行前要确认可以中断或恢复当前 tmux/Agent 进程。

---

## 更新 systemd unit

修改了 `agentmobile.service`、`agentmobile-tmux.service`、`agentmobile-im.service` 或 `agentmobile-5001.service` 后：

```bash
npm run service:install-units
```

然后只重启受影响的服务：

```bash
npm run service:restart:web      # Web unit 或 server.js 相关
npm run service:restart:im       # IM unit 或 im/ 相关
```

不要把 `agentmobile-tmux.service` 放入普通发布流程。只有 runtime unit、tmux keepalive 脚本或 cgroup 迁移逻辑变更时，才在维护窗口处理它。

---

## 旧安装迁移到双运行域

如果 `systemd-cgls /system.slice/agentmobile.service` 里能看到真实 `tmux` server、Claude、Codex 等长期进程，先迁移，再重启 Web：

```bash
npm run service:install-units
sudo systemctl enable --now agentmobile-tmux
npm run service:migrate-tmux
npm run service:restart:web
```

迁移脚本会把当前 tmux server 和 pane 进程树移动到 `agentmobile-tmux.service` 的 cgroup。验证通过后，普通 Web 重启只会清理短生命周期的 `tmux attach-session` 客户端。

---

## 回滚

如果普通发布后 Web 不可达，立即回滚代码并只重启 Web：

```bash
git log --oneline -n 5
git checkout <previous-good-commit>
npm install
cd frontend && npm install && npm run build && cd ..
npm run service:restart:web
```

如果故障来自 IM bridge：

```bash
git checkout <previous-good-commit>
npm install
npm run build:im
npm run service:restart:im
```

不要通过重启 `agentmobile-tmux.service` 来修复 Web 发布故障；那会触碰持久会话运行域。

---

## 健康检查

systemd：

```bash
systemctl is-active agentmobile
systemctl is-active agentmobile-tmux
curl -I http://127.0.0.1:${PORT:-5000}/
```

可选 IM bridge：

```bash
systemctl is-active agentmobile-im
```

PM2 fallback：

```bash
pm2 status agentmobile
curl -I http://127.0.0.1:${PORT:-5000}/
```

预期：

- Web 返回 `HTTP/1.1 200 OK`
- `agentmobile.service` active
- `agentmobile-tmux.service` active
- `agentmobile.service` cgroup 内只应有 Node 和短生命周期 `tmux attach-session`
- 真实 tmux server、Claude、Codex 等长期进程在 `agentmobile-tmux.service` cgroup 内
