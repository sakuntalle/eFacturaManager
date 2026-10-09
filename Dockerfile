FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY app ./app
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /app/data /app/mock-data && chown -R node:node /app/data /app/mock-data
COPY LICENSE README.md ./
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3100
CMD ["node", "dist/server/app/api.js"]
