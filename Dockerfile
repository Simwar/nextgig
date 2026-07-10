# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN bun install

# Copy source
COPY . .

# Runtime stage
FROM oven/bun:1-slim

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/package.json ./

# Pre-create the writable data dir (prod filesystem is read-only otherwise).
# Holds the file-backed LibSQL db for subscriptions + agent memory.
RUN mkdir -p /app/data

# Use non-root user already present in oven/bun image (bun:1000)
RUN chown -R bun:bun /app
USER bun

# Custom chat frontend is served on port 80 (see agent/webserver.ts).
EXPOSE 80

# Run the agent
CMD ["bun", "run", "agent/index.ts"]
