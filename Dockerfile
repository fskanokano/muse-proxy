# muse-proxy 本地服务: multi-stage (admin-web 静态 + Node 服务)。
# 目标机 arm64, 基镜像原生支持。
FROM node:22-alpine AS web-build
WORKDIR /w
COPY admin-web/package.json admin-web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY admin-web/ ./
RUN npm run build

FROM node:22-alpine
# iproute2: 出口发现必须能跑 `ip addr/rule/route` (host 网络命名空间)。
RUN apk add --no-cache iproute2
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
# 运行时: server/ + 代理实现树 (supabase/functions) + Vercel 兼容层 (api/)
COPY server/ ./server/
COPY supabase/ ./supabase/
COPY api/ ./api/
COPY --from=web-build /w/dist ./admin-web/dist
RUN mkdir -p /data
EXPOSE 18091
CMD ["node_modules/.bin/tsx", "server/main.ts"]
