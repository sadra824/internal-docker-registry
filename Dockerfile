FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    APP_PORT=5000 \
    HOST=::

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 5000

CMD ["node", "src/index.js"]
