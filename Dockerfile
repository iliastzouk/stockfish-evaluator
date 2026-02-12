FROM node:18-alpine

# Install Stockfish binary
RUN apk add --no-cache stockfish

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy server code
COPY server.js ./

# Expose port
EXPOSE 3000

# Run server
CMD ["node", "server.js"]
