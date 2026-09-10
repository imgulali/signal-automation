FROM oven/bun:1.3.13-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_PATH=/app/data/automation.sqlite

RUN mkdir -p /app/data && chown bun:bun /app/data

COPY --chown=bun:bun package.json index.ts ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun web ./web

USER bun
EXPOSE 8080

CMD ["bun", "index.ts"]