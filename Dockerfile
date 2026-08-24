# Multi-stage build keeps the runtime image small and free of build tooling.
FROM public.ecr.aws/docker/library/node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM public.ecr.aws/docker/library/node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Run as a non-root user.
RUN addgroup -g 1001 -S appgrp && adduser -u 1001 -S appusr -G appgrp

COPY --from=deps --chown=appusr:appgrp /app/node_modules ./node_modules
COPY --chown=appusr:appgrp package*.json ./
COPY --chown=appusr:appgrp server.js ./
COPY --chown=appusr:appgrp public ./public

USER appusr
EXPOSE 3000

# Container-level health check. The ALB does its own check on / as well.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
