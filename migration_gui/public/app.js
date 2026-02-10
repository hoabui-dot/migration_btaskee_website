// WebSocket connection
let ws = null;
let reconnectInterval = null;

// State
let migrationData = {
    isRunning: false,
    progress: {},
    logs: [],
    stats: {},
    failed: [],
};

// Connect to WebSocket
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected');
        if (!reconnectInterval) {
            reconnectInterval = setInterval(() => {
                console.log('Attempting to reconnect...');
                connectWebSocket();
            }, 3000);
        }
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

// Handle WebSocket messages
function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'status':
            updateStatus(data.data);
            break;
        case 'log':
            addLog(data.level, data.message);
            break;
        case 'complete':
            handleMigrationComplete(data);
            break;
    }
}

// Update status display
function updateStatus(status) {
    migrationData.isRunning = status.isRunning;
    migrationData.progress = status.progress || {};
    
    // Update status badge
    const statusEl = document.getElementById('status');
    const currentStepEl = document.getElementById('current-step');
    const durationEl = document.getElementById('duration');
    
    if (status.isRunning) {
        statusEl.textContent = 'Running';
        statusEl.className = 'badge badge-running';
        currentStepEl.textContent = status.currentStep || 'Processing...';
        
        // Update duration
        if (status.startTime) {
            const duration = Math.floor((new Date() - new Date(status.startTime)) / 1000);
            durationEl.textContent = formatDuration(duration);
        }
    } else if (status.exitCode === 0) {
        statusEl.textContent = 'Complete';
        statusEl.className = 'badge badge-complete';
        currentStepEl.textContent = 'Migration completed';
        
        if (status.startTime && status.endTime) {
            const duration = Math.floor((new Date(status.endTime) - new Date(status.startTime)) / 1000);
            durationEl.textContent = formatDuration(duration);
        }
    } else if (status.exitCode !== undefined) {
        statusEl.textContent = 'Error';
        statusEl.className = 'badge badge-error';
        currentStepEl.textContent = 'Migration failed';
    } else {
        statusEl.textContent = 'Idle';
        statusEl.className = 'badge badge-idle';
        currentStepEl.textContent = '-';
        durationEl.textContent = '-';
    }
    
    // Update buttons
    const migrateBtn = document.getElementById('btn-migrate');
    const stopBtn = document.getElementById('btn-stop');
    
    migrateBtn.disabled = status.isRunning;
    stopBtn.disabled = !status.isRunning;
    
    // Reset migrate button loading state if migration is not running
    if (!status.isRunning && migrateBtn.dataset.originalText) {
        setButtonLoading('btn-migrate', false);
    }
    
    // Update progress display
    updateProgressDisplay();
}

