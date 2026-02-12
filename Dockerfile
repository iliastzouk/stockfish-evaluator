FROM node:18-slim

# Install Stockfish binary
RUN apt-get update && \
    apt-get install -y stockfish && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy server code
COPY server-binary.js ./

# Expose port
EXPOSE 3000

# Run server
CMD ["node", "server-binary.js"]
