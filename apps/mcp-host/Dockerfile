# Dockerfile for Fly.io deployment

FROM node:20-slim AS builder

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy package files
COPY package.json tsconfig.json ./
COPY src ./src

# Install dependencies
RUN pnpm install

# Build TypeScript
RUN pnpm build

# Production stage
FROM node:20-slim AS production

WORKDIR /app

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Expose the port Fly.io expects
EXPOSE 8080

# Start the server
CMD ["node", "dist/index.js"]
