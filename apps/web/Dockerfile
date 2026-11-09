# The web app as a small nginx image, for a VPS (Coolify or plain Docker). Build from the
# repository root, with the API's public address baked in:
#   docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://api.example.com -t silent-handover-web .
FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN test -n "$VITE_API_URL" || (echo "Set the VITE_API_URL build argument to the API address" && exit 1)
RUN npm run build -w apps/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
