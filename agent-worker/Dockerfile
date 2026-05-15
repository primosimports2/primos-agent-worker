# Playwright's official image already has Chromium + all OS deps preinstalled
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p .

# Drop dev deps to slim the image
RUN npm prune --omit=dev

ENV NODE_ENV=production

CMD ["node", "--enable-source-maps", "dist/index.js"]
