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

`.github/workflows/build-and-deploy.yml` runs on every push to `main`:

1. Assumes an AWS role via **GitHub OIDC** — no long-lived keys in the repo.
2. Builds the container image.
3. Renders `taskdef.json` from the live CloudFormation-managed task definition.
4. Uploads `config.zip` (`taskdef.json` + `appspec.yaml`) to the deploy bucket.
5. Pushes the image to ECR — which fires the EventBridge rule that starts
   CodePipeline and the CodeDeploy blue/green deployment.

### Required repository configuration

| Kind | Name | Value |
|---|---|---|
| Secret | `AWS_ROLE_ARN` | `GitHubActionsRoleArn` stack output |
| Variable | `AWS_REGION` | `eu-central-1` |
| Variable | `ECR_REPOSITORY` | `week6-todo` |
| Variable | `CONFIG_BUCKET` | `ConfigBucketName` stack output |
| Variable | `TASK_FAMILY` | `week6-todo` |

## Running locally

```bash
npm install
DB_HOST=localhost DB_PORT=5432 DB_NAME=tododb DB_USER=postgres DB_PASSWORD=postgres \
DB_SSL=false REDIS_HOST=localhost REDIS_PORT=6379 REDIS_TLS=false \
npm start
```

The app tolerates Redis being unavailable — reads simply fall through to
Postgres and `source` stays `aurora-via-rds-proxy`.