// Update progress display
function updateProgressDisplay() {
    const container = document.getElementById('progress-container');
    
    if (Object.keys(migrationData.progress).length === 0) {
        container.innerHTML = '<p class="empty-state">No migration running. Click "Start Migration" to begin.</p>';
        return;
    }
    
    let html = '';
    for (const [table, stats] of Object.entries(migrationData.progress)) {
        // Use stats.total if available (from [10/20] format), otherwise calculate
        const total = stats.total || ((stats.success || 0) + (stats.failed || 0) + (stats.skipped || 0));
        const success = stats.success || 0;
        const failed = stats.failed || 0;
        const skipped = stats.skipped || 0;
        const successPercent = total > 0 ? (success / total * 100).toFixed(1) : 0;
        
        // Check if this is WordPress Posts with batch info
        const hasBatchInfo = stats.currentBatch && stats.totalBatches;
        
        html += `
            <div class="progress-item">
                <h3>${table}</h3>
                ${hasBatchInfo ? `
                <div class="batch-info">
                    <span class="batch-badge">Batch ${stats.currentBatch}/${stats.totalBatches}</span>
                    <span class="batch-range">Processing posts ${stats.batchStart}-${stats.batchEnd} of ${stats.total}</span>
                </div>
                ` : ''}
                <div class="progress-stats">
                    <div class="stat">
                        <span class="stat-label">Success</span>
                        <span class="stat-value success">${success}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Failed</span>
                        <span class="stat-value failed">${failed}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Skipped</span>
                        <span class="stat-value skipped">${skipped}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Total</span>
                        <span class="stat-value">${total}</span>
                    </div>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${successPercent}%"></div>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

// Add log entry
function addLog(level, message) {
    const logsContainer = document.getElementById('logs-container');
    const time = new Date().toLocaleTimeString();
    
    migrationData.logs.push({ time, level, message });
    
    // Keep only last 500 logs
    if (migrationData.logs.length > 500) {
        migrationData.logs = migrationData.logs.slice(-500);
    }
    
    // Update logs display
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry ${level}`;
    logEntry.innerHTML = `<span class="log-time">[${time}]</span>${escapeHtml(message)}`;
    
    logsContainer.appendChild(logEntry);
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

// Format duration
function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Handle migration complete
function handleMigrationComplete(data) {
    if (data.success) {
        addLog('info', '✓ Migration completed successfully!');
    } else {
        addLog('error', '✗ Migration failed!');
    }
    
    // Reset Start Migration button loading state
    setButtonLoading('btn-migrate', false);
    
    // Refresh stats
    loadStats();
    loadFailed();
}

// Load statistics
async function loadStats() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();
        
        migrationData.stats = data.database.stats || {};
        
        // Update stats display
        const statsContainer = document.getElementById('stats-container');
        
        if (Object.keys(migrationData.stats).length === 0) {
            statsContainer.innerHTML = '<p class="empty-state">No migration data found. Run a migration first.</p>';
        } else {
            let html = '<div class="stats-grid">';
            for (const [table, stats] of Object.entries(migrationData.stats)) {
                html += `
                    <div class="stat-card">
                        <h3>${table}</h3>
                        <div class="stat-row">
                            <span>Total:</span>
                            <strong>${stats.total}</strong>
                        </div>
                        <div class="stat-row">
                            <span style="color: #4caf50">Success:</span>
                            <strong>${stats.success}</strong>
                        </div>
                        <div class="stat-row">
                            <span style="color: #f44336">Failed:</span>
                            <strong>${stats.failed}</strong>
                        </div>
                        <div class="stat-row">
                            <span style="color: #ff9800">Pending:</span>
                            <strong>${stats.pending}</strong>
                        </div>
                    </div>
                `;
            }
            html += '</div>';
            statsContainer.innerHTML = html;
        }
        
        // Update batches
        const batchesContainer = document.getElementById('batches-container');
        const batches = data.database.batches || [];
        
        // Update batch selector
        const batchSelector = document.getElementById('batch-selector');
        batchSelector.innerHTML = '<option value="">All Batches</option>';
        batches.forEach(batch => {
            batchSelector.innerHTML += `<option value="${batch.id}">${batch.batch_name}</option>`;
        });
        
        if (batches.length === 0) {
            batchesContainer.innerHTML = '<p class="empty-state">No batches found.</p>';
        } else {
            let html = '<div class="batch-list">';
            batches.forEach(batch => {
                const statusBadge = batch.status === 'completed' ? 'badge-complete' : 
                                   batch.status === 'running' ? 'badge-running' :
                                   batch.status === 'rolled_back' ? 'badge-idle' : 'badge-error';
                const canRollback = batch.status === 'completed';
                
                html += `
                    <div class="batch-item">
                        <div class="batch-info">
                            <h4>${batch.batch_name}</h4>
                            <p>${new Date(batch.started_at).toLocaleString()}</p>
                        </div>
                        <div class="batch-actions">
                            <span class="badge ${statusBadge}">${batch.status}</span>
                            ${canRollback ? `<button class="btn btn-danger btn-small" onclick="rollbackBatch(${batch.id}, '${batch.batch_name}')">Rollback</button>` : ''}
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            batchesContainer.innerHTML = html;
        }
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

// Load failed items
async function loadFailed(batchId = null) {
    try {
        const url = batchId ? `/api/batch/${batchId}/failed` : '/api/failed';
        const response = await fetch(url);
        const data = await response.json();
        
        migrationData.failed = data.failed || [];
        
        // Update summary if batch-specific
        const summaryContainer = document.getElementById('failed-summary');
        if (batchId && data.summary && data.summary.length > 0) {
            let html = '<div class="failed-summary">';
            html += `<h3>Failed Items Summary (Total: ${data.total})</h3>`;
            html += '<div class="summary-grid">';
            data.summary.forEach(item => {
                html += `
                    <div class="summary-item">
                        <span class="summary-item-label">${item.table_name}</span>
                        <span class="summary-item-count">${item.count}</span>
                    </div>
                `;
            });
            html += '</div></div>';
            summaryContainer.innerHTML = html;
        } else {
            summaryContainer.innerHTML = '';
        }
        
        updateFailedDisplay();
    } catch (error) {
        console.error('Failed to load failed items:', error);
    }
}

// Rollback batch
async function rollbackBatch(batchId, batchName) {
    if (!confirm(`Are you sure you want to rollback "${batchName}"?\n\nThis will delete all migrated data from this batch.`)) {
        return;
    }
    
    // Find and disable the rollback button for this batch
    const rollbackButtons = document.querySelectorAll(`button[onclick*="rollbackBatch(${batchId}"]`);
    const originalTexts = [];
    rollbackButtons.forEach(btn => {
        originalTexts.push(btn.innerHTML);
        btn.innerHTML = '<span class="spinner"></span> Rolling back...';
        btn.disabled = true;
    });
    
    try {
        addLog('info', `Rolling back batch: ${batchName}...`);
        
        const response = await fetch(`/api/rollback/${batchId}`, { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            addLog('info', `✓ Rollback complete: ${data.deleted} items deleted`);
            if (data.failed > 0) {
                addLog('error', `⚠ ${data.failed} items failed to delete`);
                data.errors.forEach(err => addLog('error', `  ${err}`));
            }
            alert(`Rollback complete!\n\nDeleted: ${data.deleted} items\nFailed: ${data.failed} items`);
            
            // Refresh stats
            await loadStats();
            await loadFailed();
        } else {
            addLog('error', `✗ Rollback failed: ${data.error}`);
            alert('Rollback failed: ' + data.error);
        }
    } catch (error) {
        addLog('error', `✗ Rollback error: ${error.message}`);
        alert('Rollback error: ' + error.message);
    } finally {
        // Restore buttons (they'll be replaced by loadStats anyway)
        rollbackButtons.forEach((btn, i) => {
            btn.innerHTML = originalTexts[i];
            btn.disabled = false;
        });
    }
}

// Update failed items display
function updateFailedDisplay() {
    const container = document.getElementById('failed-container');
    const tableFilter = document.getElementById('filter-table').value.toLowerCase();
    const errorFilter = document.getElementById('filter-error').value.toLowerCase();
    
    let filtered = migrationData.failed.filter(item => {
        const matchTable = !tableFilter || item.table_name.toLowerCase().includes(tableFilter);
        const matchError = !errorFilter || (item.error_message && item.error_message.toLowerCase().includes(errorFilter));
        return matchTable && matchError;
    });
    
    if (filtered.length === 0) {
        container.innerHTML = '<p class="empty-state">No failed items found.</p>';
        return;
    }
    
    let html = '<div class="failed-list">';
    filtered.forEach(item => {
        const sourceData = item.source_data || {};
        let imageUrl = '';
        
        // Extract image URL based on table
        if (item.table_name === 'directus_files') {
            imageUrl = sourceData.url || sourceData.path || '';
        } else if (item.table_name === 'post' && sourceData.thumbnail_url) {
            imageUrl = sourceData.thumbnail_url;
        } else if (item.table_name === 'directus_users' && sourceData.avatar_url) {
            imageUrl = sourceData.avatar_url;
        }
        
        html += `
            <div class="failed-item">
                <div class="failed-header">
                    <span class="failed-table">${item.table_name}</span>
                    <span class="failed-id">ID: ${item.old_id}</span>
                </div>
                <div class="failed-error">${escapeHtml(item.error_message || 'Unknown error')}</div>
                ${imageUrl ? `<div class="failed-url">URL: <a href="${imageUrl}" target="_blank">${imageUrl}</a></div>` : ''}
                <div class="failed-url">Time: ${new Date(item.created_at).toLocaleString()}</div>
            </div>
        `;
    });
    html += '</div>';
    
    container.innerHTML = html;
}

// Helper function to set button loading state
function setButtonLoading(buttonId, isLoading, originalText = null) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    
    if (isLoading) {
        button.dataset.originalText = button.innerHTML;
        button.innerHTML = '<span class="spinner"></span> ' + (originalText || 'Processing...');
        button.disabled = true;
    } else {
        button.innerHTML = button.dataset.originalText || button.innerHTML;
        button.disabled = false;
        delete button.dataset.originalText;
    }
}

// Button handlers
document.getElementById('btn-init').addEventListener('click', async () => {
    if (!confirm('Initialize migration database? This will create tracking tables.')) return;
    
    const btnId = 'btn-init';
    try {
        setButtonLoading(btnId, true, 'Initializing...');
        addLog('info', 'Initializing migration database...');
        
        const response = await fetch('/api/init', { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            addLog('info', '✓ Database initialized successfully!');
            alert('Database initialized successfully!');
            loadStats();
        } else {
            addLog('error', `✗ Failed to initialize: ${data.error}`);
            alert('Failed to initialize database: ' + data.error);
        }
    } catch (error) {
        addLog('error', `✗ Initialization error: ${error.message}`);
        alert('Error: ' + error.message);
    } finally {
        setButtonLoading(btnId, false);
    }
});

// Template, folder, and author selection state
let selectedTemplates = {
    postTemplateId: null,
    collectionTemplateId: null,
    folderId: null,
    authorId: null,
    authorName: null
};

// Search for post template
document.getElementById('btn-search-post-template').addEventListener('click', async () => {
    await searchTemplate('post');
});

document.getElementById('post-template-search').addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
        await searchTemplate('post');
    }
});

// Search for collection template
document.getElementById('btn-search-collection-template').addEventListener('click', async () => {
    await searchTemplate('collection');
});

document.getElementById('collection-template-search').addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
        await searchTemplate('collection');
    }
});

// Search for folder
document.getElementById('btn-search-folder').addEventListener('click', async () => {
    await searchFolder();
});

document.getElementById('folder-search').addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
        await searchFolder();
    }
});

// Search for author
document.getElementById('btn-search-author').addEventListener('click', async () => {
    await searchAuthor();
});

document.getElementById('author-search').addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
        await searchAuthor();
    }
});

async function searchTemplate(type) {
    const inputId = type === 'post' ? 'post-template-search' : 'collection-template-search';
    const resultId = type === 'post' ? 'post-template-result' : 'collection-template-result';
    const input = document.getElementById(inputId);
    const resultDiv = document.getElementById(resultId);
    const title = input.value.trim();
    
    if (!title) {
        resultDiv.className = 'template-result error';
        resultDiv.innerHTML = '⚠️ Please enter a template title to search';
        return;
    }
    
    try {
        resultDiv.className = 'template-result info';
        resultDiv.innerHTML = '🔍 Searching...';
        
        const response = await fetch(`/api/templates/search?title=${encodeURIComponent(title)}`);
        const data = await response.json();
        
        if (!data.success) {
            resultDiv.className = 'template-result error';
            resultDiv.innerHTML = `❌ Error: ${data.error}`;
            return;
        }
        
        if (data.count === 0) {
            resultDiv.className = 'template-result error';
            resultDiv.innerHTML = `❌ No templates found with title "${title}"`;
            return;
        }
        
        // Show first result
        const template = data.results[0];
        if (type === 'post') {
            selectedTemplates.postTemplateId = template.pages_id;
        } else {
            selectedTemplates.collectionTemplateId = template.pages_id;
        }
        
        resultDiv.className = 'template-result success';
        resultDiv.innerHTML = `
            <div class="template-info">
                <div class="template-info-row">
                    <span class="template-info-label">✓ Selected:</span>
                    <span class="template-info-value"><strong>${template.title}</strong></span>
                </div>
                <div class="template-info-row">
                    <span class="template-info-label">Page ID:</span>
                    <span class="template-info-value">${template.pages_id}</span>
                </div>
                <div class="template-info-row">
                    <span class="template-info-label">Language:</span>
                    <span class="template-info-value">${template.languages_code}</span>
                </div>
                <div class="template-info-row">
                    <span class="template-info-label">Status:</span>
                    <span class="template-info-value">${template.status}</span>
                </div>
            </div>
        `;
        
        if (data.count > 1) {
            resultDiv.innerHTML += `<p style="margin-top: 8px; font-size: 12px; color: #666;">Found ${data.count} results, using first match.</p>`;
        }
        
    } catch (error) {
        resultDiv.className = 'template-result error';
        resultDiv.innerHTML = `❌ Error: ${error.message}`;
    }
}

async function searchFolder() {
    const input = document.getElementById('folder-search');
    const resultDiv = document.getElementById('folder-result');
    const name = input.value.trim();
    
    if (!name) {
        resultDiv.className = 'template-result error';
        resultDiv.innerHTML = '⚠️ Please enter a folder name to search';
        return;
    }
    
    try {
        resultDiv.className = 'template-result info';
        resultDiv.innerHTML = '🔍 Searching...';
        
        const response = await fetch(`/api/folders/search?name=${encodeURIComponent(name)}`);
        const data = await response.json();
        
        if (!data.success) {
            resultDiv.className = 'template-result error';
            resultDiv.innerHTML = `❌ Error: ${data.error}`;
            return;
        }
        
        if (data.count === 0) {
            resultDiv.className = 'template-result error';
            resultDiv.innerHTML = `❌ No folders found with name "${name}"`;
            return;
        }
        
        // Show first result
        const folder = data.results[0];
        selectedTemplates.folderId = folder.id;
        
        resultDiv.className = 'template-result success';
        resultDiv.innerHTML = `
            <div class="template-info">
                <div class="template-info-row">
                    <span class="template-info-label">✓ Selected:</span>
                    <span class="template-info-value"><strong>${folder.name}</strong></span>
                </div>
                <div class="template-info-row">
                    <span class="template-info-label">Folder ID:</span>
                    <span class="template-info-value">${folder.id}</span>
                </div>
                ${folder.parent ? `
                <div class="template-info-row">
                    <span class="template-info-label">Parent:</span>
                    <span class="template-info-value">${folder.parent}</span>
                </div>
                ` : ''}
            </div>
        `;
        
        if (data.count > 1) {
            resultDiv.innerHTML += `<p style="margin-top: 8px; font-size: 12px; color: #666;">Found ${data.count} results, using first match.</p>`;
        }
        
    } catch (error) {
        resultDiv.className = 'template-result error';
        resultDiv.innerHTML = `❌ Error: ${error.message}`;
    }
}

document.getElementById('btn-migrate').addEventListener('click', async () => {
    // Validate templates, folder, and author are selected
    if (!selectedTemplates.postTemplateId || !selectedTemplates.collectionTemplateId || !selectedTemplates.folderId || !selectedTemplates.authorId) {
        alert('⚠️ Error: Please complete Step 1 first!\n\n1. Enter Post Detail Template title and search\n2. Enter Collection Listing Template title and search\n3. Enter Media Upload Folder name and search\n4. Enter Author Email and search\n\nThen try starting migration again.');
        return;
    }
    
    // Get migration mode and limit
    const mode = document.querySelector('input[name="migration-mode"]:checked').value;
    const limitInput = document.getElementById('migration-limit');
    
    // Validate limit for test mode
    if (mode === 'test') {
        const limitValue = limitInput.value.trim();
        if (!limitValue || limitValue === '') {
            alert('⚠️ Error: Migration limit is required for Test Migration!\n\nPlease enter a number (e.g., 50) to limit items per table.');
            limitInput.focus();
            return;
        }
        const limit = parseInt(limitValue);
        if (isNaN(limit) || limit < 1) {
            alert('⚠️ Error: Migration limit must be a positive number!\n\nPlease enter a valid number (e.g., 50).');
            limitInput.focus();
            return;
        }
    }
    
    const limit = mode === 'test' ? parseInt(limitInput.value) : 0;
    
    const confirmMsg = mode === 'full' 
        ? 'Start FULL migration? This will migrate ALL data from WordPress to Directus.\n\nThis may take a long time!'
        : `Start TEST migration with limit of ${limit} items per table?\n\nThis is for testing purposes.`;
    
    if (!confirm(confirmMsg)) return;
    
    const btnId = 'btn-migrate';
    try {
        setButtonLoading(btnId, true, 'Starting...');
        addLog('info', mode === 'full' ? 'Starting FULL migration...' : `Starting migration with limit: ${limit}...`);
        
        const response = await fetch('/api/migrate', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                limit,
                postTemplateId: selectedTemplates.postTemplateId,
                collectionTemplateId: selectedTemplates.collectionTemplateId,
                folderId: selectedTemplates.folderId,
                authorId: selectedTemplates.authorId,
                authorName: selectedTemplates.authorName
            })
        });
        const data = await response.json();
        
        if (!data.success) {
            addLog('error', `✗ Failed to start: ${data.error}`);
            alert('Failed to start migration: ' + data.error);
            setButtonLoading(btnId, false);
        }
        // Don't reset loading state on success - migration is running
    } catch (error) {
        addLog('error', `✗ Start error: ${error.message}`);
        alert('Error: ' + error.message);
        setButtonLoading(btnId, false);
    }
});

document.getElementById('btn-stop').addEventListener('click', async () => {
    if (!confirm('Stop migration? This will terminate the current migration process.')) return;
    
    const btnId = 'btn-stop';
    try {
        setButtonLoading(btnId, true, 'Stopping...');
        
        const response = await fetch('/api/stop', { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            addLog('info', '✓ Migration stopped by user');
        }
    } catch (error) {
        addLog('error', `✗ Stop error: ${error.message}`);
        alert('Error: ' + error.message);
    } finally {
        setButtonLoading(btnId, false);
    }
});

document.getElementById('btn-refresh').addEventListener('click', async () => {
    const btnId = 'btn-refresh';
    try {
        setButtonLoading(btnId, true, 'Refreshing...');
        await Promise.all([loadStats(), loadFailed()]);
    } finally {
        setButtonLoading(btnId, false);
    }
});

document.getElementById('btn-clear-logs').addEventListener('click', () => {
    migrationData.logs = [];
    document.getElementById('logs-container').innerHTML = '<p class="empty-state">Logs cleared.</p>';
});

document.getElementById('btn-clean-all').addEventListener('click', cleanAllTables);

// Load table counts
async function loadTableCounts() {
    try {
        const response = await fetch('/api/tables/count');
        const data = await response.json();
        
        const container = document.getElementById('table-counts');
        const counts = data.counts || {};
        
        if (Object.keys(counts).length === 0) {
            container.innerHTML = '<p class="empty-state">No tables found.</p>';
            return;
        }
        
        let html = '';
        for (const [table, count] of Object.entries(counts)) {
            html += `
                <div class="table-count-item">
                    <div class="table-count-info">
                        <div class="table-count-name">${table}</div>
                        <div class="table-count-value">${count} rows</div>
                    </div>
                    <div class="table-count-actions">
                        <button class="btn btn-danger btn-small" onclick="cleanTable('${table}')" ${count === 0 ? 'disabled' : ''}>
                            Clean
                        </button>
                    </div>
                </div>
            `;
        }
        
        container.innerHTML = html;
    } catch (error) {
        console.error('Failed to load table counts:', error);
    }
}

// Clean specific table
async function cleanTable(tableName) {
    if (!confirm(`Are you sure you want to delete ALL data from "${tableName}"?\n\nThis action cannot be undone!`)) {
        return;
    }
    
    // Find and disable the clean button for this table
    const cleanButtons = document.querySelectorAll(`button[onclick*="cleanTable('${tableName}')"]`);
    const originalTexts = [];
    cleanButtons.forEach(btn => {
        originalTexts.push(btn.innerHTML);
        btn.innerHTML = '<span class="spinner"></span> Cleaning...';
        btn.disabled = true;
    });
    
    try {
        addLog('info', `Cleaning table: ${tableName}...`);
        
        const response = await fetch(`/api/clean/${tableName}`, { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            addLog('info', `✓ ${data.message}`);
            alert(`Success!\n\n${data.message}`);
            
            // Refresh counts and stats
            await loadTableCounts();
            await loadStats();
        } else if (data.error) {
            // Single error message
            addLog('error', `✗ Clean failed: ${data.error}`);
            alert('Clean failed:\n' + data.error);
        } else if (data.errors && Array.isArray(data.errors)) {
            // Multiple errors
            addLog('error', `✗ Clean failed: ${data.errors.join(', ')}`);
            alert('Clean failed:\n' + data.errors.join('\n'));
        } else {
            // Unknown error format
            addLog('error', `✗ Clean failed: ${JSON.stringify(data)}`);
            alert('Clean failed. Check logs for details.');
        }
    } catch (error) {
        addLog('error', `✗ Clean error: ${error.message}`);
        alert('Clean error: ' + error.message);
    } finally {
        // Restore buttons (they'll be replaced by loadTableCounts anyway)
        cleanButtons.forEach((btn, i) => {
            btn.innerHTML = originalTexts[i];
            btn.disabled = false;
        });
    }
}

// Clean all tables
async function cleanAllTables() {
    if (!confirm('⚠️ WARNING ⚠️\n\nAre you sure you want to delete ALL migrated data from ALL tables?\n\nThis will remove:\n- All posts and translations\n- All tags and translations\n- All collections and translations\n- All uploaded files\n- All migration tracking\n\nThis action CANNOT be undone!')) {
        return;
    }
    
    // Double confirmation
    const confirmation = prompt('Type "DELETE ALL" to confirm:');
    if (confirmation !== 'DELETE ALL') {
        alert('Cancelled. You must type "DELETE ALL" exactly to confirm.');
        return;
    }
    
    const btnId = 'btn-clean-all';
    try {
        setButtonLoading(btnId, true, 'Cleaning...');
        addLog('info', 'Cleaning all tables...');
        
        const response = await fetch('/api/clean/all', { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            addLog('info', `✓ ${data.message}`);
            alert(`Success!\n\n${data.message}`);
            
            // Refresh everything
            await Promise.all([loadTableCounts(), loadStats(), loadFailed()]);
        } else if (data.error) {
            // Single error message
            addLog('error', `✗ Clean failed: ${data.error}`);
            alert('Clean failed:\n' + data.error);
        } else if (data.errors && Array.isArray(data.errors)) {
            // Multiple errors
            addLog('error', `✗ Clean failed: ${data.errors.join(', ')}`);
            alert('Clean failed:\n' + data.errors.join('\n'));
        } else {
            // Unknown error format
            addLog('error', `✗ Clean failed: ${JSON.stringify(data)}`);
            alert('Clean failed. Check logs for details.');
        }
    } catch (error) {
        addLog('error', `✗ Clean error: ${error.message}`);
        alert('Clean error: ' + error.message);
    } finally {
        setButtonLoading(btnId, false);
    }
}

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        
        // Update active tab button
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // Update active tab content
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(`tab-${tab}`).classList.add('active');
        
        // Load data for specific tabs
        if (tab === 'stats') loadStats();
        if (tab === 'failed') loadFailed();
        if (tab === 'clean') loadTableCounts();
    });
});

// Filter handlers
document.getElementById('filter-table').addEventListener('input', updateFailedDisplay);
document.getElementById('filter-error').addEventListener('input', updateFailedDisplay);
document.getElementById('batch-selector').addEventListener('change', (e) => {
    const batchId = e.target.value;
    loadFailed(batchId || null);
});

// Initialize
connectWebSocket();
loadStats();
loadFailed();

// Update duration every second
setInterval(() => {
    if (migrationData.isRunning) {
        updateStatus({ ...migrationData, isRunning: true });
    }
}, 1000);

// Handle migration mode change
document.querySelectorAll('input[name="migration-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        const limitContainer = document.getElementById('limit-input-container');
        const limitInput = document.getElementById('migration-limit');
        
        if (e.target.value === 'test') {
            limitContainer.style.display = 'flex';
            limitInput.disabled = false;
            limitInput.required = true;
            // Set default value if empty
            if (!limitInput.value) {
                limitInput.value = '50';
            }
        } else {
            limitContainer.style.display = 'none';
            limitInput.disabled = true;
            limitInput.required = false;
        }
    });
});

// Set initial state on page load
document.addEventListener('DOMContentLoaded', () => {
    const testRadio = document.querySelector('input[name="migration-mode"][value="test"]');
    if (testRadio && testRadio.checked) {
        const limitInput = document.getElementById('migration-limit');
        if (!limitInput.value) {
            limitInput.value = '50';
        }
    }
});


async function searchAuthor() {
    const input = document.getElementById('author-search');
    const resultDiv = document.getElementById('author-result');
    const email = input.value.trim();
    
    if (!email) {
        resultDiv.className = 'template-result error';
        resultDiv.innerHTML = '⚠️ Please enter an email address to search';
        return;
    }
    
    try {
        resultDiv.className = 'template-result info';
        resultDiv.innerHTML = '🔍 Searching...';
        
        const response = await fetch(`/api/users/search?email=${encodeURIComponent(email)}`);
        const data = await response.json();
        
        if (!data.success) {
            resultDiv.className = 'template-result error';
            resultDiv.innerHTML = `❌ Error: ${data.error}`;
            return;
        }
        
        if (data.count === 0) {
            resultDiv.className = 'template-result error';
            resultDiv.innerHTML = `❌ No users found with email "${email}"`;
            return;
        }
        
        // Show first result
        const user = data.results[0];
        selectedTemplates.authorId = user.id;
        selectedTemplates.authorName = user.first_name;
        
        resultDiv.className = 'template-result success';
        resultDiv.innerHTML = `
            <div class="template-info">
                <div class="template-info-row">
                    <span class="template-info-label">✓ Selected:</span>
                    <span class="template-info-value"><strong>${user.first_name} ${user.last_name || ''}</strong></span>
                </div>
                <div class="template-info-row">
                    <span class="template-info-label">User ID:</span>
                    <span class="template-info-value">${user.id}</span>
                </div>
                <div class="template-info-row">
                    <span class="template-info-label">Email:</span>
                    <span class="template-info-value">${user.email}</span>
                </div>
                <div class="template-info-row">
                    <span class="template-info-label">Status:</span>
                    <span class="template-info-value">${user.status}</span>
                </div>
            </div>
        `;
        
        if (data.count > 1) {
            resultDiv.innerHTML += `<p style="margin-top: 8px; font-size: 12px; color: #666;">Found ${data.count} results, using first match.</p>`;
        }
        
    } catch (error) {
        resultDiv.className = 'template-result error';
        resultDiv.innerHTML = `❌ Error: ${error.message}`;
    }
}


// Replace Image functionality
document.querySelectorAll('input[name="upload-method"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        const urlSection = document.getElementById('url-upload-section');
        const fileSection = document.getElementById('file-upload-section');
        
        if (e.target.value === 'url') {
            urlSection.style.display = 'block';
            fileSection.style.display = 'none';
        } else {
            urlSection.style.display = 'none';
            fileSection.style.display = 'block';
        }
    });
});

document.getElementById('btn-replace-image').addEventListener('click', async () => {
    const oldImageId = document.getElementById('old-image-id').value.trim();
    const tableName = document.getElementById('target-table').value.trim();
    const fieldName = document.getElementById('target-field').value.trim();
    const uploadMethod = document.querySelector('input[name="upload-method"]:checked').value;
    const resultDiv = document.getElementById('replace-result');
    
    // Validate inputs
    if (!oldImageId || !tableName || !fieldName) {
        resultDiv.className = 'replace-result error';
        resultDiv.innerHTML = '❌ Error: Please fill in all required fields (Old Image ID, Table Name, Field Name)';
        return;
    }
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(oldImageId)) {
        resultDiv.className = 'replace-result error';
        resultDiv.innerHTML = '❌ Error: Old Image ID must be a valid UUID format (e.g., 22b7e3dc-9879-41c6-b4a2-d9b7357c8388)';
        return;
    }
    
    let imageUrl = null;
    let imageFile = null;
    
    if (uploadMethod === 'url') {
        imageUrl = document.getElementById('image-url').value.trim();
        if (!imageUrl) {
            resultDiv.className = 'replace-result error';
            resultDiv.innerHTML = '❌ Error: Please enter an image URL';
            return;
        }
    } else {
        const fileInput = document.getElementById('image-file');
        if (!fileInput.files || fileInput.files.length === 0) {
            resultDiv.className = 'replace-result error';
            resultDiv.innerHTML = '❌ Error: Please select an image file';
            return;
        }
        imageFile = fileInput.files[0];
    }
    
    const btnId = 'btn-replace-image';
    try {
        setButtonLoading(btnId, true, 'Processing...');
        resultDiv.className = 'replace-result info';
        resultDiv.innerHTML = '🔄 Step 1/3: Uploading new image to Directus...';
        
        addLog('info', `Starting image replacement: ${oldImageId} in ${tableName}.${fieldName}`);
        
        let newImageId = null;
        
        // Upload image to Directus
        if (uploadMethod === 'url') {
            // Method 1: URL Import
            addLog('info', `Downloading and uploading image from URL: ${imageUrl}`);
            const uploadResponse = await fetch('/api/replace-image/upload-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: imageUrl })
            });
            
            const uploadData = await uploadResponse.json();
            
            if (!uploadData.success) {
                throw new Error(uploadData.error || 'Failed to upload image from URL');
            }
            
            newImageId = uploadData.fileId;
            addLog('info', `✓ Image uploaded successfully. New ID: ${newImageId}`);
        } else {
            // Method 2: Direct File Upload
            addLog('info', `Uploading local file: ${imageFile.name}`);
            const formData = new FormData();
            formData.append('file', imageFile);
            
            const uploadResponse = await fetch('/api/replace-image/upload-file', {
                method: 'POST',
                body: formData
            });
            
            const uploadData = await uploadResponse.json();
            
            if (!uploadData.success) {
                throw new Error(uploadData.error || 'Failed to upload image file');
            }
            
            newImageId = uploadData.fileId;
            addLog('info', `✓ Image uploaded successfully. New ID: ${newImageId}`);
        }
        
        // Step 2: Find and replace in database
        resultDiv.innerHTML = '🔄 Step 2/3: Finding and replacing image ID in database...';
        addLog('info', `Searching for old image ID in ${tableName}.${fieldName}...`);
        
        const replaceResponse = await fetch('/api/replace-image/replace', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                oldImageId,
                newImageId,
                tableName,
                fieldName
            })
        });
        
        const replaceData = await replaceResponse.json();
        
        if (!replaceData.success) {
            throw new Error(replaceData.error || 'Failed to replace image ID');
        }
        
        // Step 3: Success
        resultDiv.className = 'replace-result success';
        resultDiv.innerHTML = `
            <div>✅ Image replacement completed successfully!</div>
            <div class="replace-result-details">
                <div class="replace-result-row">
                    <span class="replace-result-label">Old Image ID:</span>
                    <span class="replace-result-value">${oldImageId}</span>
                </div>
                <div class="replace-result-row">
                    <span class="replace-result-label">New Image ID:</span>
                    <span class="replace-result-value">${newImageId}</span>
                </div>
                <div class="replace-result-row">
                    <span class="replace-result-label">Table:</span>
                    <span class="replace-result-value">${tableName}</span>
                </div>
                <div class="replace-result-row">
                    <span class="replace-result-label">Field:</span>
                    <span class="replace-result-value">${fieldName}</span>
                </div>
                <div class="replace-result-row">
                    <span class="replace-result-label">Rows Updated:</span>
                    <span class="replace-result-value">${replaceData.rowsUpdated}</span>
                </div>
                <div class="replace-result-row">
                    <span class="replace-result-label">Occurrences Replaced:</span>
                    <span class="replace-result-value">${replaceData.occurrencesReplaced}</span>
                </div>
            </div>
        `;
        
        addLog('info', `✓ Replacement complete: ${replaceData.rowsUpdated} rows updated, ${replaceData.occurrencesReplaced} occurrences replaced`);
        
    } catch (error) {
        resultDiv.className = 'replace-result error';
        resultDiv.innerHTML = `❌ Error: ${error.message}`;
        addLog('error', `✗ Image replacement failed: ${error.message}`);
    } finally {
        setButtonLoading(btnId, false);
    }
});
