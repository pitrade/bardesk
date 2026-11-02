# SPDX-License-Identifier: GPL-3.0-or-later
# The optional headless Bardesk client (see bot/README.md).
# Build from the repository root after `cd frontend && npm run build:bot` (see bot/README.md):
#   docker build -f bot/Dockerfile -t bardesk-bot .
FROM node:24-alpine
WORKDIR /app
COPY bot/dist/bot.mjs ./bot.mjs
RUN mkdir /data && chown node:node /data
USER node
ENV BOT_DIR=/data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["node", "bot.mjs"]
CMD ["run"]
