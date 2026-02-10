FROM node:18-alpine

# Install PostgreSQL client for database operations
RUN apk add --no-cache postgresql-client bash

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files (everything in migration_gui)
COPY . .

# Create migration_gui directory structure and copy data if exists
RUN mkdir -p /app/migration_gui && \
    if [ -d "data" ]; then cp -r data /app/migration_gui/data; fi && \
    chmod +x init_migration_debug.sh test_db_connection.js

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/api/status', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["node", "server.js"]
