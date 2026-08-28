# Week 6 To-Do — Application

Node.js / Express to-do application deployed to Amazon ECS on Fargate.

- **Writes** persist to an Aurora PostgreSQL cluster, always through **RDS Proxy**.
- **Reads** are served from **Amazon ElastiCache for Redis** using a cache-aside
  pattern, falling back to the database on a miss.

Infrastructure lives in a separate repository:
[`week-6-to-do-infra`](https://github.com/sarsahcodes/week-6-to-do-infra).

## API

| Method | Path                 | Behaviour                                                   |
|--------|----------------------|-------------------------------------------------------------|
| GET    | `/api/tasks`         | Cache-aside list read. Response includes `source` + `latencyMs`. |
| GET    | `/api/tasks/:id`     | Cache-aside single read.                                     |
| POST   | `/api/tasks`         | Insert via RDS Proxy, then invalidate the list cache.        |
| PUT    | `/api/tasks/:id`     | Update via RDS Proxy, then invalidate list + item cache.     |
| DELETE | `/api/tasks/:id`     | Delete via RDS Proxy, then invalidate list + item cache.     |
| POST   | `/api/cache/flush`   | Drop the list cache key (used to demo a cold read).          |
| GET    | `/api/stats`         | Hit/miss counters, hit rate, connection targets.             |
| GET    | `/health`            | Shallow check used by the ALB target group.                  |
| GET    | `/health/deep`       | Checks the database connection too.                          |

`GET /api/tasks` returns `source: "redis-cache"` on a hit and
`source: "aurora-via-rds-proxy"` on a miss. The UI surfaces this as a coloured
pill, which is the quickest way to demonstrate caching in a live review.

## Environment variables

All of these are injected by the CloudFormation compute stack — nothing needs to
be set by hand.

| Variable | Source |
|---|---|
| `PORT` | Task definition (3000) |
| `DB_HOST` | RDS Proxy endpoint |
| `DB_PORT`, `DB_NAME`, `DB_SSL` | Database stack outputs |
| `DB_USER`, `DB_PASSWORD` | ECS secrets → RDS-managed Secrets Manager secret |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_TLS` | Cache stack outputs |
| `CACHE_TTL_SECONDS` | Task definition (60) |

## CI/CD

`.github/workflows/build-and-deploy.yml` runs on every push to `main`. The
workflow itself is only the step wiring; the logic lives beside it:

| File | Does |
|---|---|
| `.github/workflows/build-and-deploy.yml` | step wiring — OIDC, ECR login, buildx, build/push |
| `.github/scripts/verify-config.sh` | validates `AWS_REGION`, `ECR_REPOSITORY`, `AWS_ROLE_ARN` before anything touches AWS |
| `.github/scripts/debug-oidc-claims.py` | prints the OIDC claims GitHub presents, when `DEBUG_OIDC=true` |

What a run does:

1. Assumes an AWS role via **GitHub OIDC** — no long-lived keys in the repo.
2. Builds the container image.
3. Pushes it to ECR — which fires the EventBridge rule that starts CodePipeline
   and the CodeDeploy blue/green deployment.

That is all CI does. `config.zip` (`taskdef.json` + `appspec.yaml`) is rendered
by the **infrastructure stack** at deploy time, from the task definition
CloudFormation already owns, and re-rendered automatically whenever that task
definition changes. CI never reads the live task definition back out of AWS, so
its role needs neither `ecs:DescribeTaskDefinition` nor `s3:PutObject`.

### Required repository configuration

| Kind | Name | Value |
|---|---|---|
| Secret | `AWS_ROLE_ARN` | `GitHubActionsRoleArn` stack output |
| Variable | `AWS_REGION` | `eu-central-1` |
| Variable | `ECR_REPOSITORY` | `week6-todo` |

`CONFIG_BUCKET` and `TASK_FAMILY` are no longer used — the deployment config is
produced by the stack, not by CI.

## Running locally

```bash
npm install
DB_HOST=localhost DB_PORT=5432 DB_NAME=tododb DB_USER=postgres DB_PASSWORD=postgres \
DB_SSL=false REDIS_HOST=localhost REDIS_PORT=6379 REDIS_TLS=false \
npm start
```

The app tolerates Redis being unavailable — reads simply fall through to
Postgres and `source` stays `aurora-via-rds-proxy`.
