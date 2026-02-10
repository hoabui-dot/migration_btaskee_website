#!/bin/bash

# ============================================
# Run SQL Constraint Updates
# ============================================
# This script executes the update_constraints.sql file
# against the PostgreSQL database
# ============================================

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Database connection settings
DB_HOST="${PG_HOST:-192.168.88.85}"
DB_PORT="${PG_PORT:-5433}"
DB_USER="${PG_USER:-directus}"
DB_PASSWORD="${PG_PASSWORD:-directus}"
DB_NAME="${PG_DATABASE:-directus}"

echo "============================================"
echo "PostgreSQL Constraint Update Script"
echo "============================================"
echo "Host: $DB_HOST"
echo "Port: $DB_PORT"
echo "Database: $DB_NAME"
echo "User: $DB_USER"
echo "============================================"
echo ""

# Check if psql is installed
if ! command -v psql &> /dev/null; then
    echo "ERROR: psql command not found. Please install PostgreSQL client."
    echo ""
    echo "Installation:"
    echo "  macOS: brew install postgresql"
    echo "  Ubuntu/Debian: sudo apt-get install postgresql-client"
    echo "  CentOS/RHEL: sudo yum install postgresql"
    exit 1
fi

# Check if SQL file exists
if [ ! -f "update_constraints.sql" ]; then
    echo "ERROR: update_constraints.sql not found in current directory"
    exit 1
fi

echo "Executing SQL script..."
echo ""

# Execute SQL file
PGPASSWORD="$DB_PASSWORD" psql \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    -f update_constraints.sql

# Check exit status
if [ $? -eq 0 ]; then
    echo ""
    echo "============================================"
    echo "✓ SQL script executed successfully!"
    echo "============================================"
else
    echo ""
    echo "============================================"
    echo "✗ SQL script execution failed!"
    echo "============================================"
    exit 1
fi
