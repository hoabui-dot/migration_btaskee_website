/**
 * Migration GUI Server
 * Provides web interface for WordPress to Directus migration
 */

require('dotenv').config({ path: '/.env' });
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const axios = require('axios');
const migrationScript = require('./migration_script.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.GUI_PORT || 3001;

// Store active migration process
let migrationProcess = null;
let migrationStatus = {
    isRunning: false,
    currentStep: null,
    progress: {},
    logs: [],
};

// WebSocket connections
const clients = new Set();

// Broadcast to all connected clients
function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// PostgreSQL clients
async function getDBClient() {
    const client = new Client({
        host: process.env.PG_HOST || 'localhost',
        port: process.env.PG_PORT || 5433,
        user: process.env.PG_USER || 'directus',
        password: process.env.PG_PASSWORD || 'directus',
        database: process.env.PG_DATABASE || 'directus',
    });
    await client.connect();
    return client;
}

async function getMigrationDBClient() {
    const client = new Client({
        host: process.env.MIGRATION_PG_HOST || 'localhost',
        port: process.env.MIGRATION_PG_PORT || 5434,
        user: process.env.MIGRATION_PG_USER || 'migration_user',
        password: process.env.MIGRATION_PG_PASSWORD || 'migration_pass',
        database: process.env.MIGRATION_PG_DATABASE || 'migration_tracking',
    });
    await client.connect();
    return client;
}

// Get migration statistics from database
async function getMigrationStats() {
    const migrationDb = await getMigrationDBClient();
    
    try {
        // Check if migration tables exist
        const tableCheck = await migrationDb.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'migration_batch'
            ) as exists
        `);
        
        if (!tableCheck.rows[0].exists) {
            return {
                initialized: false,
                batches: [],
                stats: {},
            };
        }
        
        // Get latest batch info
        const batchResult = await migrationDb.query(`
            SELECT id, batch_name, status, started_at, completed_at, error_message
            FROM migration_batch
            ORDER BY id DESC
            LIMIT 10
        `);
        
        // Get statistics by table
        const statsResult = await migrationDb.query(`
            SELECT 
                table_name,
                COUNT(*) as total,
                COUNT(CASE WHEN status = 'success' THEN 1 END) as success,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending
            FROM migration_data
            GROUP BY table_name
            ORDER BY table_name
        `);
        
        // Get failed records with details
        const failedResult = await migrationDb.query(`
            SELECT 
                id,
                table_name,
                old_id,
                error_message,
                source_data,
                created_at
            FROM migration_data
            WHERE status = 'failed'
            ORDER BY created_at DESC
            LIMIT 100
        `);
        
        return {
            initialized: true,
            batches: batchResult.rows,
            stats: statsResult.rows.reduce((acc, row) => {
                acc[row.table_name] = {
                    total: parseInt(row.total),
                    success: parseInt(row.success),
                    failed: parseInt(row.failed),
                    pending: parseInt(row.pending),
                };
                return acc;
            }, {}),
            failed: failedResult.rows,
        };
    } finally {
        await migrationDb.end();
    }
}

// Initialize migration database
async function initMigrationDB() {
    console.log('[INIT] Starting migration database initialization...');
    broadcast({ type: 'log', level: 'info', message: 'Initializing migration tracking database...\n' });
    
    try {
        // Connect to databases first
        await migrationScript.connectDB();
        
        // Run initialization
        const result = await migrationScript.initializeMigrationDB();
        
        console.log('[INIT] Success:', result.message);
        broadcast({ type: 'log', level: 'info', message: `✓ ${result.message}\n` });
        
        // Disconnect
        await migrationScript.disconnectDB();
        
        return { success: true, message: result.message };
        
    } catch (error) {
        console.error('[INIT] Error:', error.message);
        broadcast({ type: 'log', level: 'error', message: `✗ Initialization failed: ${error.message}\n` });
        
        // Try to disconnect on error
        try {
            await migrationScript.disconnectDB();
        } catch (disconnectError) {
            console.error('[INIT] Disconnect error:', disconnectError.message);
        }
        
        throw error;
    }
}

// Run migration
async function runMigration(command = 'migrate', options = {}) {
    if (migrationProcess) {
        throw new Error('Migration is already running');
    }
    
    migrationStatus = {
        isRunning: true,
        currentStep: 'Starting...',
        progress: {},
        logs: [],
        startTime: new Date(),
    };
    
    broadcast({ type: 'status', data: migrationStatus });
    
    return new Promise((resolve, reject) => {
        // Build command arguments
        const args = [command];
        
        // Add limit if provided
        if (options.limit !== null && options.limit !== undefined) {
            args.push('--limit', String(options.limit));
        }
        
        // Add template IDs if provided
        if (options.postTemplateId) {
            args.push('--post-template', String(options.postTemplateId));
        }
        if (options.collectionTemplateId) {
            args.push('--collection-template', String(options.collectionTemplateId));
        }
        
        // Add folder ID if provided
        if (options.folderId) {
            args.push('--folder', String(options.folderId));
        }
        
        // Add author info if provided
        if (options.authorId) {
            args.push('--author-id', String(options.authorId));
        }
        if (options.authorName) {
            args.push('--author-name', String(options.authorName));
        }
        
        console.log(`[MIGRATION] Starting with args:`, args);
        
        // Spawn with increased memory limit and garbage collection enabled
        migrationProcess = spawn('node', [
            '--max-old-space-size=4096',  // 4GB memory limit
            '--expose-gc',                 // Enable manual garbage collection
            'migration_script.js',
            ...args
        ], {
            cwd: __dirname,
            env: { ...process.env },
        });
        
        let currentTable = null;
        
        migrationProcess.stdout.on('data', (data) => {
            const text = data.toString();
            migrationStatus.logs.push({ time: new Date(), level: 'info', text });
            
            // Parse progress from logs
            const lines = text.split('\n');
            lines.forEach(line => {
                // Detect current step - match patterns like "=== Migrating Tags ==="
                if (line.includes('===') && line.includes('Migrating')) {
                    const match = line.match(/=== Migrating (.*?) (?:\(.*?\) )?===/);
                    if (match) {
                        currentTable = match[1].trim();
                        migrationStatus.currentStep = currentTable;
                        console.log(`[PROGRESS] Current step: ${currentTable}`);
                    }
                }
                
                // Parse summary lines - handle multiple formats:
                // "Tags: 10 success, 0 skipped, 0 failed"
                // "Tag Translations: 10 success, 0 failed"
                // "Posts: 18 success, 0 skipped, 2 failed"
                const summaryMatch = line.match(/\[INFO\]\s+(Tags|Tag Translations|Categories|Category Translations|Posts|Post Tags):\s*(\d+)\s+success(?:,\s*(\d+)\s+skipped)?(?:,\s*(\d+)\s+failed)?/i);
                if (summaryMatch) {
                    const tableName = summaryMatch[1];
                    const success = parseInt(summaryMatch[2]) || 0;
                    const skipped = summaryMatch[3] ? parseInt(summaryMatch[3]) : 0;
                    const failed = summaryMatch[4] ? parseInt(summaryMatch[4]) : 0;
                    
                    if (!migrationStatus.progress[tableName]) {
                        migrationStatus.progress[tableName] = {};
                    }
                    migrationStatus.progress[tableName].success = success;
                    migrationStatus.progress[tableName].skipped = skipped;
                    migrationStatus.progress[tableName].failed = failed;
                    
                    console.log(`[PROGRESS] ${tableName}: ${success} success, ${skipped} skipped, ${failed} failed`);
                }
                
                // Parse batch progress: "BATCH 1/10: Processing posts 1-30 of 300"
                const batchStartMatch = line.match(/BATCH (\d+)\/(\d+): Processing posts (\d+)-(\d+) of (\d+)/i);
                if (batchStartMatch) {
                    const batchNum = parseInt(batchStartMatch[1]);
                    const totalBatches = parseInt(batchStartMatch[2]);
                    const batchStart = parseInt(batchStartMatch[3]);
                    const batchEnd = parseInt(batchStartMatch[4]);
                    const totalPosts = parseInt(batchStartMatch[5]);
                    
                    if (!migrationStatus.progress['WordPress Posts']) {
                        migrationStatus.progress['WordPress Posts'] = {};
                    }
                    
                    migrationStatus.progress['WordPress Posts'].currentBatch = batchNum;
                    migrationStatus.progress['WordPress Posts'].totalBatches = totalBatches;
                    migrationStatus.progress['WordPress Posts'].batchStart = batchStart;
                    migrationStatus.progress['WordPress Posts'].batchEnd = batchEnd;
                    migrationStatus.progress['WordPress Posts'].total = totalPosts;
                    
                    console.log(`[BATCH] Processing batch ${batchNum}/${totalBatches}: posts ${batchStart}-${batchEnd}`);
                }
                
                // Parse batch completion: "BATCH 1/10 COMPLETED in 5.23s"
                const batchCompleteMatch = line.match(/BATCH (\d+)\/(\d+) COMPLETED in ([\d.]+)s/i);
                if (batchCompleteMatch) {
                    const batchNum = parseInt(batchCompleteMatch[1]);
                    const totalBatches = parseInt(batchCompleteMatch[2]);
                    const duration = parseFloat(batchCompleteMatch[3]);
                    
                    console.log(`[BATCH] Batch ${batchNum}/${totalBatches} completed in ${duration}s`);
                }
                
                // Parse individual progress updates like "[10/20] Posts: 8 success, 0 skipped, 2 failed"
                const progressMatch = line.match(/\[(\d+)\/(\d+)\]\s+(Tags|Tag Translations|Categories|Category Translations|Posts|Post Tags):\s*(\d+)\s+success(?:,\s*(\d+)\s+skipped)?(?:,\s*(\d+)\s+failed)?/i);
                if (progressMatch) {
                    const current = parseInt(progressMatch[1]);
                    const total = parseInt(progressMatch[2]);
                    const tableName = progressMatch[3];
                    const success = parseInt(progressMatch[4]) || 0;
                    const skipped = progressMatch[5] ? parseInt(progressMatch[5]) : 0;
                    const failed = progressMatch[6] ? parseInt(progressMatch[6]) : 0;
                    
                    if (!migrationStatus.progress[tableName]) {
                        migrationStatus.progress[tableName] = {};
                    }
                    
                    // Update with real-time counts
                    migrationStatus.progress[tableName].success = success;
                    migrationStatus.progress[tableName].skipped = skipped;
                    migrationStatus.progress[tableName].failed = failed;
                    migrationStatus.progress[tableName].total = total;
                    migrationStatus.progress[tableName].current = current;
                    
                    // Log every update for debugging (can be removed later)
                    if (current % 5 === 0 || current === total) {
                        console.log(`[PROGRESS] ${tableName}: ${current}/${total} - ${success} success, ${skipped} skipped, ${failed} failed`);
                    }
                }
            });
            
            broadcast({ type: 'log', level: 'info', message: text });
            broadcast({ type: 'status', data: migrationStatus });
        });
        
        migrationProcess.stderr.on('data', (data) => {
            const text = data.toString();
            migrationStatus.logs.push({ time: new Date(), level: 'error', text });
            broadcast({ type: 'log', level: 'error', message: text });
        });
        
        migrationProcess.on('close', (code) => {
            migrationStatus.isRunning = false;
            migrationStatus.endTime = new Date();
            migrationStatus.exitCode = code;
            migrationProcess = null;
            
            broadcast({ type: 'status', data: migrationStatus });
            broadcast({ type: 'complete', code, success: code === 0 });
            
            if (code === 0) {
                resolve({ success: true, status: migrationStatus });
            } else {
                reject(new Error(`Migration failed with code ${code}`));
            }
        });
    });
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('Client connected. Total clients:', clients.size);
    
    // Send current status
    ws.send(JSON.stringify({ type: 'status', data: migrationStatus }));
    
    ws.on('close', () => {
        clients.delete(ws);
        console.log('Client disconnected. Total clients:', clients.size);
    });
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API endpoints
app.get('/api/status', async (req, res) => {
    try {
        const stats = await getMigrationStats();
        res.json({
            migration: migrationStatus,
            database: stats,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/init', async (req, res) => {
    try {
        const result = await initMigrationDB();
        res.json(result);
    } catch (error) {
        console.error('[API /api/init] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Test database connections
app.get('/api/test-db', async (req, res) => {
    const results = {
        mainDb: { connected: false, error: null },
        migrationDb: { connected: false, error: null },
    };
    
    // Test main DB
    try {
        const mainDb = await getDBClient();
        await mainDb.query('SELECT 1');
        results.mainDb.connected = true;
        await mainDb.end();
    } catch (error) {
        results.mainDb.error = error.message;
    }
    
    // Test migration DB
    try {
        const migrationDb = await getMigrationDBClient();
        await migrationDb.query('SELECT 1');
        results.migrationDb.connected = true;
        await migrationDb.end();
    } catch (error) {
        results.migrationDb.error = error.message;
    }
    
    res.json(results);
});

app.post('/api/migrate', async (req, res) => {
    try {
        if (migrationStatus.isRunning) {
            return res.status(400).json({ error: 'Migration is already running' });
        }
        
        // Get parameters from request body
        const limit = req.body.limit !== undefined ? parseInt(req.body.limit) : null;
        const postTemplateId = req.body.postTemplateId ? parseInt(req.body.postTemplateId) : null;
        const collectionTemplateId = req.body.collectionTemplateId ? parseInt(req.body.collectionTemplateId) : null;
        const folderId = req.body.folderId ? String(req.body.folderId) : null;
        const authorId = req.body.authorId ? String(req.body.authorId) : null;
        const authorName = req.body.authorName ? String(req.body.authorName) : null;
        
        // Validate required parameters
        if (!postTemplateId || !collectionTemplateId) {
            return res.status(400).json({ 
                error: 'Template IDs are required. Please select both Post Detail Template and Collection Listing Template.' 
            });
        }
        
        if (!folderId) {
            return res.status(400).json({ 
                error: 'Folder ID is required. Please select a Media Upload Folder.' 
            });
        }
        
        if (!authorId || !authorName) {
            return res.status(400).json({ 
                error: 'Author is required. Please select a Post Author.' 
            });
        }
        
        console.log(`[API /api/migrate] Starting migration with:`, {
            limit: limit === 0 ? 'none (full migration)' : limit,
            postTemplateId,
            collectionTemplateId,
            folderId,
            authorId,
            authorName
        });
        
        // Start migration in background
        runMigration('migrate', { limit, postTemplateId, collectionTemplateId, folderId, authorId, authorName }).catch(err => {
            console.error('Migration error:', err);
        });
        
        res.json({ 
            success: true, 
            message: 'Migration started',
            limit: limit === 0 ? 'none' : limit,
            postTemplateId,
            collectionTemplateId,
            folderId,
            authorId,
            authorName
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Search for page templates by title
app.get('/api/templates/search', async (req, res) => {
    try {
        const { title } = req.query;
        
        if (!title) {
            return res.status(400).json({ error: 'Title parameter is required' });
        }
        
        const db = await getDBClient();
        
        // Search in pages_translations table
        const result = await db.query(`
            SELECT 
                pt.pages_id,
                pt.title,
                pt.languages_code,
                p.status,
                p.date_created
            FROM pages_translations pt
            JOIN pages p ON pt.pages_id = p.id
            WHERE pt.title ILIKE $1
            ORDER BY pt.title
            LIMIT 10
        `, [`%${title}%`]);
        
        await db.end();
        
        res.json({ 
            success: true,
            results: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('[API /api/templates/search] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/stop', (req, res) => {
    if (migrationProcess) {
        migrationProcess.kill();
        migrationProcess = null;
        migrationStatus.isRunning = false;
        broadcast({ type: 'status', data: migrationStatus });
        res.json({ success: true, message: 'Migration stopped' });
    } else {
        res.status(400).json({ error: 'No migration is running' });
    }
});

app.post('/api/rollback/:batchId', async (req, res) => {
    try {
        const batchId = parseInt(req.params.batchId);
        const migrationDb = await getMigrationDBClient();
        const db = await getDBClient();
        
        // Get batch info from migration tracking database
        const batchResult = await migrationDb.query(
            'SELECT batch_name, status FROM migration_batch WHERE id = $1',
            [batchId]
        );
        
        if (batchResult.rows.length === 0) {
            await migrationDb.end();
            await db.end();
            return res.status(404).json({ error: 'Batch not found' });
        }
        
        const batch = batchResult.rows[0];
        
        // Get all migrated items for this batch from migration tracking database
        const itemsResult = await migrationDb.query(
            `SELECT table_name, new_id, old_id 
             FROM migration_data 
             WHERE batch_id = $1 AND status = 'success' AND new_id IS NOT NULL
             ORDER BY table_name, id DESC`,
            [batchId]
        );
        
        let deleted = 0;
        let failed = 0;
        const errors = [];
        
        // Group by table
        const itemsByTable = {};
        for (const item of itemsResult.rows) {
            if (!itemsByTable[item.table_name]) {
                itemsByTable[item.table_name] = [];
            }
            itemsByTable[item.table_name].push(item.new_id);
        }
        
        // Delete in reverse order (to handle FK constraints)
        // Note: directus_files are NOT deleted to preserve uploaded media
        const deleteOrder = ['post_translations', 'post_tag', 'post', 'tag_translations', 'tag', 'collection_translations', 'collection'];
        
        for (const tableName of deleteOrder) {
            if (!itemsByTable[tableName]) continue;
            
            const ids = itemsByTable[tableName];
            
            try {
                let result;
                if (tableName === 'directus_files') {
                    // UUID type for files
                    result = await db.query(
                        `DELETE FROM ${tableName} WHERE id = ANY($1::uuid[])`,
                        [ids]
                    );
                } else {
                    // Integer type for other tables
                    const intIds = ids.map(id => parseInt(id));
                    result = await db.query(
                        `DELETE FROM ${tableName} WHERE id = ANY($1::int[])`,
                        [intIds]
                    );
                }
                deleted += result.rowCount;
            } catch (error) {
                failed += ids.length;
                errors.push(`${tableName}: ${error.message}`);
            }
        }
        
        // Mark batch as rolled back in migration tracking database
        await migrationDb.query(
            `UPDATE migration_batch SET status = 'rolled_back', completed_at = NOW() WHERE id = $1`,
            [batchId]
        );
        
        // Mark migration_data as rolled back in migration tracking database
        await migrationDb.query(
            `UPDATE migration_data SET status = 'rolled_back' WHERE batch_id = $1`,
            [batchId]
        );
        
        await migrationDb.end();
        await db.end();
        
        res.json({
            success: true,
            message: `Rolled back batch: ${batch.batch_name}`,
            deleted,
            failed,
            errors
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/batch/:batchId/failed', async (req, res) => {
    try {
        const batchId = parseInt(req.params.batchId);
        const migrationDb = await getMigrationDBClient();
        
        // Get failed items for this batch from migration tracking database
        const result = await migrationDb.query(`
            SELECT 
                id,
                table_name,
                old_id,
                error_message,
                source_data,
                created_at
            FROM migration_data
            WHERE batch_id = $1 AND status = 'failed'
            ORDER BY table_name, created_at DESC
        `, [batchId]);
        
        // Get summary by table
        const summaryResult = await migrationDb.query(`
            SELECT 
                table_name,
                COUNT(*) as count
            FROM migration_data
            WHERE batch_id = $1 AND status = 'failed'
            GROUP BY table_name
            ORDER BY count DESC
        `, [batchId]);
        
        await migrationDb.end();
        
        res.json({
            failed: result.rows,
            summary: summaryResult.rows,
            total: result.rows.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/clean/:tableName', async (req, res) => {
    let db = null;
    let migrationDb = null;
    
    try {
        const tableName = req.params.tableName;
        
        // List of valid tables that can be cleaned
        const validTables = [
            'post_translations',
            'post_tag',
            'post',
            'tag_translations', 
            'tag',
            'collection_translations',
            'collection'
        ];
        
        // Validate table name first (before connecting to DB)
        if (tableName !== 'all' && !validTables.includes(tableName)) {
            return res.status(400).json({ 
                success: false,
                error: 'Invalid table name',
                errors: [`Invalid table name: ${tableName}`]
            });
        }
        
        // Connect to databases
        db = await getDBClient();
        migrationDb = await getMigrationDBClient();
        
        let deleted = 0;
        let errors = [];
        
        if (tableName === 'all') {
            // Delete all tables in reverse order (FK constraints)
            for (const table of validTables) {
                try {
                    const result = await db.query(`DELETE FROM ${table}`);
                    deleted += result.rowCount;
                    console.log(`[CLEAN] Deleted ${result.rowCount} rows from ${table}`);
                } catch (error) {
                    console.error(`[CLEAN] Error deleting from ${table}:`, error.message);
                    errors.push(`${table}: ${error.message}`);
                }
            }
            
            // Also clean migration tracking from migration database
            try {
                await migrationDb.query('DELETE FROM migration_data');
                await migrationDb.query('DELETE FROM migration_batch');
                console.log('[CLEAN] Cleaned migration tracking tables');
            } catch (error) {
                console.error('[CLEAN] Error cleaning migration tables:', error.message);
                errors.push(`migration tables: ${error.message}`);
            }
        } else {
            // Delete from specific table
            try {
                const result = await db.query(`DELETE FROM ${tableName}`);
                deleted = result.rowCount;
                console.log(`[CLEAN] Deleted ${result.rowCount} rows from ${tableName}`);
                
                // Clean migration tracking for this table from migration database
                await migrationDb.query('DELETE FROM migration_data WHERE table_name = $1', [tableName]);
            } catch (error) {
                console.error(`[CLEAN] Error deleting from ${tableName}:`, error.message);
                errors.push(error.message);
            }
        }
        
        res.json({
            success: errors.length === 0,
            deleted,
            errors,
            message: `Cleaned ${tableName === 'all' ? 'all tables' : tableName}: ${deleted} rows deleted`
        });
        
    } catch (error) {
        console.error('[CLEAN] Unexpected error:', error);
        res.status(500).json({ 
            success: false,
            error: error.message,
            errors: [error.message]
        });
    } finally {
        // Always close connections
        if (db) {
            try {
                await db.end();
            } catch (err) {
                console.error('[CLEAN] Error closing main DB:', err);
            }
        }
        if (migrationDb) {
            try {
                await migrationDb.end();
            } catch (err) {
                console.error('[CLEAN] Error closing migration DB:', err);
            }
        }
    }
});

app.get('/api/tables/count', async (req, res) => {
    try {
        const db = await getDBClient();
        
        const tables = [
            'post_translations',
            'post',
            'tag_translations', 
            'tag',
            'collection_translations',
            'collection'
        ];
        
        const counts = {};
        
        for (const table of tables) {
            try {
                const result = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
                counts[table] = parseInt(result.rows[0].count);
            } catch (error) {
                counts[table] = 0;
            }
        }
        
        await db.end();
        
        res.json({ counts });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/failed', async (req, res) => {
    try {
        const migrationDb = await getMigrationDBClient();
        const result = await migrationDb.query(`
            SELECT 
                id,
                table_name,
                old_id,
                error_message,
                source_data,
                created_at
            FROM migration_data
            WHERE status = 'failed'
            ORDER BY created_at DESC
            LIMIT 500
        `);
        await migrationDb.end();
        
        res.json({ failed: result.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
server.listen(PORT, () => {
    console.log(`\n=== Migration GUI Server ===`);
    console.log(`Server running at: http://localhost:${PORT}`);
    console.log(`WebSocket ready for real-time updates`);
    console.log(`\nPress Ctrl+C to stop\n`);
});

