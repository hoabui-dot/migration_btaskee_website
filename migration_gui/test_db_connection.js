#!/usr/bin/env node
/**
 * Test database connections
 */

require('dotenv').config();
const { Client } = require('pg');

async function testConnection(name, config) {
    console.log(`\n=== Testing ${name} ===`);
    console.log('Config:', {
        host: config.host,
        port: config.port,
        user: config.user,
        database: config.database,
    });
    
    const client = new Client(config);
    
    try {
        await client.connect();
        console.log('✓ Connected successfully');
        
        const result = await client.query('SELECT version()');
        console.log('✓ Query successful');
        console.log('PostgreSQL version:', result.rows[0].version.split(' ')[0], result.rows[0].version.split(' ')[1]);
        
        await client.end();
        return true;
    } catch (error) {
        console.error('✗ Connection failed:', error.message);
        return false;
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('Database Connection Test');
    console.log('='.repeat(60));
    
    // Test Main Directus Database
    const mainDbSuccess = await testConnection('Main Directus Database', {
        host: process.env.PG_HOST || 'localhost',
        port: process.env.PG_PORT || 5433,
        user: process.env.PG_USER || 'directus',
        password: process.env.PG_PASSWORD || 'directus',
        database: process.env.PG_DATABASE || 'directus',
    });
    
    // Test Migration Tracking Database
    const migrationDbSuccess = await testConnection('Migration Tracking Database', {
        host: process.env.MIGRATION_PG_HOST || 'localhost',
        port: process.env.MIGRATION_PG_PORT || 5434,
        user: process.env.MIGRATION_PG_USER || 'migration_user',
        password: process.env.MIGRATION_PG_PASSWORD || 'migration_pass',
        database: process.env.MIGRATION_PG_DATABASE || 'migration_tracking',
    });
    
    console.log('\n' + '='.repeat(60));
    console.log('Summary:');
    console.log('  Main DB:', mainDbSuccess ? '✓ OK' : '✗ FAILED');
    console.log('  Migration DB:', migrationDbSuccess ? '✓ OK' : '✗ FAILED');
    console.log('='.repeat(60));
    
    process.exit(mainDbSuccess && migrationDbSuccess ? 0 : 1);
}

main();
