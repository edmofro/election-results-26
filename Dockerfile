FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.mjs index.html ./
USER node
CMD ["node", "server.mjs"]
