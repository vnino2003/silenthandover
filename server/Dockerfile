# Build from the repository root:  docker build -f server/Dockerfile -t silent-handover-api .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace server --include-workspace-root
COPY packages/shared packages/shared
COPY server server
COPY supabase supabase
RUN npm run build -w server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace server --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/supabase supabase
USER node
EXPOSE 8787
CMD ["node", "server/dist/main.js"]
