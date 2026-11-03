FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY app ./app
COPY src ./src
COPY web ./web
COPY Dockerfile .dockerignore LICENSE README.md ./
COPY scripts/build-inputs.mjs ./scripts/build-inputs.mjs
RUN node scripts/build-inputs.mjs write /app && npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /app/data /app/secrets && chown -R node:node /app/data /app/secrets
COPY LICENSE README.md ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/build-inputs.json ./build-inputs.json
USER node
EXPOSE 3100
CMD ["node", "dist/server/app/api.js"]
