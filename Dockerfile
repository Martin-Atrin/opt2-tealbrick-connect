# Connect miniapp image. Built from source by CI / Railway (C20). Node 24 runs the TypeScript sources directly.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY tealbrick.manifest.json ./
COPY migrations ./migrations
COPY policies ./policies
COPY skills ./skills
COPY src ./src

RUN mkdir -p /data /backup && chown -R node:node /data /backup
USER node

EXPOSE 8080
CMD ["node", "src/main.ts"]
