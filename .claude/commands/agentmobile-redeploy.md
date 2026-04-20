Rebuild frontend and restart agentmobile service.

```bash
cd frontend && npm run build && cd .. && sudo systemctl restart agentmobile
```