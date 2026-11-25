# Hosted figma-remote-mcp: the OAuth front door, the MCP endpoint and figma.com's editor in one image, for any Docker
# host (a VM, Fly, Railway, Render, …). Multi-arch: the Playwright base ships arm64 + amd64 Chromium.
#   docker build -t figma-remote-mcp .
#   docker run -d --restart=always -p 127.0.0.1:8080:8080 \
#     -e SEAL_KEY="$(openssl rand -base64 32)" -e PUBLIC_URL=https://figma.example.com figma-remote-mcp
# Keep the tag in step with the exact playwright version in package.json (its browsers ship in the image).
FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production PORT=8080 STATIC_CACHE_DIR=/home/pwuser/.cache/figma-remote-mcp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=pwuser:pwuser src ./src
USER pwuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/cli.js", "serve"]
