/**
 * Test Different File Upload Methods
 * 
 * This script tests both:
 * 1. URL Import (POST /files/import) - Currently failing
 * 2. Direct Upload (POST /files) - Alternative method
 */

require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');

const CONFIG = {
    DIRECTUS_URL: 'https://cms-staging.btaskee.work',
    DIRECTUS_TOKEN: 'cQmC8I17YYuU8M8FykMlRCOQlr7zTGjt',
};

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║       Test File Upload Methods                              ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log(`Directus URL: ${CONFIG.DIRECTUS_URL}`);
console.log(`Token: ${CONFIG.DIRECTUS_TOKEN ? CONFIG.DIRECTUS_TOKEN.substring(0, 10) + '...' : 'NOT SET'}`);
console.log('');

async function testUploadMethods() {
    const testImageUrl = 'https://www.btaskee.com/wp-content/uploads/2018/11/000043-1024x688.jpg';

    // Method 1: URL Import (currently failing)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Method 1: URL Import (POST /files/import)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Testing with: ${testImageUrl}`);
    
    try {
        const response = await axios.post(
            `${CONFIG.DIRECTUS_URL}/files/import`,
            {
                url: testImageUrl,
                data: {
                    title: 'Test Import',
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${CONFIG.DIRECTUS_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            }
        );
        console.log('✓ URL Import works!');
        console.log(`  File ID: ${response.data.data?.id}`);
        console.log(`  Filename: ${response.data.data?.filename_download}`);
    } catch (error) {
        console.log('✗ URL Import failed');
        console.log(`  Status: ${error.response?.status || 'N/A'}`);
        console.log(`  Error: ${error.response?.data?.errors?.[0]?.message || error.message}`);
        console.log('  → This is a Directus server storage issue');
    }
    console.log('');

    // Method 2: Direct Upload (download then upload)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Method 2: Direct Upload (POST /files)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 1: Downloading image from WordPress...');
    
    try {
        // Download the image
        const imageResponse = await axios.get(testImageUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
        });
        
        const imageBuffer = Buffer.from(imageResponse.data);
        const contentType = imageResponse.headers['content-type'];
        const fileSize = imageBuffer.length;
        
        console.log(`✓ Downloaded successfully`);
        console.log(`  Size: ${(fileSize / 1024).toFixed(2)} KB`);
        console.log(`  Type: ${contentType}`);
        console.log('');
        console.log('Step 2: Uploading to Directus...');
        
        // Create form data
        const form = new FormData();
        form.append('file', imageBuffer, {
            filename: '000043-1024x688.jpg',
            contentType: contentType,
        });
        form.append('title', 'Test Direct Upload');
        
        // Upload to Directus
        const uploadResponse = await axios.post(
            `${CONFIG.DIRECTUS_URL}/files`,
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    'Authorization': `Bearer ${CONFIG.DIRECTUS_TOKEN}`,
                },
                timeout: 30000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            }
        );
        
        console.log('✓ Direct Upload works!');
        console.log(`  File ID: ${uploadResponse.data.data?.id}`);
        console.log(`  Filename: ${uploadResponse.data.data?.filename_download}`);
        console.log(`  Type: ${uploadResponse.data.data?.type}`);
        console.log(`  Size: ${uploadResponse.data.data?.filesize} bytes`);
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║  ✓ DIRECT UPLOAD WORKS - Migration can proceed!            ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
        console.log('Solution: Use direct upload method instead of URL import');
        console.log('The migration script will be updated to use this method.');
        
    } catch (error) {
        console.log('✗ Direct Upload also failed');
        console.log(`  Status: ${error.response?.status || 'N/A'}`);
        console.log(`  Error: ${error.response?.data?.errors?.[0]?.message || error.message}`);
        
        if (error.code === 'ECONNABORTED') {
            console.log('  → Timeout - file might be too large');
        } else if (error.response?.status === 403) {
            console.log('  → Permission denied - check token permissions');
        } else if (error.response?.status === 503) {
            console.log('  → Storage issue - contact Directus administrator');
        }
        
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║  ✗ BOTH METHODS FAILED - Storage issue must be fixed       ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
        console.log('Action Required:');
        console.log('1. Contact Directus administrator');
        console.log('2. Check server logs: docker logs directus-container');
        console.log('3. Verify storage permissions: ls -la /directus/uploads');
        console.log('4. Check disk space: df -h');
    }
}

// Run tests
testUploadMethods().catch(error => {
    console.error('\n✗ Unexpected error:', error.message);
    process.exit(1);
});
