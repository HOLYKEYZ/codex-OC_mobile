FROM node:20-slim

# Install system deps
RUN apt-get update && apt-get install -y curl unzip git ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Codex CLI globally
RUN npm install -g @openai/codex

# Install OpenCode binary (non-interactive)
RUN curl -fsSL https://get.opencode.ai | sh

# Create app directory
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3001

# Default: start server; override with "node relay.js" for desktop relay
CMD ["node", "server.js"]
