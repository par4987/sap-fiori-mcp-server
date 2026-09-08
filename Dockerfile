# syntax=docker/dockerfile:1
# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-alpine
LABEL org.opencontainers.image.title="@pired/sap-fiori-mcp-server"
LABEL org.opencontainers.image.description="Unified MCP server for SAP Fiori / UI5 / CAP development"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md ./
COPY examples ./examples
# HTTP mode: docker run -p 3001:3001 -e SAP_FIORI_MCP_API_KEY=secret <image> --http --port 3001
# stdio mode (for docker-based MCP clients): no args
ENTRYPOINT ["node", "dist/index.js"]
