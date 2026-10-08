# Production image: builds the web app and runs the API, which also serves the SPA (same origin).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build --workspace web && npm run build --workspace server && cp -r server/src/db/migrations server/dist/db/

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/web/package.json web/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
