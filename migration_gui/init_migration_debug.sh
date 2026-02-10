#!/bin/bash
# Debug version of init_migration.sh with verbose output

echo "=== Migration Database Initialization (Debug Mode) ==="
echo ""

# Show environment variables
echo "Environment Variables:"
echo "  MIGRATION_PG_HOST: ${MIGRATION_PG_HOST:-NOT SET}"
echo "  MIGRATION_PG_PORT: ${MIGRATION_PG_PORT:-NOT SET}"
echo "  MIGRATION_PG_USER: ${MIGRATION_PG_USER:-NOT SET}"
echo "  MIGRATION_PG_PASSWORD: ${MIGRATION_PG_PASSWORD:-NOT SET (length: ${#MIGRATION_PG_PASSWORD})}"
echo "  MIGRATION_PG_DATABASE: ${MIGRATION_PG_DATABASE:-NOT SET}"
echo ""

# Set defaults
MIGRATION_PG_HOST="${MIGRATION_PG_HOST:-migration-postgres}"
MIGRATION_PG_PORT="${MIGRATION_PG_PORT:-5432}"
MIGRATION_PG_USER="${MIGRATION_PG_USER:-migration_user}"
MIGRATION_PG_PASSWORD="${MIGRATION_PG_PASSWORD:-migration_pass}"
MIGRATION_PG_DATABASE="${MIGRATION_PG_DATABASE:-migration_tracking}"

echo "Using values:"
echo "  Host: $MIGRATION_PG_HOST"
echo "  Port: $MIGRATION_PG_PORT"
echo "  User: $MIGRATION_PG_USER"
echo "  Database: $MIGRATION_PG_DATABASE"
echo ""

# Check if psql is available
if ! command -v psql &> /dev/null; then
    echo "ERROR: psql command not found!"
    echo "PostgreSQL client is not installed."
    exit 1
fi

echo "✓ psql command found: $(which psql)"
echo ""

# Test connection
echo "Testing database connection..."
if PGPASSWORD="$MIGRATION_PG_PASSWORD" psql -h "$MIGRATION_PG_HOST" -p "$MIGRATION_PG_PORT" -U "$MIGRATION_PG_USER" -d "$MIGRATION_PG_DATABASE" -c "SELECT 1" 2>&1; then
    echo "✓ Database connection successful!"
else
    echo "✗ Database connection failed!"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Check if migration-postgres container is running:"
    echo "     docker ps | grep migration-postgres"
    echo ""
    echo "  2. Check migration-postgres logs:"
    echo "     docker logs migration-tracking-db"
    echo ""
    echo "  3. Try connecting manually:"
    echo "     PGPASSWORD=$MIGRATION_PG_PASSWORD psql -h $MIGRATION_PG_HOST -p $MIGRATION_PG_PORT -U $MIGRATION_PG_USER -d $MIGRATION_PG_DATABASE"
    echo ""
    exit 2
fi

echo ""
echo "Creating migration tables..."
echo ""

PGPASSWORD="$MIGRATION_PG_PASSWORD" psql -h "$MIGRATION_PG_HOST" -p "$MIGRATION_PG_PORT" -U "$MIGRATION_PG_USER" -d "$MIGRATION_PG_DATABASE" << 'EOF'

-- Create migration batch table
CREATE TABLE IF NOT EXISTS migration_batch (
    id SERIAL PRIMARY KEY,
    batch_name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'running',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    metadata JSONB DEFAULT '{}'
);

-- Create migration data table
CREATE TABLE IF NOT EXISTS migration_data (
    id SERIAL PRIMARY KEY,
    batch_id INTEGER REFERENCES migration_batch(id) ON DELETE CASCADE,
    table_name VARCHAR(255) NOT NULL,
    old_id VARCHAR(255) NOT NULL,
    new_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending',
    error_message TEXT,
    source_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(table_name, old_id, batch_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_migration_data_table_old_id ON migration_data(table_name, old_id);
CREATE INDEX IF NOT EXISTS idx_migration_data_batch_id ON migration_data(batch_id);
CREATE INDEX IF NOT EXISTS idx_migration_data_status ON migration_data(status);
CREATE INDEX IF NOT EXISTS idx_migration_batch_status ON migration_batch(status);

\echo ''
\echo '=== Migration tables created successfully ==='
\echo ''

-- Show created tables
\dt migration_*

EOF

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "✓ Migration tracking tables ready!"
    echo ""
else
    echo ""
    echo "✗ Failed to create tables (exit code: $EXIT_CODE)"
    echo ""
    exit $EXIT_CODE
fi
