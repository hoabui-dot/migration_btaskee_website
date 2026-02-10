/**
 * WordPress to Directus Migration Script
 * 
 * Source Data: btaskee/data/wp/wp_posts.csv (WordPress database export)
 * Target: PostgreSQL (Directus CMS)
 * 
 * Features:
 * - Reads directly from wp_posts.csv (stream-based for large files >50MB)
 * - Extracts media URLs from post_content, imports via Directus /files/import API
 * - Converts WordPress HTML to TipTap JSON format for Directus
 * - Migration tracking with rollback support
 * - Clean command to remove migrated data
 * 
 * Usage: node migration.js [command]
 * Commands:
 *   migrate      - Run full migration (default)
 *   rollback     - Rollback last completed batch
 *   status       - Show migration status
 *   clean        - Clean only migrated data (based on tracking)
 *   clean-all    - Clean ALL data to prepare for fresh migration
 * 
 * Environment Variables:
 *   DIRECTUS_TOKEN  - Directus API token (required)
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormDataLib = require('form-data');
const { Client } = require('pg');
const { createReadStream } = require('fs');
const readline = require('readline');

// Configuration
const CONFIG = {
    // WordPress source
    WP_BASE_URL: process.env.WP_BASE_URL || 'https://www.btaskee.com',
    
    // Directus API
    DIRECTUS_URL: process.env.DIRECTUS_URL || 'http://localhost:8055',
    DIRECTUS_TOKEN: process.env.DIRECTUS_TOKEN,
    DIRECTUS_FOLDER_ID: null, // Will be set via --folder flag
    
    // Default author for migrated posts (will be set via --author-id and --author-name flags)
    AUTHOR_ID: null,
    AUTHOR_NAME: null,
    
    // Templates for collections (will be set via --post-template and --collection-template flags)
    POST_TEMPLATE_ID: null,
    COLLECTION_TEMPLATE_ID: null,
    
    // PostgreSQL - Main Directus Database
    PG_HOST: process.env.PG_HOST || 'localhost',
    PG_PORT: process.env.PG_PORT || 5433,
    PG_USER: process.env.PG_USER || 'directus',
    PG_PASSWORD: process.env.PG_PASSWORD || 'directus',
    PG_DATABASE: process.env.PG_DATABASE || 'directus',
    
    // PostgreSQL - Migration Tracking Database (separate)
    MIGRATION_PG_HOST: process.env.MIGRATION_PG_HOST || 'localhost',
    MIGRATION_PG_PORT: process.env.MIGRATION_PG_PORT || 5434,
    MIGRATION_PG_USER: process.env.MIGRATION_PG_USER || 'migration_user',
    MIGRATION_PG_PASSWORD: process.env.MIGRATION_PG_PASSWORD || 'migration_pass',
    MIGRATION_PG_DATABASE: process.env.MIGRATION_PG_DATABASE || 'migration_tracking',
    
    // Data files
    DATA_DIR: './data',
    
    // Batch settings
    BATCH_SIZE: parseInt(process.env.BATCH_SIZE) || 30,      // Items per batch
    PARALLEL_LIMIT: parseInt(process.env.PARALLEL_LIMIT) || 6, // Concurrent requests
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000
};

// Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Parse CSV line handling quoted fields with embedded quotes and newlines
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];
        
        if (inQuotes) {
            if (char === '"' && nextChar === '"') {
                // Escaped quote
                current += '"';
                i++;
            } else if (char === '"') {
                // End of quoted field
                inQuotes = false;
            } else {
                current += char;
            }
        } else {
            if (char === '"') {
                inQuotes = true;
            } else if (char === ',') {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }
    }
    result.push(current);
    return result;
}

// Stream-based CSV reader for large files (wp_posts.csv is >50MB)
async function* readWpPostsCSV(filePath, options = {}) {
    const { postType = 'post', postStatus = null, limit = 0 } = options;
    
    const fileStream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });
    
    let headers = null;
    let currentRecord = null;
    let currentField = '';
    let inQuotes = false;
    let fieldIndex = 0;
    let count = 0;
    
    for await (const line of rl) {
        if (!headers) {
            // First line is headers
            headers = parseCSVLine(line);
            continue;
        }
        
        // Handle multi-line fields (content with newlines)
        if (currentRecord) {
            // Continue building the current field
            currentField += '\n' + line;
            
            // Check if we've closed all quotes
            const quoteCount = (currentField.match(/"/g) || []).length;
            if (quoteCount % 2 === 0) {
                // Field is complete, parse the full record
                const fullLine = currentRecord.prefix + currentField + currentRecord.suffix;
                const values = parseCSVLine(fullLine);
                
                if (values.length === headers.length) {
                    const record = {};
                    headers.forEach((h, i) => record[h] = values[i]);
                    
                    // Filter by post_type and post_status
                    if (record.post_type === postType) {
                        if (!postStatus || record.post_status === postStatus) {
                            count++;
                            if (limit === 0 || count <= limit) {
                                yield record;
                            }
                            if (limit > 0 && count >= limit) {
                                rl.close();
                                return;
                            }
                        }
                    }
                }
                currentRecord = null;
                currentField = '';
            }
            continue;
        }
        
        // Try to parse as a complete line
        const values = parseCSVLine(line);
        
        if (values.length === headers.length) {
            // Complete record
            const record = {};
            headers.forEach((h, i) => record[h] = values[i]);
            
            // Filter by post_type and post_status
            if (record.post_type === postType) {
                if (!postStatus || record.post_status === postStatus) {
                    count++;
                    if (limit === 0 || count <= limit) {
                        yield record;
                    }
                    if (limit > 0 && count >= limit) {
                        rl.close();
                        return;
                    }
                }
            }
        } else if (values.length < headers.length) {
            // Incomplete record - likely has multi-line content
            // Store for continuation
            currentRecord = { prefix: '', suffix: '' };
            currentField = line;
        }
    }
}

// Load all posts from wp_posts.csv into memory (with limit)
async function loadWpPosts(options = {}) {
    const wpPostsFile = path.join(CONFIG.DATA_DIR, 'wp', 'wp_posts.csv');
    
    if (!fs.existsSync(wpPostsFile)) {
        log.warn(`wp_posts.csv not found at ${wpPostsFile}`);
        return [];
    }
    
    const posts = [];
    const limit = options.limit !== undefined ? options.limit : CONFIG.MIGRATION_LIMIT;
    
    log.info(`Loading posts from ${wpPostsFile} (limit: ${limit === 0 ? 'none' : limit})...`);
    
    for await (const post of readWpPostsCSV(wpPostsFile, { 
        postType: 'post', 
        postStatus: 'publish',
        limit 
    })) {
        posts.push(post);
    }
    
    log.info(`Loaded ${posts.length} posts from wp_posts.csv`);
    return posts;
}

const log = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    success: (msg) => console.log(`[SUCCESS] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`),
    warn: (msg) => console.warn(`[WARN] ${msg}`),
    progress: (current, total, msg) => console.log(`[${current}/${total}] ${msg}`),
};

// Database clients
let db = null;           // Main Directus database
let migrationDb = null;  // Migration tracking database

async function connectDB() {
    // Connect to main Directus database
    db = new Client({
        host: CONFIG.PG_HOST,
        port: CONFIG.PG_PORT,
        user: CONFIG.PG_USER,
        password: CONFIG.PG_PASSWORD,
        database: CONFIG.PG_DATABASE,
    });
    await db.connect();
    log.success(`Connected to Directus DB: ${CONFIG.PG_HOST}:${CONFIG.PG_PORT}/${CONFIG.PG_DATABASE}`);
    
    // Connect to migration tracking database
    migrationDb = new Client({
        host: CONFIG.MIGRATION_PG_HOST,
        port: CONFIG.MIGRATION_PG_PORT,
        user: CONFIG.MIGRATION_PG_USER,
        password: CONFIG.MIGRATION_PG_PASSWORD,
        database: CONFIG.MIGRATION_PG_DATABASE,
    });
    await migrationDb.connect();
    log.success(`Connected to Migration Tracking DB: ${CONFIG.MIGRATION_PG_HOST}:${CONFIG.MIGRATION_PG_PORT}/${CONFIG.MIGRATION_PG_DATABASE}`);
}

async function disconnectDB() {
    if (db) {
        await db.end();
        log.info('Disconnected from Directus DB');
    }
    if (migrationDb) {
        await migrationDb.end();
        log.info('Disconnected from Migration Tracking DB');
    }
}

// Migration tracking functions (use migrationDb for tracking tables)
async function createBatch(batchName, description = '') {
    const result = await migrationDb.query(
        `INSERT INTO migration_batch (batch_name, description, metadata) 
         VALUES ($1, $2, $3) RETURNING id`,
        [batchName, description, JSON.stringify({ started: new Date().toISOString() })]
    );
    return result.rows[0].id;
}

async function completeBatch(batchId, status = 'completed', errorMessage = null) {
    await migrationDb.query(
        `UPDATE migration_batch SET status = $1, completed_at = NOW(), error_message = $2 WHERE id = $3`,
        [status, errorMessage, batchId]
    );
}

async function trackMigration(batchId, tableName, oldId, newId, status, sourceData = null, errorMessage = null) {
    await migrationDb.query(
        `INSERT INTO migration_data (batch_id, table_name, old_id, new_id, status, source_data, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (table_name, old_id, batch_id) 
         DO UPDATE SET new_id = $4, status = $5, error_message = $7, updated_at = NOW()`,
        [batchId, tableName, String(oldId), newId ? String(newId) : null, status, 
         sourceData ? JSON.stringify(sourceData) : null, errorMessage]
    );
}

async function getMigratedId(tableName, oldId) {
    const result = await migrationDb.query(
        `SELECT new_id FROM migration_data 
         WHERE table_name = $1 AND old_id = $2 AND status = 'success'
         ORDER BY created_at DESC LIMIT 1`,
        [tableName, String(oldId)]
    );
    return result.rows[0]?.new_id || null;
}

async function isAlreadyMigrated(tableName, oldId) {
    const result = await migrationDb.query(
        `SELECT 1 FROM migration_data 
         WHERE table_name = $1 AND old_id = $2 AND status = 'success' LIMIT 1`,
        [tableName, String(oldId)]
    );
    return result.rows.length > 0;
}

// Import file to Directus via /files/import API
async function importFileToDirectus(url, title = null) {
    try {
        const response = await axios.post(
            `${CONFIG.DIRECTUS_URL}/files/import`,
            {
                url: url,
                data: {
                    folder: CONFIG.DIRECTUS_FOLDER_ID,
                    title: title || path.basename(url),
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${CONFIG.DIRECTUS_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                timeout: 120000, // 2 minutes for large files
            }
        );
        return response.data.data;
    } catch (error) {
        const errMsg = error.response?.data?.errors?.[0]?.message || error.message;
        throw new Error(`Import failed: ${errMsg} (url: ${url})`);
    }
}

// Extract all media URLs from WordPress content
function extractMediaUrls(content) {
    if (!content) return [];
    
    const urls = new Set();
    
    // First, unescape double quotes from WordPress CSV export
    // [caption id=""attachment_123""] becomes [caption id="attachment_123"]
    let cleanContent = content.replace(/""/g, '"');
    
    // Pattern 1: src="https://www.btaskee.com/wp-content/uploads/..."
    const srcPattern = /src=["'](https?:\/\/(?:www\.)?btaskee\.com\/wp-content\/uploads\/[^"']+)["']/gi;
    let match;
    while ((match = srcPattern.exec(cleanContent)) !== null) {
        urls.add(match[1]);
    }
    
    // Pattern 2: src="/wp-content/uploads/..." (relative URLs)
    const relativePattern = /src=["'](\/wp-content\/uploads\/[^"']+)["']/gi;
    while ((match = relativePattern.exec(cleanContent)) !== null) {
        urls.add(CONFIG.WP_BASE_URL + match[1]);
    }
    
    // Pattern 3: src="http://localhost:8000/wp-content/uploads/..."
    const localhostPattern = /src=["']http:\/\/localhost:\d+\/wp-content\/uploads\/([^"']+)["']/gi;
    while ((match = localhostPattern.exec(cleanContent)) !== null) {
        urls.add(`${CONFIG.WP_BASE_URL}/wp-content/uploads/${match[1]}`);
    }
    
    // Pattern 4: href for downloadable files
    const hrefPattern = /href=["'](https?:\/\/(?:www\.)?btaskee\.com\/wp-content\/uploads\/[^"']+)["']/gi;
    while ((match = hrefPattern.exec(cleanContent)) !== null) {
        urls.add(match[1]);
    }
    
    // Pattern 5: Inside [caption] shortcodes with escaped quotes
    // Matches: [caption ...]<img src="/wp-content/uploads/...">...[/caption]
    const captionPattern = /\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/gi;
    while ((match = captionPattern.exec(cleanContent)) !== null) {
        const captionContent = match[1];
        
        // Extract src from img tags inside caption
        const captionSrcPattern = /src=["'](\/wp-content\/uploads\/[^"']+)["']/gi;
        let srcMatch;
        while ((srcMatch = captionSrcPattern.exec(captionContent)) !== null) {
            urls.add(CONFIG.WP_BASE_URL + srcMatch[1]);
        }
        
        // Also check for full URLs in captions
        const captionFullPattern = /src=["'](https?:\/\/(?:www\.)?btaskee\.com\/wp-content\/uploads\/[^"']+)["']/gi;
        while ((srcMatch = captionFullPattern.exec(captionContent)) !== null) {
            urls.add(srcMatch[1]);
        }
    }
    
    // Pattern 6: Direct /wp-content/uploads/ paths without src attribute
    // Sometimes images are referenced directly in content
    const directPathPattern = /["'](\/wp-content\/uploads\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp|svg|pdf|doc|docx))["']/gi;
    while ((match = directPathPattern.exec(cleanContent)) !== null) {
        urls.add(CONFIG.WP_BASE_URL + match[1]);
    }
    
    return Array.from(urls);
}

// URL to UUID mapping cache (populated during migration)
const urlToUuidCache = new Map();

// Pre-process WordPress content: convert shortcodes to HTML
function preprocessWordPressContent(html) {
    if (!html) return html;
    
    let processed = html;
    
    // Convert [caption] shortcode to <figure>
    // Format: [caption id="attachment_XXX" align="aligncenter" width="640"]<img ...> Caption text[/caption]
    processed = processed.replace(
        /\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/gi,
        (match, inner) => {
            // Extract image tag
            const imgMatch = /<img[^>]+>/i.exec(inner);
            if (!imgMatch) return match;
            
            // Extract caption text (everything after the img tag)
            const captionText = inner.replace(/<img[^>]+>/i, '').trim();
            
            return `<figure>${imgMatch[0]}<figcaption>${captionText}</figcaption></figure>`;
        }
    );
    
    // Remove WordPress block comments
    processed = processed
        .replace(/<!--\s*wp:[^>]*-->/g, '')
        .replace(/<!--\s*\/wp:[^>]*-->/g, '');
    
    // Clean up escaped quotes in attributes (WordPress CSV export issue)
    processed = processed.replace(/""/g, '"');
    
    return processed.trim();
}

// Convert WordPress HTML to TipTap JSON format
function convertHtmlToTipTapJson(html) {
    if (!html) return null;
    
    // Pre-process WordPress shortcodes
    const cleanHtml = preprocessWordPressContent(html);
    
    const nodes = [];
    
    // Block-level elements pattern (expanded)
    const blockPattern = /<(p|h[1-6]|ul|ol|blockquote|figure|div|table|pre|hr)[^>]*>([\s\S]*?)<\/\1>|<(hr|br)\s*\/?>/gi;
    let lastIndex = 0;
    let match;
    
    while ((match = blockPattern.exec(cleanHtml)) !== null) {
        const tag = (match[1] || match[3] || '').toLowerCase();
        const innerHtml = match[2] || '';
        
        // Handle text/content before this block
        const textBefore = cleanHtml.slice(lastIndex, match.index).trim();
        if (textBefore) {
            // Check for standalone images or [caption] that weren't in blocks
            const standaloneNodes = parseStandaloneContent(textBefore);
            nodes.push(...standaloneNodes);
        }
        lastIndex = match.index + match[0].length;
        
        switch (tag) {
            case 'p':
                // Check if paragraph contains only an image
                const pImgOnly = /<img[^>]+>/i.exec(innerHtml);
                if (pImgOnly && innerHtml.replace(/<img[^>]+>/gi, '').trim() === '') {
                    nodes.push(createImageNodeFromImg(pImgOnly[0]));
                } else {
                    nodes.push(createParagraphNode(innerHtml));
                }
                break;
            case 'h1':
            case 'h2':
            case 'h3':
            case 'h4':
            case 'h5':
            case 'h6':
                nodes.push(createHeadingNode(innerHtml, parseInt(tag[1])));
                break;
            case 'ul':
            case 'ol':
                nodes.push(createListNode(innerHtml, tag === 'ol'));
                break;
            case 'blockquote':
                nodes.push(createBlockquoteNode(innerHtml));
                break;
            case 'figure':
                const imgNode = createImageNodeFromFigure(innerHtml);
                if (imgNode) nodes.push(imgNode);
                break;
            case 'table':
                nodes.push(createTableNode(innerHtml));
                break;
            case 'pre':
                nodes.push(createCodeBlockNode(innerHtml));
                break;
            case 'hr':
                nodes.push({ type: 'horizontalRule' });
                break;
            case 'div':
                // Recursively process div content
                const divNodes = parseBlockContent(innerHtml);
                nodes.push(...divNodes);
                break;
            default:
                nodes.push(createParagraphNode(innerHtml));
        }
    }
    
    // Handle remaining content
    const remaining = cleanHtml.slice(lastIndex).trim();
    if (remaining) {
        const remainingNodes = parseStandaloneContent(remaining);
        nodes.push(...remainingNodes);
    }
    
    // If no nodes were created, create a single paragraph
    if (nodes.length === 0 && cleanHtml) {
        nodes.push(createParagraphNode(cleanHtml));
    }
    
    return {
        type: 'doc',
        content: nodes.filter(n => n !== null)
    };
}

// Parse standalone content (images, text outside blocks)
function parseStandaloneContent(html) {
    const nodes = [];
    let remaining = html;
    
    // Find all standalone images
    const imgPattern = /<img[^>]+>/gi;
    let imgMatch;
    let lastIdx = 0;
    
    while ((imgMatch = imgPattern.exec(html)) !== null) {
        // Text before image
        const textBefore = html.slice(lastIdx, imgMatch.index).trim();
        if (textBefore && textBefore.replace(/<[^>]+>/g, '').trim()) {
            nodes.push(createParagraphNode(textBefore));
        }
        
        // Image node
        nodes.push(createImageNodeFromImg(imgMatch[0]));
        lastIdx = imgMatch.index + imgMatch[0].length;
    }
    
    // Remaining text after last image
    const textAfter = html.slice(lastIdx).trim();
    if (textAfter && textAfter.replace(/<[^>]+>/g, '').trim()) {
        nodes.push(createParagraphNode(textAfter));
    }
    
    return nodes.length > 0 ? nodes : [createParagraphNode(html)];
}

// Parse block content recursively
function parseBlockContent(html) {
    const result = convertHtmlToTipTapJson(html);
    return result ? result.content : [];
}

// Create image node from img tag
function createImageNodeFromImg(imgTag) {
    const srcMatch = /src=["']([^"']+)["']/i.exec(imgTag);
    const altMatch = /alt=["']([^"']*)["']/i.exec(imgTag);
    const widthMatch = /width=["']?(\d+)["']?/i.exec(imgTag);
    const heightMatch = /height=["']?(\d+)["']?/i.exec(imgTag);
    
    return createImageNode(
        srcMatch ? srcMatch[1] : '',
        altMatch ? altMatch[1] : '',
        null,
        widthMatch ? parseInt(widthMatch[1]) : null,
        heightMatch ? parseInt(heightMatch[1]) : null
    );
}

// Create code block node
function createCodeBlockNode(html) {
    const text = html.replace(/<[^>]+>/g, '').trim();
    return {
        type: 'codeBlock',
        attrs: { language: null },
        content: text ? [{ type: 'text', text }] : undefined
    };
}

// Helper: Create paragraph node
function createParagraphNode(html) {
    const textContent = parseInlineContent(html);
    return {
        type: 'paragraph',
        attrs: { textAlign: 'left' },
        content: textContent.length > 0 ? textContent : undefined
    };
}

// Helper: Create heading node
function createHeadingNode(html, level) {
    const textContent = parseInlineContent(html);
    return {
        type: 'heading',
        attrs: { textAlign: 'left', id: null, level },
        content: textContent.length > 0 ? textContent : undefined
    };
}

// Helper: Create list node
function createListNode(html, ordered) {
    const items = [];
    const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let match;
    while ((match = liPattern.exec(html)) !== null) {
        items.push({
            type: 'listItem',
            content: [{
                type: 'paragraph',
                attrs: { textAlign: 'left' },
                content: parseInlineContent(match[1])
            }]
        });
    }
    return {
        type: ordered ? 'orderedList' : 'bulletList',
        content: items
    };
}

// Helper: Create blockquote node
function createBlockquoteNode(html) {
    return {
        type: 'blockquote',
        content: [{
            type: 'paragraph',
            attrs: { textAlign: 'left' },
            content: parseInlineContent(html)
        }]
    };
}

// Helper: Create image node from figure
function createImageNodeFromFigure(html) {
    const imgMatch = /<img[^>]+src=["']([^"']+)["'][^>]*>/i.exec(html);
    if (!imgMatch) return null;
    
    const src = imgMatch[1];
    const altMatch = /alt=["']([^"']*)["']/i.exec(imgMatch[0]);
    const alt = altMatch ? altMatch[1] : '';
    
    // Extract width/height
    const widthMatch = /width=["']?(\d+)["']?/i.exec(imgMatch[0]);
    const heightMatch = /height=["']?(\d+)["']?/i.exec(imgMatch[0]);
    const width = widthMatch ? parseInt(widthMatch[1]) : null;
    const height = heightMatch ? parseInt(heightMatch[1]) : null;
    
    // Extract caption
    const captionMatch = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i.exec(html);
    const caption = captionMatch ? captionMatch[1].replace(/<[^>]+>/g, '').trim() : null;
    
    return createImageNode(src, alt, caption, width, height);
}

// Helper: Create image node
function createImageNode(src, alt = '', caption = null, width = null, height = null) {
    return {
        type: 'image',
        attrs: {
            src: src,
            alt: alt || '',
            subCaption: caption,
            withCaption: !!caption,
            fixed: false,
            captionDisplayOption: 'inner',
            width: width,
            height: height
        }
    };
}

// Helper: Create table node
function createTableNode(html) {
    const rows = [];
    const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    while ((trMatch = trPattern.exec(html)) !== null) {
        const cells = [];
        const cellPattern = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi;
        let cellMatch;
        while ((cellMatch = cellPattern.exec(trMatch[1])) !== null) {
            cells.push({
                type: cellMatch[1] === 'th' ? 'tableHeader' : 'tableCell',
                content: [{
                    type: 'paragraph',
                    content: parseInlineContent(cellMatch[2])
                }]
            });
        }
        if (cells.length > 0) {
            rows.push({ type: 'tableRow', content: cells });
        }
    }
    return { type: 'table', content: rows };
}

// Helper: Parse inline content (bold, italic, links, span, sup, cite, etc.)
function parseInlineContent(html) {
    if (!html) return [];
    
    const content = [];
    let text = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#8217;/g, "'")
        .replace(/&#8220;/g, '"')
        .replace(/&#8221;/g, '"')
        .replace(/&#8211;/g, '–')
        .replace(/&#8230;/g, '…');
    
    // Recursive function to parse inline elements with marks
    function parseWithMarks(htmlStr, inheritedMarks = []) {
        if (!htmlStr) return;
        
        // Pattern to match inline elements
        const inlinePattern = /<(a|strong|b|em|i|span|sup|sub|cite|u|s|code)[^>]*>([\s\S]*?)<\/\1>|([^<]+)|<[^>]+>/gi;
        let match;
        
        while ((match = inlinePattern.exec(htmlStr)) !== null) {
            const tag = match[1]?.toLowerCase();
            const innerHtml = match[2];
            const plainText = match[3];
            
            if (plainText) {
                // Plain text - add with inherited marks
                const trimmed = plainText;
                if (trimmed) {
                    const node = { type: 'text', text: trimmed };
                    if (inheritedMarks.length > 0) {
                        node.marks = [...inheritedMarks];
                    }
                    content.push(node);
                }
            } else if (tag && innerHtml !== undefined) {
                // Tagged content
                let newMarks = [...inheritedMarks];
                
                switch (tag) {
                    case 'a':
                        // Extract href
                        const hrefMatch = /href=["']([^"']+)["']/i.exec(match[0]);
                        if (hrefMatch) {
                            newMarks.push({ type: 'link', attrs: { href: hrefMatch[1], target: '_blank' } });
                        }
                        break;
                    case 'strong':
                    case 'b':
                        newMarks.push({ type: 'bold' });
                        break;
                    case 'em':
                    case 'i':
                    case 'cite':
                        newMarks.push({ type: 'italic' });
                        break;
                    case 'u':
                        newMarks.push({ type: 'underline' });
                        break;
                    case 's':
                        newMarks.push({ type: 'strike' });
                        break;
                    case 'sup':
                        newMarks.push({ type: 'superscript' });
                        break;
                    case 'sub':
                        newMarks.push({ type: 'subscript' });
                        break;
                    case 'code':
                        newMarks.push({ type: 'code' });
                        break;
                    case 'span':
                        // Span usually just passes through, check for style
                        const styleMatch = /style=["']([^"']+)["']/i.exec(match[0]);
                        if (styleMatch) {
                            const style = styleMatch[1];
                            if (/font-weight:\s*bold/i.test(style)) {
                                newMarks.push({ type: 'bold' });
                            }
                            if (/font-style:\s*italic/i.test(style)) {
                                newMarks.push({ type: 'italic' });
                            }
                            if (/text-decoration:\s*underline/i.test(style)) {
                                newMarks.push({ type: 'underline' });
                            }
                        }
                        break;
                }
                
                // Recursively parse inner content
                parseWithMarks(innerHtml, newMarks);
            }
            // Other tags (like <img>, <br>) are ignored in inline context
        }
    }
    
    parseWithMarks(text);
    
    // Clean up: merge adjacent text nodes with same marks, remove empty nodes
    const cleaned = [];
    for (const node of content) {
        if (!node.text || node.text.length === 0) continue;
        
        const lastNode = cleaned[cleaned.length - 1];
        if (lastNode && 
            JSON.stringify(lastNode.marks || []) === JSON.stringify(node.marks || [])) {
            // Merge with previous node
            lastNode.text += node.text;
        } else {
            cleaned.push(node);
        }
    }
    
    return cleaned;
}

// Replace WordPress URLs with Directus UUIDs in TipTap JSON
function replaceUrlsInTipTapJson(tiptapJson, urlToUuidMap) {
    if (!tiptapJson || !tiptapJson.content) return tiptapJson;
    
    function processNode(node) {
        if (!node) return node;
        
        // Replace URLs in image nodes
        if (node.type === 'image' && node.attrs && node.attrs.src) {
            const src = node.attrs.src;
            
            // Check if it's a WordPress URL
            if (src.startsWith('/wp-content/uploads/')) {
                const fullUrl = CONFIG.WP_BASE_URL + src;
                const uuid = urlToUuidMap.get(fullUrl);
                if (uuid) {
                    node.attrs.src = `/assets/${uuid}`;
                }
            } else if (src.includes('/wp-content/uploads/')) {
                // Full URL
                const uuid = urlToUuidMap.get(src);
                if (uuid) {
                    node.attrs.src = `/assets/${uuid}`;
                }
            }
        }
        
        // Recursively process content
        if (node.content && Array.isArray(node.content)) {
            node.content = node.content.map(processNode);
        }
        
        return node;
    }
    
    // Process all content nodes
    const processedJson = {
        ...tiptapJson,
        content: tiptapJson.content.map(processNode)
    };
    
    return processedJson;
}

// Build TipTap JSON with both json and html parts
function buildTipTapContent(html, tiptapJson) {
    return JSON.stringify({
        json: tiptapJson,
        html: html,
        lastSaved: Date.now()
    });
}

// Map post status
function mapPostStatus(wpStatus) {
    const statusMap = {
        'publish': 'published',
        'draft': 'draft',
        'pending': 'draft',
        'private': 'draft',
        'trash': 'archived',
    };
    return statusMap[wpStatus] || 'draft';
}

// Import a single media URL to Directus (with caching and tracking)
async function importMediaUrl(batchId, url) {
    // Check cache first
    if (urlToUuidCache.has(url)) {
        return urlToUuidCache.get(url);
    }
    
    // Check if already migrated
    const existingUuid = await getMigratedId('directus_files', url);
    if (existingUuid) {
        urlToUuidCache.set(url, existingUuid);
        return existingUuid;
    }
    
    // Import to Directus
    try {
        const filename = path.basename(url.split('?')[0]);
        const result = await importFileToDirectus(url, filename);
        
        // Track migration
        await trackMigration(batchId, 'directus_files', url, result.id, 'success', { url });
        
        // Cache the mapping
        urlToUuidCache.set(url, result.id);
        
        log.success(`Imported: ${filename} → ${result.id}`);
        return result.id;
        
    } catch (error) {
        await trackMigration(batchId, 'directus_files', url, null, 'failed', { url }, error.message);
        log.warn(`Failed to import ${url}: ${error.message}`);
        return null;
    }
}

// Detect language from text
function detectLanguage(text) {
    // Thai characters (Unicode range: 0E00-0E7F)
    const thaiPattern = /[\u0E00-\u0E7F]/;
    if (thaiPattern.test(text)) {
        return 'th-TH';
    }
    
    // Vietnamese characters (with diacritics)
    const vietnamesePattern = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
    if (vietnamesePattern.test(text)) {
        return 'vi-VN';
    }
    
    // Check if text is purely ASCII (likely English)
    // But exclude common Vietnamese words written without diacritics
    const vietnameseWords = /\b(nha|cua|viec|giup|don|dep|ve|sinh|may|lanh|giat|ui|nau|an|gia|dinh|theo|gio|dich|vu|khach|hang|cong|dong|btasker|btaskee|khuyen|mai|thong|cao|bao|chi|tuyen|dung|meo|vat|thu|cung|cach|su|dung|khac|van|chuyen|ngay|le|mon|ngon|thuc|don|van|phong|mua|sam)\b/i;
    if (vietnameseWords.test(text)) {
        return 'vi-VN';
    }
    
    // Default to English if no Vietnamese/Thai detected
    return 'en-VN';
}

// Migrate a single WordPress post: upload images, create post, create post_translations
async function migrateSingleWpPost(batchId, post, postCategoryMapping) {
    const postId = post.ID;
    const oldId = String(postId);
    
    // Check if already migrated
    if (await isAlreadyMigrated('post', oldId)) {
        return { status: 'skipped', postId };
    }
    
    try {
        // Step 1: Extract and import all media URLs from post_content
        const mediaUrls = extractMediaUrls(post.post_content);
        let thumbnailUuid = null;
        
        for (const url of mediaUrls) {
            const uuid = await importMediaUrl(batchId, url);
            if (uuid && !thumbnailUuid) {
                thumbnailUuid = uuid; // First image becomes thumbnail
            }
        }
        
        // Step 2: Transform content - replace URLs with /assets/{uuid}
        let transformedHtml = post.post_content || '';
        for (const [url, uuid] of urlToUuidCache.entries()) {
            if (transformedHtml.includes(url)) {
                const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                transformedHtml = transformedHtml.replace(new RegExp(escapedUrl, 'g'), `/assets/${uuid}`);
            }
        }
        // Handle localhost URLs
        transformedHtml = transformedHtml.replace(
            /http:\/\/localhost:\d+\/wp-content\/uploads\/([^"'\s]+)/g,
            (match, filepath) => {
                const fullUrl = `${CONFIG.WP_BASE_URL}/wp-content/uploads/${filepath}`;
                const uuid = urlToUuidCache.get(fullUrl);
                return uuid ? `/assets/${uuid}` : match;
            }
        );
        
        // Step 3: Convert HTML to TipTap JSON
        let tiptapJson = convertHtmlToTipTapJson(transformedHtml);
        
        // Step 3.5: Replace WordPress URLs with Directus UUIDs in TipTap JSON
        tiptapJson = replaceUrlsInTipTapJson(tiptapJson, urlToUuidCache);
        
        const contentJson = buildTipTapContent(transformedHtml, tiptapJson);
        
        // Step 4: Get metadata
        const status = mapPostStatus(post.post_status);
        const publishDate = post.post_date ? new Date(post.post_date) : null;
        const dateCreated = post.post_date ? new Date(post.post_date) : new Date();
        const dateUpdated = post.post_modified ? new Date(post.post_modified) : null;
        
        // Get collection ID from post_category.json mapping
        let collectionId = postCategoryMapping.get(post.post_name) || null;
        
        // Validate that collection exists in database (important when using --limit)
        if (collectionId) {
            const collectionCheck = await db.query(
                `SELECT id FROM collection WHERE id = $1`,
                [collectionId]
            );
            if (collectionCheck.rows.length === 0) {
                log.warn(`  ⚠️  Collection ${collectionId} not found in database, setting to NULL`);
                collectionId = null;
            }
        }
        
        // Detect language from post content (independent of collection)
        const langCode = detectLanguage(post.post_title || post.post_name);
        
        // Step 5: Insert post
        await db.query(
            `INSERT INTO post (id, status, thumbnail, publish_date, date_created, date_updated, collection, author, author_name, user_created)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO UPDATE SET 
                status = EXCLUDED.status,
                thumbnail = EXCLUDED.thumbnail,
                publish_date = EXCLUDED.publish_date,
                date_updated = EXCLUDED.date_updated,
                collection = EXCLUDED.collection,
                author = EXCLUDED.author,
                author_name = EXCLUDED.author_name,
                user_created = EXCLUDED.user_created`,
            [postId, status, thumbnailUuid, publishDate, dateCreated, dateUpdated, collectionId, CONFIG.AUTHOR_ID, CONFIG.AUTHOR_NAME, CONFIG.AUTHOR_ID]
        );
        
        // Step 6: Insert post_translations
        await db.query(
            `INSERT INTO post_translations (post_id, languages_code, title, description, content, slug)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (post_id, languages_code) DO UPDATE SET
                title = EXCLUDED.title,
                description = EXCLUDED.description,
                content = EXCLUDED.content,
                slug = EXCLUDED.slug`,
            [postId, langCode, post.post_title, post.post_excerpt, contentJson, post.post_name]
        );
        
        // Track migration
        await trackMigration(batchId, 'post', oldId, postId, 'success', {
            ID: postId,
            post_name: post.post_name,
            thumbnail: thumbnailUuid,
            collection: collectionId,
            imagesImported: mediaUrls.length
        });
        
        return { status: 'success', postId, imagesImported: mediaUrls.length };
        
    } catch (error) {
        await trackMigration(batchId, 'post', oldId, null, 'failed', { ID: postId }, error.message);
        return { status: 'failed', postId, error: error.message };
    }
}

// Migrate WordPress posts (combined: upload images + create post + create post_translations)
// Uses streaming and batch processing to avoid memory issues
async function migrateWpPosts(batchId, migrationLimit = 0) {
    log.info('=== Migrating WordPress Posts (from wp_posts.csv) ===');
    log.info('Combined: Upload images → Create post → Create post_translations');
    log.info('Processing in batches to optimize memory usage');
    
    const wpPostsFile = path.join(CONFIG.DATA_DIR, 'wp', 'wp_posts.csv');
    if (!fs.existsSync(wpPostsFile)) {
        log.warn('wp_posts.csv not found, skipping');
        return;
    }
    
    const postCategoryMapping = loadPostCategoryMapping();
    const BATCH_SIZE = CONFIG.BATCH_SIZE || 30; // Process 30 posts at a time
    
    let success = 0, skipped = 0, failed = 0;
    let totalImages = 0;
    let totalProcessed = 0;
    let currentBatch = [];
    
    // First, count total posts to process
    let totalPosts = 0;
    for await (const post of readWpPostsCSV(wpPostsFile, { 
        postType: 'post', 
        postStatus: 'publish',
        limit: migrationLimit 
    })) {
        totalPosts++;
    }
    
    if (totalPosts === 0) {
        log.warn('No posts found in wp_posts.csv, skipping');
        return;
    }
    
    log.info(`Found ${totalPosts} posts to migrate`);
    log.info(`Batch size: ${BATCH_SIZE} posts per batch`);
    
    // Calculate total batches
    const totalBatches = Math.ceil(totalPosts / BATCH_SIZE);
    let currentBatchNumber = 0;
    
    // Process posts in batches using streaming
    for await (const post of readWpPostsCSV(wpPostsFile, { 
        postType: 'post', 
        postStatus: 'publish',
        limit: migrationLimit 
    })) {
        currentBatch.push(post);
        
        // Process batch when it reaches BATCH_SIZE or it's the last post
        if (currentBatch.length >= BATCH_SIZE || totalProcessed + currentBatch.length >= totalPosts) {
            currentBatchNumber++;
            const batchStart = totalProcessed + 1;
            const batchEnd = totalProcessed + currentBatch.length;
            
            log.info(`╔═══════════════════════════════════════════════════════════╗`);
            log.info(`║ BATCH ${currentBatchNumber}/${totalBatches}: Processing posts ${batchStart}-${batchEnd} of ${totalPosts}`);
            log.info(`╚═══════════════════════════════════════════════════════════╝`);
            
            const batchStartTime = Date.now();
            let batchSuccess = 0, batchSkipped = 0, batchFailed = 0;
            
            // Process current batch
            for (let i = 0; i < currentBatch.length; i++) {
                const batchPost = currentBatch[i];
                
                // Log which post we're processing
                log.info(`  → Processing post ${totalProcessed + 1}/${totalPosts}: ID ${batchPost.ID} - "${batchPost.post_title}"`);
                
                const result = await migrateSingleWpPost(batchId, batchPost, postCategoryMapping);
                
                if (result.status === 'success') {
                    success++;
                    batchSuccess++;
                    totalImages += result.imagesImported || 0;
                    log.success(`  ✓ Post ${batchPost.ID} migrated successfully (${result.imagesImported || 0} images)`);
                } else if (result.status === 'skipped') {
                    skipped++;
                    batchSkipped++;
                    log.warn(`  ⊘ Post ${batchPost.ID} skipped (already migrated)`);
                } else {
                    failed++;
                    batchFailed++;
                    log.error(`  ✗ Post ${batchPost.ID} failed: ${result.error}`);
                }
                
                totalProcessed++;
                
                // Log progress after EVERY item for real-time updates
                log.progress(totalProcessed, totalPosts, `Posts: ${success} success, ${skipped} skipped, ${failed} failed`);
            }
            
            const batchDuration = ((Date.now() - batchStartTime) / 1000).toFixed(2);
            
            log.info(`╔═══════════════════════════════════════════════════════════╗`);
            log.info(`║ BATCH ${currentBatchNumber}/${totalBatches} COMPLETED in ${batchDuration}s`);
            log.info(`║ Batch Results: ${batchSuccess} success, ${batchSkipped} skipped, ${batchFailed} failed`);
            log.info(`║ Overall Progress: ${totalProcessed}/${totalPosts} (${((totalProcessed/totalPosts)*100).toFixed(1)}%)`);
            log.info(`╚═══════════════════════════════════════════════════════════╝`);
            
            // Clear batch and force garbage collection hint
            currentBatch = [];
            if (global.gc) {
                global.gc();
                log.info(`  🗑️  Memory cleanup triggered`);
            }
            
            // Small delay between batches to allow memory cleanup
            if (currentBatchNumber < totalBatches) {
                log.info(`  ⏸️  Pausing 100ms before next batch...`);
                await sleep(100);
            }
        }
    }
    
    log.info(`Posts: ${success} success, ${skipped} skipped, ${failed} failed`);
    log.info(`Total images imported: ${totalImages}`);
    log.info(`URL to UUID cache size: ${urlToUuidCache.size}`);
}

// Migrate tags
async function migrateTags(batchId, migrationLimit = 0) {
    log.info('=== Migrating Tags ===');
    
    const tagsFile = path.join(CONFIG.DATA_DIR, 'directus_tags.json');
    if (!fs.existsSync(tagsFile)) {
        log.warn('directus_tags.json not found, skipping');
        return;
    }
    
    let tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8'));
    if (migrationLimit > 0) {
        tags = tags.slice(0, migrationLimit);
        log.info(`Limited to ${migrationLimit} tags`);
    }
    log.info(`Processing ${tags.length} tags`);
    
    let success = 0, skipped = 0, failed = 0;
    let processed = 0;
    
    for (const tag of tags) {
        const oldId = String(tag.tag_id);
        
        if (await isAlreadyMigrated('tag', oldId)) {
            skipped++;
        } else {
            try {
                // Insert into tag table
                await db.query(
                    `INSERT INTO tag (id) VALUES ($1) 
                     ON CONFLICT (id) DO NOTHING`,
                    [tag.tag_id]
                );
                
                await trackMigration(batchId, 'tag', oldId, tag.tag_id, 'success', tag);
                success++;
                
            } catch (error) {
                failed++;
                await trackMigration(batchId, 'tag', oldId, null, 'failed', tag, error.message);
                log.error(`Failed tag ${oldId}: ${error.message}`);
            }
        }
        
        // Log progress after EVERY item for real-time updates
        processed++;
        log.progress(processed, tags.length, `Tags: ${success} success, ${skipped} skipped, ${failed} failed`);
    }
    
    log.info(`Tags: ${success} success, ${skipped} skipped, ${failed} failed`);
}

// Migrate tag translations
async function migrateTagTranslations(batchId, migrationLimit = 0) {
    log.info('=== Migrating Tag Translations ===');
    
    const tagsFile = path.join(CONFIG.DATA_DIR, 'directus_tags.json');
    if (!fs.existsSync(tagsFile)) return;
    
    let tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8'));
    if (migrationLimit > 0) tags = tags.slice(0, migrationLimit);
    let success = 0, failed = 0, skipped = 0;
    let processed = 0;
    
    for (const tag of tags) {
        const oldId = `${tag.tag_id}_vi-VN`;
        
        if (await isAlreadyMigrated('tag_translations', oldId)) {
            skipped++;
        } else {
            try {
                const result = await db.query(
                    `INSERT INTO tag_translations (tag_id, languages_code, name, slug)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT DO NOTHING RETURNING id`,
                    [tag.tag_id, 'vi-VN', tag.name, tag.slug]
                );
                
                if (result.rows[0]) {
                    await trackMigration(batchId, 'tag_translations', oldId, result.rows[0].id, 'success', tag);
                    success++;
                }
            } catch (error) {
                failed++;
                await trackMigration(batchId, 'tag_translations', oldId, null, 'failed', tag, error.message);
            }
        }
        
        // Log progress after EVERY item for real-time updates
        processed++;
        log.progress(processed, tags.length, `Tag Translations: ${success} success, ${skipped} skipped, ${failed} failed`);
    }
    
    log.info(`Tag Translations: ${success} success, ${skipped} skipped, ${failed} failed`);
}

// Migrate categories (collections)
async function migrateCategories(batchId, migrationLimit = 0) {
    log.info('=== Migrating Categories ===');
    
    const categoryFile = path.join(CONFIG.DATA_DIR, 'category.json');
    if (!fs.existsSync(categoryFile)) {
        log.warn('category.json not found, skipping');
        return;
    }
    
    const categories = JSON.parse(fs.readFileSync(categoryFile, 'utf8'));
    const uniqueCategories = new Map();
    
    // Deduplicate by id
    for (const [name, data] of Object.entries(categories)) {
        if (!uniqueCategories.has(data.id)) {
            uniqueCategories.set(data.id, { id: data.id, name, priority: data.priority });
        }
    }
    
    // Get templates from CONFIG (must be set via command-line flags)
    const postTemplateId = CONFIG.POST_TEMPLATE_ID;
    const collectionTemplateId = CONFIG.COLLECTION_TEMPLATE_ID;
    
    if (!postTemplateId || !collectionTemplateId) {
        throw new Error('POST_TEMPLATE_ID and COLLECTION_TEMPLATE_ID must be provided via --post-template and --collection-template flags');
    }
    
    let categoriesToProcess = Array.from(uniqueCategories.entries());
    if (migrationLimit > 0) {
        categoriesToProcess = categoriesToProcess.slice(0, migrationLimit);
        log.info(`Limited to ${migrationLimit} categories`);
    }
    log.info(`Processing ${categoriesToProcess.length} categories`);
    
    let success = 0, skipped = 0, failed = 0;
    let processed = 0;
    
    for (const [id, cat] of categoriesToProcess) {
        const oldId = String(id);
        
        if (await isAlreadyMigrated('collection', oldId)) {
            skipped++;
        } else {
            try {
                await db.query(
                    `INSERT INTO collection (id, sort, is_visible, template, post_template) 
                     VALUES ($1, $2, true, $3, $4)
                     ON CONFLICT (id) DO UPDATE SET
                        sort = EXCLUDED.sort,
                        is_visible = EXCLUDED.is_visible,
                        template = EXCLUDED.template,
                        post_template = EXCLUDED.post_template`,
                    [id, cat.priority, collectionTemplateId, postTemplateId]
                );
                
                await trackMigration(batchId, 'collection', oldId, id, 'success', cat);
                success++;
                
            } catch (error) {
                failed++;
                await trackMigration(batchId, 'collection', oldId, null, 'failed', cat, error.message);
                log.error(`Failed collection ${id}: ${error.message}`);
            }
        }
        
        // Log progress after EVERY item for real-time updates
        processed++;
        log.progress(processed, categoriesToProcess.length, `Categories: ${success} success, ${skipped} skipped, ${failed} failed`);
    }
    
    log.info(`Categories: ${success} success, ${skipped} skipped, ${failed} failed`);
    log.info(`All collections set with post_template = ${postTemplateId}`);
}

// Migrate category translations
async function migrateCategoryTranslations(batchId) {
    log.info('=== Migrating Category Translations ===');
    
    const categoryFile = path.join(CONFIG.DATA_DIR, 'category.json');
    if (!fs.existsSync(categoryFile)) return;
    
    const categories = JSON.parse(fs.readFileSync(categoryFile, 'utf8'));
    const categoryEntries = Object.entries(categories);
    let success = 0, failed = 0, skipped = 0;
    let processed = 0;
    
    // Track language distribution
    const langStats = { 'vi-VN': 0, 'en-VN': 0, 'th-TH': 0 };
    
    for (const [name, data] of categoryEntries) {
        // Detect language from category name
        const langCode = detectLanguage(name);
        langStats[langCode]++;
        
        const oldId = `${data.id}_${langCode}_${name}`;
        
        if (await isAlreadyMigrated('collection_translations', oldId)) {
            skipped++;
        } else {
            try {
                // IMPORTANT: Check if collection exists before inserting translation
                const collectionCheck = await db.query(
                    `SELECT id FROM collection WHERE id = $1`,
                    [data.id]
                );
                
                if (collectionCheck.rows.length === 0) {
                    log.warn(`  ⚠️  Collection ${data.id} not found, skipping translation for "${name}"`);
                    skipped++;
                    processed++;
                    continue;
                }
                
                // Generate slug from name
                const slug = name.toLowerCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '');
                
                const result = await db.query(
                    `INSERT INTO collection_translations (collection_id, languages_code, name, slug)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT DO NOTHING RETURNING id`,
                    [data.id, langCode, name, slug]
                );
                
                if (result.rows[0]) {
                    await trackMigration(batchId, 'collection_translations', oldId, result.rows[0].id, 'success', { name, langCode, ...data });
                    success++;
                }
            } catch (error) {
                failed++;
                await trackMigration(batchId, 'collection_translations', oldId, null, 'failed', { name, langCode, ...data }, error.message);
                log.error(`Failed [${langCode}] ${name}: ${error.message}`);
            }
        }
        
        // Log progress after EVERY item for real-time updates
        processed++;
        log.progress(processed, categoryEntries.length, `Category Translations: ${success} success, ${skipped} skipped, ${failed} failed`);
    }
    
    log.info(`Category Translations: ${success} success, ${skipped} skipped, ${failed} failed`);
    log.info(`Language distribution: vi-VN=${langStats['vi-VN']}, en-VN=${langStats['en-VN']}, th-TH=${langStats['th-TH']}`);
}

// Load post-category mapping
function loadPostCategoryMapping() {
    const postCategoryFile = path.join(CONFIG.DATA_DIR, 'post_category.json');
    if (!fs.existsSync(postCategoryFile)) return new Map();
    
    const data = JSON.parse(fs.readFileSync(postCategoryFile, 'utf8'));
    const mapping = new Map();
    for (const item of data) {
        mapping.set(item.post_name, item.category_id);
    }
    return mapping;
}

// Migrate post tags junction
async function migratePostTags(batchId, migrationLimit = 0) {
    log.info('=== Migrating Post Tags ===');
    
    const postTagsFile = path.join(CONFIG.DATA_DIR, 'post_tags.json');
    if (!fs.existsSync(postTagsFile)) {
        log.warn('post_tags.json not found, skipping');
        return;
    }
    
    let postTags = JSON.parse(fs.readFileSync(postTagsFile, 'utf8'));
    
    // Check if this is tag translations data or actual post-tag junction
    if (postTags.length > 0 && postTags[0].languages_id) {
        log.warn('post_tags.json contains tag translations, not junction data. Skipping.');
        return;
    }
    
    if (migrationLimit > 0) {
        postTags = postTags.slice(0, migrationLimit);
        log.info(`Limited to ${migrationLimit} post tags`);
    }
    
    let success = 0, failed = 0, skipped = 0;
    let processed = 0;
    
    for (const pt of postTags) {
        if (!pt.post_id || !pt.tag_id) {
            skipped++;
            processed++;
            continue;
        }
        
        const oldId = `${pt.post_id}_${pt.tag_id}`;
        
        if (await isAlreadyMigrated('post_tag', oldId)) {
            skipped++;
        } else {
            try {
                const result = await db.query(
                    `INSERT INTO post_tag (post_id, tag_id)
                     VALUES ($1, $2)
                     ON CONFLICT DO NOTHING RETURNING id`,
                    [pt.post_id, pt.tag_id]
                );
                
                if (result.rows[0]) {
                    await trackMigration(batchId, 'post_tag', oldId, result.rows[0].id, 'success', pt);
                    success++;
                }
            } catch (error) {
                failed++;
                await trackMigration(batchId, 'post_tag', oldId, null, 'failed', pt, error.message);
            }
        }
        
        // Log progress after EVERY item for real-time updates
        processed++;
        log.progress(processed, postTags.length, `Post Tags: ${success} success, ${skipped} skipped, ${failed} failed`);
    }
    
    log.info(`Post Tags: ${success} success, ${skipped} skipped, ${failed} failed`);
}

// ============================================
// CLEAN COMMAND - Remove all migrated data
// ============================================
async function cleanMigratedData() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║       CLEAN MIGRATED DATA                                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    log.warn('This will DELETE all migrated data from the database!');
    log.info('Tables to clean: post_translations, post_tag, post, tag_translations, tag, collection_translations, collection');
    log.info('Note: directus_files (uploaded media) will NOT be deleted');
    
    // Delete in reverse order of dependencies
    const cleanupOrder = [
        { table: 'post_translations', fk: 'post_id', parent: 'post' },
        { table: 'post_tag', fk: 'post_id', parent: 'post' },
        { table: 'post', condition: 'id IN (SELECT CAST(new_id AS INTEGER) FROM migration_data WHERE table_name = \'post\' AND status = \'success\')' },
        { table: 'tag_translations', fk: 'tag_id', parent: 'tag' },
        { table: 'tag', condition: 'id IN (SELECT CAST(new_id AS INTEGER) FROM migration_data WHERE table_name = \'tag\' AND status = \'success\')' },
        { table: 'collection_translations', fk: 'collection_id', parent: 'collection' },
        { table: 'collection', condition: 'id IN (SELECT CAST(new_id AS INTEGER) FROM migration_data WHERE table_name = \'collection\' AND status = \'success\')' },
    ];
    
    try {
        // Clean tables based on migration tracking
        for (const item of cleanupOrder) {
            log.info(`Cleaning ${item.table}...`);
            
            try {
                let result;
                if (item.condition) {
                    // Get IDs from migration tracking
                    const tableName = item.table;
                    const migratedIds = await migrationDb.query(`
                        SELECT new_id FROM migration_data 
                        WHERE table_name = $1 AND status = 'success'
                    `, [tableName]);
                    const ids = migratedIds.rows.map(r => parseInt(r.new_id));
                    
                    if (ids.length > 0) {
                        result = await db.query(`
                            DELETE FROM ${item.table} WHERE id = ANY($1::int[]) RETURNING id
                        `, [ids]);
                    }
                } else if (item.fk && item.parent) {
                    // Get parent IDs from migration tracking
                    const parentIds = await migrationDb.query(`
                        SELECT new_id FROM migration_data 
                        WHERE table_name = $1 AND status = 'success'
                    `, [item.parent]);
                    const ids = parentIds.rows.map(r => parseInt(r.new_id));
                    
                    if (ids.length > 0) {
                        result = await db.query(`
                            DELETE FROM ${item.table} WHERE ${item.fk} = ANY($1::int[]) RETURNING id
                        `, [ids]);
                    }
                }
                
                if (result) {
                    log.success(`Deleted ${result.rowCount} rows from ${item.table}`);
                }
            } catch (err) {
                log.warn(`Could not clean ${item.table}: ${err.message}`);
            }
        }
        
        // 3. Clean migration tracking tables
        log.info('Cleaning migration tracking data...');
        await migrationDb.query('DELETE FROM migration_data');
        await migrationDb.query('DELETE FROM migration_batch');
        log.success('Cleaned migration tracking tables');
        
        log.success('\n✓ All migrated data has been cleaned!');
        
    } catch (error) {
        log.error(`Clean failed: ${error.message}`);
        throw error;
    }
}

// Clean ALL data to prepare for fresh migration
async function cleanAll() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║       CLEAN ALL DATA (Prepare for Migration)                ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    log.warn('This will DELETE ALL data: posts, tags, categories, and files!');
    
    try {
        // 1. Delete post_translations first (FK to post)
        log.info('Cleaning post_translations...');
        const translationsResult = await db.query(`DELETE FROM post_translations RETURNING id`);
        log.success(`Deleted ${translationsResult.rowCount} rows from post_translations`);
        
        // 2. Delete post_tag (FK to post and tag)
        log.info('Cleaning post_tag...');
        const postTagResult = await db.query(`DELETE FROM post_tag RETURNING id`);
        log.success(`Deleted ${postTagResult.rowCount} rows from post_tag`);
        
        // 3. Delete posts
        log.info('Cleaning post...');
        const postsResult = await db.query(`DELETE FROM post RETURNING id`);
        log.success(`Deleted ${postsResult.rowCount} rows from post`);
        
        // 4. Delete tag_translations (FK to tag)
        log.info('Cleaning tag_translations...');
        const tagTransResult = await db.query(`DELETE FROM tag_translations RETURNING id`);
        log.success(`Deleted ${tagTransResult.rowCount} rows from tag_translations`);
        
        // 5. Delete tags
        log.info('Cleaning tag...');
        const tagsResult = await db.query(`DELETE FROM tag RETURNING id`);
        log.success(`Deleted ${tagsResult.rowCount} rows from tag`);
        
        // 6. Delete collection_translations (FK to collection)
        log.info('Cleaning collection_translations...');
        const collTransResult = await db.query(`DELETE FROM collection_translations RETURNING id`);
        log.success(`Deleted ${collTransResult.rowCount} rows from collection_translations`);
        
        // 7. Delete collections
        log.info('Cleaning collection...');
        const collectionsResult = await db.query(`DELETE FROM collection RETURNING id`);
        log.success(`Deleted ${collectionsResult.rowCount} rows from collection`);
        
        // Note: directus_files (uploaded media) are NOT deleted to preserve media files
        log.info('Skipping directus_files (media files preserved)');
        
        // 8. Clean ALL migration tracking
        log.info('Cleaning migration tracking...');
        await migrationDb.query(`DELETE FROM migration_data`);
        await migrationDb.query(`DELETE FROM migration_batch`);
        log.success('Cleaned all migration tracking');
        
        log.success('\n✓ All data has been cleaned! Ready for fresh migration.');
        
    } catch (error) {
        log.error(`Clean failed: ${error.message}`);
        throw error;
    }
}

// Show migration status
async function showStatus() {
    const result = await migrationDb.query(`
        SELECT 
            b.id, b.batch_name, b.status, b.started_at, b.completed_at,
            COUNT(d.id) as total,
            COUNT(*) FILTER (WHERE d.status = 'success') as success,
            COUNT(*) FILTER (WHERE d.status = 'failed') as failed
        FROM migration_batch b
        LEFT JOIN migration_data d ON b.id = d.batch_id
        GROUP BY b.id
        ORDER BY b.id DESC
        LIMIT 10
    `);
    
    console.log('\n=== Migration Status ===\n');
    console.table(result.rows);
    
    // Show per-table summary for latest batch
    if (result.rows.length > 0) {
        const latestBatch = result.rows[0].id;
        const tableResult = await migrationDb.query(`
            SELECT table_name, 
                   COUNT(*) as total,
                   COUNT(*) FILTER (WHERE status = 'success') as success,
                   COUNT(*) FILTER (WHERE status = 'failed') as failed
            FROM migration_data
            WHERE batch_id = $1
            GROUP BY table_name
        `, [latestBatch]);
        
        console.log(`\n=== Latest Batch (#${latestBatch}) Details ===\n`);
        console.table(tableResult.rows);
    }
    
    // Show overall summary
    const overallResult = await migrationDb.query(`
        SELECT table_name, 
               COUNT(*) as total,
               COUNT(*) FILTER (WHERE status = 'success') as success,
               COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM migration_data
        GROUP BY table_name
        ORDER BY table_name
    `);
    
    console.log('\n=== Overall Migration Summary ===\n');
    console.table(overallResult.rows);
}

// Rollback a specific batch or last batch
async function rollbackBatch(batchId = null) {
    let targetBatchId = batchId;
    
    // If no batchId provided, get the last completed batch
    if (!targetBatchId) {
        const result = await migrationDb.query(`
            SELECT id, batch_name FROM migration_batch 
            WHERE status = 'completed' 
            ORDER BY id DESC LIMIT 1
        `);
        
        if (result.rows.length === 0) {
            log.warn('No completed batch to rollback');
            return;
        }
        
        targetBatchId = result.rows[0].id;
    }
    
    // Get batch info
    const batchResult = await migrationDb.query(
        `SELECT id, batch_name, status FROM migration_batch WHERE id = $1`,
        [targetBatchId]
    );
    
    if (batchResult.rows.length === 0) {
        log.error(`Batch #${targetBatchId} not found`);
        return;
    }
    
    const batch = batchResult.rows[0];
    
    if (batch.status !== 'completed') {
        log.warn(`Batch #${targetBatchId} (${batch.batch_name}) is not completed (status: ${batch.status})`);
        return;
    }
    
    log.info(`Rolling back batch #${targetBatchId}: ${batch.batch_name}`);
    
    // Get all migrated records for this batch
    const migratedData = await migrationDb.query(`
        SELECT table_name, new_id FROM migration_data 
        WHERE batch_id = $1 AND status = 'success'
        ORDER BY id DESC
    `, [targetBatchId]);
    
    // Group by table
    const itemsByTable = {};
    for (const item of migratedData.rows) {
        if (!itemsByTable[item.table_name]) {
            itemsByTable[item.table_name] = [];
        }
        itemsByTable[item.table_name].push(item.new_id);
    }
    
    // Delete in reverse order (to handle FK constraints)
    // Note: directus_files are NOT deleted to preserve uploaded media
    const deleteOrder = ['post_translations', 'post_tag', 'post', 'tag_translations', 'tag', 
                         'collection_translations', 'collection'];
    
    let totalDeleted = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    
    // Skip directus_files if present
    if (itemsByTable['directus_files']) {
        totalSkipped = itemsByTable['directus_files'].length;
        log.info(`Skipping ${totalSkipped} directus_files (media files preserved)`);
    }
    
    for (const tableName of deleteOrder) {
        if (!itemsByTable[tableName] || itemsByTable[tableName].length === 0) continue;
        
        const ids = itemsByTable[tableName];
        log.info(`Rolling back ${ids.length} records from ${tableName}...`);
        
        try {
            // Integer type for all tables
            const intIds = ids.map(id => parseInt(id));
            const result = await db.query(
                `DELETE FROM ${tableName} WHERE id = ANY($1::int[])`,
                [intIds]
            );
            totalDeleted += result.rowCount;
            log.success(`Deleted ${result.rowCount} records from ${tableName}`);
        } catch (err) {
            totalFailed += ids.length;
            log.error(`Failed to delete from ${tableName}: ${err.message}`);
        }
    }
    
    // Mark batch as rolled back
    await migrationDb.query(
        `UPDATE migration_batch SET status = 'rolled_back', completed_at = NOW() WHERE id = $1`,
        [targetBatchId]
    );
    
    // Mark migration_data as rolled back
    await migrationDb.query(
        `UPDATE migration_data SET status = 'rolled_back' WHERE batch_id = $1`,
        [targetBatchId]
    );
    
    log.success(`Batch #${targetBatchId} rolled back successfully`);
    log.info(`Total deleted: ${totalDeleted}, Failed: ${totalFailed}`);
}


// Main migration function
async function runMigration(migrationLimit = 0) {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║       WordPress to Directus Migration                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    // Validate config
    if (!CONFIG.DIRECTUS_TOKEN) {
        log.error('DIRECTUS_TOKEN is required');
        process.exit(1);
    }
    if (!CONFIG.DIRECTUS_FOLDER_ID) {
        log.error('DIRECTUS_FOLDER_ID is required');
        process.exit(1);
    }
    
    log.info(`WordPress: ${CONFIG.WP_BASE_URL}`);
    log.info(`Directus: ${CONFIG.DIRECTUS_URL}`);
    log.info(`PostgreSQL: ${CONFIG.PG_HOST}:${CONFIG.PG_PORT}`);
    log.info(`Migration Limit: ${migrationLimit === 0 ? 'NONE (full migration)' : migrationLimit + ' items per table'}`);
    
    // Create batch
    const batchId = await createBatch(
        `migration_${new Date().toISOString().slice(0,10)}`,
        migrationLimit === 0 ? 'Full WordPress to Directus migration' : `Test migration (limit: ${migrationLimit})`
    );
    log.info(`Created batch #${batchId}`);
    
    try {
        // Migration order (based on dependencies):
        // Source: btaskee/data/wp/wp_posts.csv (WordPress database export)
        // 
        // 1. Tags + Tag translations (from directus_tags.json)
        // 2. Categories (collections) + Collection translations (from category.json)
        // 3. WordPress Posts (COMBINED: upload images + create post + create post_translations)
        //    - Reads wp_posts.csv once
        //    - For each post: extract media URLs → import via /files/import → create post → create post_translations
        //    - Converts HTML to TipTap JSON, replaces URLs with /assets/{uuid}
        // 4. Post-tag junction
        
        log.info('\n--- Step 1: Migrate Tags ---');
        log.info('NOTE: Migrating ALL tags (no limit) because posts might reference them');
        await migrateTags(batchId, 0); // Always migrate ALL tags (no limit)
        await migrateTagTranslations(batchId, 0);
        
        log.info('\n--- Step 2: Migrate Categories (collections) ---');
        log.info('IMPORTANT: Collections must be created BEFORE posts (FK constraint)');
        log.info('NOTE: Migrating ALL categories (no limit) because posts depend on them');
        await migrateCategories(batchId, 0); // Always migrate ALL categories (no limit)
        await migrateCategoryTranslations(batchId);
        
        log.info('\n--- Step 3: Migrate WordPress Posts (images + post + translations) ---');
        await migrateWpPosts(batchId, migrationLimit);
        
        log.info('\n--- Step 4: Migrate Post Tags ---');
        await migratePostTags(batchId, migrationLimit);
        
        // Mark batch as completed
        await completeBatch(batchId, 'completed');
        log.success(`\n✓ Migration batch #${batchId} completed!`);
        
        // Show summary
        await showStatus();
        
    } catch (error) {
        await completeBatch(batchId, 'failed', error.message);
        log.error(`Migration failed: ${error.message}`);
        throw error;
    }
}

// ============================================
// INITIALIZE MIGRATION DATABASE
// ============================================
async function initializeMigrationDB() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║       Initialize Migration Tracking Database                ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    // Debug: Show environment variables
    console.log('[DEBUG] Environment variables:');
    console.log(`  MIGRATION_PG_HOST: ${process.env.MIGRATION_PG_HOST || 'NOT SET'}`);
    console.log(`  MIGRATION_PG_PORT: ${process.env.MIGRATION_PG_PORT || 'NOT SET'}`);
    console.log(`  MIGRATION_PG_USER: ${process.env.MIGRATION_PG_USER || 'NOT SET'}`);
    console.log(`  MIGRATION_PG_DATABASE: ${process.env.MIGRATION_PG_DATABASE || 'NOT SET'}`);
    console.log('');
    
    // Use migrationDb if already connected, otherwise create new connection
    let tempMigrationDb = migrationDb;
    let shouldDisconnect = false;
    
    try {
        if (!tempMigrationDb) {
            const host = process.env.MIGRATION_PG_HOST || CONFIG.MIGRATION_PG_HOST;
            const port = parseInt(process.env.MIGRATION_PG_PORT || CONFIG.MIGRATION_PG_PORT);
            const user = process.env.MIGRATION_PG_USER || CONFIG.MIGRATION_PG_USER;
            const password = process.env.MIGRATION_PG_PASSWORD || CONFIG.MIGRATION_PG_PASSWORD;
            const database = process.env.MIGRATION_PG_DATABASE || CONFIG.MIGRATION_PG_DATABASE;
            
            log.info(`Migration Tracking DB: ${host}:${port}/${database}`);
            log.info(`User: ${user}`);
            log.info('');
            
            // Create new connection
            tempMigrationDb = new Client({
                host,
                port,
                user,
                password,
                database,
            });
            
            log.info('Connecting to migration tracking database...');
            await tempMigrationDb.connect();
            shouldDisconnect = true;
            log.success('✓ Connected successfully!');
        } else {
            log.info('Using existing migration database connection');
        }
        
        log.info('Creating migration tracking tables...');
        
        // Create migration_batch table
        await tempMigrationDb.query(`
            CREATE TABLE IF NOT EXISTS migration_batch (
                id SERIAL PRIMARY KEY,
                batch_name VARCHAR(255) NOT NULL,
                description TEXT,
                status VARCHAR(50) DEFAULT 'running',
                started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                completed_at TIMESTAMP WITH TIME ZONE,
                error_message TEXT,
                metadata JSONB DEFAULT '{}'
            )
        `);
        
        // Create migration_data table
        await tempMigrationDb.query(`
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
            )
        `);
        
        // Create indexes
        await tempMigrationDb.query(`
            CREATE INDEX IF NOT EXISTS idx_migration_data_table_old_id 
            ON migration_data(table_name, old_id)
        `);
        
        await tempMigrationDb.query(`
            CREATE INDEX IF NOT EXISTS idx_migration_data_batch_id 
            ON migration_data(batch_id)
        `);
        
        await tempMigrationDb.query(`
            CREATE INDEX IF NOT EXISTS idx_migration_data_status 
            ON migration_data(status)
        `);
        
        await tempMigrationDb.query(`
            CREATE INDEX IF NOT EXISTS idx_migration_batch_status 
            ON migration_batch(status)
        `);
        
        log.success('✓ Migration tracking tables created successfully!');
        
        // Show created tables
        const result = await tempMigrationDb.query(`
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' AND tablename LIKE 'migration_%'
            ORDER BY tablename
        `);
        
        log.info('\nCreated tables:');
        result.rows.forEach(row => {
            log.info(`  - ${row.tablename}`);
        });
        
        // Only disconnect if we created the connection
        if (shouldDisconnect) {
            await tempMigrationDb.end();
        }
        
        log.success('\n✓ Migration tracking database initialized successfully!');
        
        return { success: true, message: 'Migration tracking database initialized successfully' };
        
    } catch (error) {
        log.error(`Failed to initialize migration database: ${error.message}`);
        
        // Only disconnect if we created the connection
        if (shouldDisconnect && tempMigrationDb) {
            try {
                await tempMigrationDb.end();
            } catch (disconnectError) {
                log.error(`Error disconnecting: ${disconnectError.message}`);
            }
        }
        
        throw error;
    }
}

// Main entry point
async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'migrate';
    
    // Parse arguments
    let batchIdArg = null;
    let limitOverride = null;
    let postTemplateId = null;
    let collectionTemplateId = null;
    let folderId = null;
    let authorId = null;
    let authorName = null;
    
    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
            limitOverride = parseInt(args[i + 1]);
            i++; // Skip next arg
        } else if (args[i] === '--post-template' && args[i + 1]) {
            postTemplateId = parseInt(args[i + 1]);
            i++; // Skip next arg
        } else if (args[i] === '--collection-template' && args[i + 1]) {
            collectionTemplateId = parseInt(args[i + 1]);
            i++; // Skip next arg
        } else if (args[i] === '--folder' && args[i + 1]) {
            folderId = args[i + 1];
            i++; // Skip next arg
        } else if (args[i] === '--author-id' && args[i + 1]) {
            authorId = args[i + 1];
            i++; // Skip next arg
        } else if (args[i] === '--author-name' && args[i + 1]) {
            authorName = args[i + 1];
            i++; // Skip next arg
        } else if (command === 'rollback' && !isNaN(parseInt(args[i]))) {
            batchIdArg = args[i];
        }
    }
    
    // Store migration limit from --limit flag (required for migrate command)
    let migrationLimit = 0; // 0 = no limit (full migration)
    if (limitOverride !== null) {
        migrationLimit = limitOverride;
        console.log(`\n[MIGRATION] Limit set to: ${limitOverride === 0 ? 'NONE (full migration)' : limitOverride}\n`);
    }
    
    // Set template IDs if provided
    if (postTemplateId !== null) {
        CONFIG.POST_TEMPLATE_ID = postTemplateId;
        console.log(`[OVERRIDE] Post template ID set to: ${postTemplateId}`);
    }
    if (collectionTemplateId !== null) {
        CONFIG.COLLECTION_TEMPLATE_ID = collectionTemplateId;
        console.log(`[OVERRIDE] Collection template ID set to: ${collectionTemplateId}`);
    }
    
    // Set folder ID if provided
    if (folderId !== null) {
        CONFIG.DIRECTUS_FOLDER_ID = folderId;
        console.log(`[OVERRIDE] Directus folder ID set to: ${folderId}`);
    }
    
    // Set author info if provided
    if (authorId !== null) {
        CONFIG.AUTHOR_ID = authorId;
        console.log(`[OVERRIDE] Author ID set to: ${authorId}`);
    }
    if (authorName !== null) {
        CONFIG.AUTHOR_NAME = authorName;
        console.log(`[OVERRIDE] Author name set to: ${authorName}`);
    }
    
    console.log(`\nCommand: ${command}\n`);
    
    try {
        await connectDB();
        
        switch (command) {
            case 'init':
                await initializeMigrationDB();
                break;
            case 'migrate':
                await runMigration(migrationLimit);
                break;
            case 'rollback':
                const batchId = batchIdArg ? parseInt(batchIdArg) : null;
                if (batchId) {
                    log.info(`Rolling back specific batch: #${batchId}`);
                } else {
                    log.info('Rolling back last completed batch');
                }
                await rollbackBatch(batchId);
                break;
            case 'status':
                await showStatus();
                break;
            case 'clean':
                await cleanMigratedData();
                break;
            case 'clean-all':
                await cleanAll();
                break;
            default:
                console.log('Usage: node migration.js [command] [options]');
                console.log('');
                console.log('Commands:');
                console.log('  init              - Initialize migration tracking database');
                console.log('  migrate [--limit N] - Run migration (default)');
                console.log('  rollback [id]     - Rollback last completed batch or specific batch by ID');
                console.log('  status            - Show migration status');
                console.log('  clean             - Clean only migrated data (based on tracking)');
                console.log('  clean-all         - Clean ALL data to prepare for fresh migration');
                console.log('');
                console.log('Options:');
                console.log('  --limit N                  - Limit migration to N items per table (0 = no limit)');
                console.log('  --post-template ID         - Page ID for post detail template (required for migrate)');
                console.log('  --collection-template ID   - Page ID for collection listing template (required for migrate)');
                console.log('  --folder ID                - Folder ID for uploaded media files (required for migrate)');
                console.log('  --author-id ID             - User ID for post author (required for migrate)');
                console.log('  --author-name NAME         - User first name for post author (required for migrate)');
                console.log('');
                console.log('Examples:');
                console.log('  node migration.js init');
                console.log('  node migration.js migrate --limit 50 --post-template 46 --collection-template 57 --folder abc-123 --author-id user-id --author-name "John"');
                console.log('  node migration.js migrate --limit 0 --post-template 46 --collection-template 57 --folder abc-123 --author-id user-id --author-name "John"');
                console.log('  node migration.js rollback              # Rollback last batch');
                console.log('  node migration.js rollback 5            # Rollback batch #5');
                console.log('  node migration.js status');
        }
        
    } catch (error) {
        log.error(error.message);
        process.exit(1);
    } finally {
        await disconnectDB();
    }
}

// Export functions for use by server
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initializeMigrationDB,
        connectDB,
        disconnectDB,
    };
}

// Run main if executed directly
if (require.main === module) {
    main();
}
