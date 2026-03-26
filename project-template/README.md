# Project Template

This folder is copied into `~/.coral/projects/<project-name>/` for each new pipeline-managed project.

Contents:
- `conf` — project-specific configuration
- `deploy.sh` — optional project-local deploy entrypoint
- `batch_scheduler.sh` — project-local Planning → Backlog scheduler
- `logs/` — runtime logs
- `pm_meta/` — local PM metadata store (used especially for Plane)
