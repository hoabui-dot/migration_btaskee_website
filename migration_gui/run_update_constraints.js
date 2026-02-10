/**
 * Run SQL Constraint Updates
 * 
 * This script executes the update_constraints.sql file
 * against the PostgreSQL database using Node.js
 */

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Database connection settings
const CONFIG = {
    host: process.env.PG_HOST || '192.168.88.85',
    port: parseInt(process.env.PG_PORT) || 5433,
    user: process.env.PG_USER || 'directus',
    password: process.env.PG_PASSWORD || 'directus',
    database: process.env.PG_DATABASE || 'directus',
};

async function runConstraintUpdates() {
    console.log('\n============================================');
    console.log('PostgreSQL Constraint Update Script');
    console.log('============================================');
    console.log(`Host: ${CONFIG.host}`);
    console.log(`Port: ${CONFIG.port}`);
    console.log(`Database: ${CONFIG.database}`);
    console.log(`User: ${CONFIG.user}`);
    console.log('============================================\n');

    // Read SQL file
    const sqlFile = path.join(__dirname, 'update_constraints.sql');
    if (!fs.existsSync(sqlFile)) {
        console.error('ERROR: update_constraints.sql not found');
        process.exit(1);
    }

    const sqlContent = fs.readFileSync(sqlFile, 'utf8');

    // Connect to database
    const client = new Client(CONFIG);

    try {
        console.log('Connecting to database...');
        await client.connect();
        console.log('✓ Connected successfully\n');

        console.log('Executing SQL script...\n');

        // Split SQL into individual statements
        // Remove comments and split by semicolon
        const statements = sqlContent
            .split('\n')
            .filter(line => !line.trim().startsWith('--'))
            .join('\n')
            .split(';')
            .map(stmt => stmt.trim())
            .filter(stmt => stmt.length > 0);

        let successCount = 0;
        let errorCount = 0;

        for (let i = 0; i < statements.length; i++) {
            const statement = statements[i];
            
            // Skip empty statements
            if (!statement || statement.length < 5) continue;

            // Show progress for important statements
            if (statement.includes('ALTER TABLE') || 
                statement.includes('CREATE INDEX') ||
                statement.includes('SELECT')) {
                const preview = statement.substring(0, 80).replace(/\s+/g, ' ');
                console.log(`[${i + 1}/${statements.length}] ${preview}...`);
            }

            try {
                const result = await client.query(statement);
                
                // Show results for SELECT queries
                if (statement.toUpperCase().includes('SELECT') && result.rows && result.rows.length > 0) {
                    console.table(result.rows);
                }
                
                successCount++;
            } catch (error) {
                // Some errors are expected (e.g., constraint already exists)
                if (error.message.includes('already exists') || 
                    error.message.includes('does not exist')) {
                    console.log(`  ⚠️  ${error.message}`);
                } else {
                    console.error(`  ✗ Error: ${error.message}`);
                    errorCount++;
                }
            }
        }

        console.log('\n============================================');
        console.log('Execution Summary');
        console.log('============================================');
        console.log(`Total statements: ${statements.length}`);
        console.log(`Successful: ${successCount}`);
        console.log(`Errors: ${errorCount}`);
        console.log('============================================\n');

        if (errorCount === 0) {
            console.log('✓ All constraints updated successfully!\n');
        } else {
            console.log(`⚠️  Completed with ${errorCount} errors\n`);
        }

    } catch (error) {
        console.error('\n✗ Fatal error:', error.message);
        process.exit(1);
    } finally {
        await client.end();
        console.log('Disconnected from database\n');
    }
}

// Run the script
runConstraintUpdates().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
