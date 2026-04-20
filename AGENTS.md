# AGENTS.md

## Deployment Constraints

- Deployments require a service restart: restart the **agentmobile** service after deploying code changes.
- After restart, verify the service is accessible. If the service becomes unreachable after deployment, **rollback** the deployed code to the previous version immediately.

## Skills

- Installation and deployment workflow: see [`docs/skills/install-deploy/agentmobile-install-deploy.md`](docs/skills/install-deploy/agentmobile-install-deploy.md)
