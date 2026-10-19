FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install --no-install-recommends -y git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@10.33.0

WORKDIR /workspace
