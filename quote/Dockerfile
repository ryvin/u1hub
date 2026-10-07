FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
USER node
EXPOSE 4560
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:4560/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
