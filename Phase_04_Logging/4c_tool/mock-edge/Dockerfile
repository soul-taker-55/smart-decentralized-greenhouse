FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer caches across code changes.
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Run as a non-root user.
USER node

CMD ["node", "src/index.js"]
