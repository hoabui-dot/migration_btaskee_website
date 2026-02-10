# bTaskee Migration GUI

Web-based GUI for WordPress to Directus migration with real-time progress tracking.

## Features

- 🚀 **One-click migration** - Start/stop migration with a button
- 📊 **Real-time progress** - Live updates via WebSocket
- 📈 **Statistics dashboard** - View success/failed/skipped counts
- ❌ **Failed items tracking** - See which images/posts failed with URLs
- 📝 **Live logs** - Monitor migration process in real-time
- 🔄 **Database initialization** - Setup tracking tables automatically
- 🐳 **Docker support** - Easy deployment with Docker

## Quick Start

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Copy environment file:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Start server:**
   ```bash
   npm start
   ```

4. **Open browser:**
   ```
   http://localhost:3001
   ```

### Docker Deployment

1. **Build image:**
   ```bash
   docker build -t btaskee-migration-gui .
   ```

2. **Run with docker-compose:**
   ```bash
   docker-compose up -d
   ```

3. **View logs:**
   ```bash
   docker-compose logs -f
   ```

4. **Stop:**
   ```bash
   docker-compose down
   ```

## Usage

### 1. Initialize Database
Click "Initialize Database" to create migration tracking tables in PostgreSQL.

### 2. Start Migration
Click "Start Migration" to begin the WordPress to Directus migration process.

### 3. Monitor Progress
- **Progress Tab**: Real-time progress for each migration step
- **Statistics Tab**: Overall statistics and batch history
- **Failed Items Tab**: View failed uploads with URLs and error messages
- **Logs Tab**: Live migration logs

### 4. Failed Items
The "Failed Items" tab shows:
- **Table name**: Which table the item belongs to (posts, tags, users, etc.)
- **Error message**: Why the upload failed
- **Image URL**: The original WordPress URL that failed to download
- **Timestamp**: When the failure occurred

Filter by table name or error message to find specific failures.

## Architecture

```
migration_gui/
├── server.js           # Express + WebSocket server
├── public/
│   ├── index.html      # Main UI
│   ├── app.js          # Frontend JavaScript
│   └── style.css       # Styling
├── Dockerfile          # Docker image
├── docker-compose.yml  # Docker Compose config
└── package.json        # Dependencies
```

## API Endpoints

- `GET /api/status` - Get current migration status and statistics
- `POST /api/init` - Initialize migration database tables
- `POST /api/migrate` - Start migration process
- `POST /api/stop` - Stop running migration
- `GET /api/failed` - Get list of failed items with details

## WebSocket Events

- `status` - Migration status update
- `log` - New log entry
- `complete` - Migration completed

## Environment Variables

See `.env.example` for all available configuration options.

Key variables:
- `DIRECTUS_URL` - Directus API URL
- `DIRECTUS_TOKEN` - Directus authentication token
- `PG_HOST` - PostgreSQL host
- `PG_PORT` - PostgreSQL port
- `GUI_PORT` - GUI server port (default: 3001)

## Troubleshooting

### Migration won't start
- Check that `btaskee/migration.js` exists
- Verify database connection in `.env`
- Check logs tab for error messages

### Failed image uploads
- Check the "Failed Items" tab for specific URLs
- Verify `WP_BASE_URL` is correct
- Check network connectivity to WordPress site
- Verify Directus API token has upload permissions

### WebSocket disconnects
- Check browser console for errors
- Verify server is running
- Check firewall settings

## Development

Run in development mode with auto-reload:
```bash
npm run dev
```

## License

MIT