// Search for folders by name
app.get('/api/folders/search', async (req, res) => {
    try {
        const { name } = req.query;
        
        if (!name) {
            return res.status(400).json({ error: 'Name parameter is required' });
        }
        
        const db = await getDBClient();
        
        // Search in directus_folders table
        const result = await db.query(`
            SELECT 
                id,
                name,
                parent
            FROM directus_folders
            WHERE name ILIKE $1
            ORDER BY name
            LIMIT 10
        `, [`%${name}%`]);
        
        await db.end();
        
        res.json({ 
            success: true,
            results: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('[API /api/folders/search] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search for users by email
app.get('/api/users/search', async (req, res) => {
    try {
        const { email } = req.query;
        
        if (!email) {
            return res.status(400).json({ error: 'Email parameter is required' });
        }
        
        const db = await getDBClient();
        
        // Search in directus_users table
        const result = await db.query(`
            SELECT 
                id,
                first_name,
                last_name,
                email,
                status
            FROM directus_users
            WHERE email ILIKE $1
            ORDER BY first_name
            LIMIT 10
        `, [`%${email}%`]);
        
        await db.end();
        
        res.json({ 
            success: true,
            results: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('[API /api/users/search] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Replace Image - Upload from URL
app.post('/api/replace-image/upload-url', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }
        
        const axios = require('axios');
        
        // Download image from URL
        console.log(`[Replace Image] Downloading image from: ${url}`);
        const imageResponse = await axios.get(url, { 
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        // Upload to Directus via /files/import API
        const directusUrl = process.env.DIRECTUS_URL || 'http://localhost:8055';
        const directusToken = process.env.DIRECTUS_TOKEN;
        
        if (!directusToken) {
            throw new Error('DIRECTUS_TOKEN not configured');
        }
        
        console.log(`[Replace Image] Uploading to Directus...`);
        const uploadResponse = await axios.post(
            `${directusUrl}/files/import`,
            { url: url },
            {
                headers: {
                    'Authorization': `Bearer ${directusToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        const fileId = uploadResponse.data.data.id;
        console.log(`[Replace Image] Upload successful. File ID: ${fileId}`);
        
        res.json({ 
            success: true,
            fileId: fileId,
            filename: uploadResponse.data.data.filename_download
        });
    } catch (error) {
        console.error('[API /api/replace-image/upload-url] Error:', error.message);
        res.status(500).json({ 
            success: false,
            error: error.response?.data?.errors?.[0]?.message || error.message 
        });
    }
});

// Replace Image - Upload from local file
app.post('/api/replace-image/upload-file', async (req, res) => {
    try {
        const multer = require('multer');
        const FormData = require('form-data');
        const axios = require('axios');
        
        // Configure multer for memory storage
        const upload = multer({ storage: multer.memoryStorage() });
        
        // Use multer middleware
        upload.single('file')(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: err.message });
            }
            
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }
            
            try {
                const directusUrl = process.env.DIRECTUS_URL || 'http://localhost:8055';
                const directusToken = process.env.DIRECTUS_TOKEN;
                
                if (!directusToken) {
                    throw new Error('DIRECTUS_TOKEN not configured');
                }
                
                // Create form data for Directus
                const formData = new FormData();
                formData.append('file', req.file.buffer, {
                    filename: req.file.originalname,
                    contentType: req.file.mimetype
                });
                
                console.log(`[Replace Image] Uploading file: ${req.file.originalname}`);
                
                // Upload to Directus
                const uploadResponse = await axios.post(
                    `${directusUrl}/files`,
                    formData,
                    {
                        headers: {
                            'Authorization': `Bearer ${directusToken}`,
                            ...formData.getHeaders()
                        }
                    }
                );
                
                const fileId = uploadResponse.data.data.id;
                console.log(`[Replace Image] Upload successful. File ID: ${fileId}`);
                
                res.json({ 
                    success: true,
                    fileId: fileId,
                    filename: uploadResponse.data.data.filename_download
                });
            } catch (error) {
                console.error('[API /api/replace-image/upload-file] Upload error:', error.message);
                res.status(500).json({ 
                    success: false,
                    error: error.response?.data?.errors?.[0]?.message || error.message 
                });
            }
        });
    } catch (error) {
        console.error('[API /api/replace-image/upload-file] Error:', error.message);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

// Replace Image - Find and replace in database
app.post('/api/replace-image/replace', async (req, res) => {
    try {
        const { oldImageId, newImageId, tableName, fieldName } = req.body;
        
        if (!oldImageId || !newImageId || !tableName || !fieldName) {
            return res.status(400).json({ 
                error: 'Missing required parameters: oldImageId, newImageId, tableName, fieldName' 
            });
        }
        
        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(oldImageId) || !uuidRegex.test(newImageId)) {
            return res.status(400).json({ error: 'Invalid UUID format' });
        }
        
        // Sanitize table and field names (prevent SQL injection)
        const allowedTablePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
        if (!allowedTablePattern.test(tableName) || !allowedTablePattern.test(fieldName)) {
            return res.status(400).json({ error: 'Invalid table or field name' });
        }
        
        const db = await getDBClient();
        
        console.log(`[Replace Image] Searching for ${oldImageId} in ${tableName}.${fieldName}`);
        
        // Get all rows where the field contains the old image ID
        const selectQuery = `
            SELECT id, ${fieldName}
            FROM ${tableName}
            WHERE ${fieldName}::text LIKE $1
        `;
        
        const rows = await db.query(selectQuery, [`%${oldImageId}%`]);
        
        if (rows.rows.length === 0) {
            await db.end();
            return res.json({
                success: true,
                rowsUpdated: 0,
                occurrencesReplaced: 0,
                message: 'No rows found containing the old image ID'
            });
        }
        
        console.log(`[Replace Image] Found ${rows.rows.length} rows containing the old image ID`);
        
        let totalOccurrences = 0;
        let rowsUpdated = 0;
        
        // Process each row
        for (const row of rows.rows) {
            let fieldValue = row[fieldName];
            
            // Parse JSON if it's a string
            if (typeof fieldValue === 'string') {
                try {
                    fieldValue = JSON.parse(fieldValue);
                } catch (e) {
                    console.warn(`[Replace Image] Row ${row.id}: Field is not valid JSON, skipping`);
                    continue;
                }
            }
            
            // Recursively find and replace the old image ID
            let occurrences = 0;
            const replaceInObject = (obj) => {
                if (typeof obj !== 'object' || obj === null) return;
                
                for (const key in obj) {
                    if (obj[key] === oldImageId) {
                        obj[key] = newImageId;
                        occurrences++;
                    } else if (typeof obj[key] === 'object') {
                        replaceInObject(obj[key]);
                    }
                }
            };
            
            replaceInObject(fieldValue);
            
            if (occurrences > 0) {
                // Update the row
                const updateQuery = `
                    UPDATE ${tableName}
                    SET ${fieldName} = $1
                    WHERE id = $2
                `;
                
                await db.query(updateQuery, [JSON.stringify(fieldValue), row.id]);
                totalOccurrences += occurrences;
                rowsUpdated++;
                
                console.log(`[Replace Image] Row ${row.id}: Replaced ${occurrences} occurrence(s)`);
            }
        }
        
        await db.end();
        
        console.log(`[Replace Image] Complete: ${rowsUpdated} rows updated, ${totalOccurrences} occurrences replaced`);
        
        res.json({ 
            success: true,
            rowsUpdated: rowsUpdated,
            occurrencesReplaced: totalOccurrences
        });
    } catch (error) {
        console.error('[API /api/replace-image/replace] Error:', error.message);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});
