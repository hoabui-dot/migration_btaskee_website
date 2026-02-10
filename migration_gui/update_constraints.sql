-- ============================================
-- Update Primary Key and Foreign Key Constraints
-- for WordPress to Directus Migration Tables
-- ============================================
-- Database: PostgreSQL (Directus CMS)
-- Connection: PG_HOST=192.168.88.85, PG_PORT=5433
-- Database: directus
-- ============================================

-- This script checks and updates primary key and foreign key constraints
-- for all tables involved in the WordPress to Directus migration.

-- ============================================
-- PART 1: CHECK EXISTING CONSTRAINTS
-- ============================================

-- Check all primary keys
SELECT 
    tc.table_name, 
    kcu.column_name,
    tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu 
    ON tc.constraint_name = kcu.constraint_name
WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name IN ('post', 'post_translations', 'tag', 'tag_translations', 
                          'collection', 'collection_translations', 'post_tag')
ORDER BY tc.table_name;

-- Check all foreign keys
SELECT 
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name,
    tc.constraint_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name IN ('post', 'post_translations', 'tag', 'tag_translations', 
                          'collection', 'collection_translations', 'post_tag')
ORDER BY tc.table_name;

-- ============================================
-- PART 2: DROP EXISTING CONSTRAINTS (if needed)
-- ============================================

-- Note: Only run these if you need to recreate constraints
-- Uncomment the sections below if needed

/*
-- Drop foreign keys from post_translations
ALTER TABLE IF EXISTS post_translations 
    DROP CONSTRAINT IF EXISTS post_translations_post_id_foreign CASCADE;

ALTER TABLE IF EXISTS post_translations 
    DROP CONSTRAINT IF EXISTS post_translations_languages_code_foreign CASCADE;

-- Drop foreign keys from post_tag
ALTER TABLE IF EXISTS post_tag 
    DROP CONSTRAINT IF EXISTS post_tag_post_id_foreign CASCADE;

ALTER TABLE IF EXISTS post_tag 
    DROP CONSTRAINT IF EXISTS post_tag_tag_id_foreign CASCADE;

-- Drop foreign keys from post
ALTER TABLE IF EXISTS post 
    DROP CONSTRAINT IF EXISTS post_collection_foreign CASCADE;

ALTER TABLE IF EXISTS post 
    DROP CONSTRAINT IF EXISTS post_author_foreign CASCADE;

ALTER TABLE IF EXISTS post 
    DROP CONSTRAINT IF EXISTS post_thumbnail_foreign CASCADE;

-- Drop foreign keys from tag_translations
ALTER TABLE IF EXISTS tag_translations 
    DROP CONSTRAINT IF EXISTS tag_translations_tag_id_foreign CASCADE;

ALTER TABLE IF EXISTS tag_translations 
    DROP CONSTRAINT IF EXISTS tag_translations_languages_code_foreign CASCADE;

-- Drop foreign keys from collection_translations
ALTER TABLE IF EXISTS collection_translations 
    DROP CONSTRAINT IF EXISTS collection_translations_collection_id_foreign CASCADE;

ALTER TABLE IF EXISTS collection_translations 
    DROP CONSTRAINT IF EXISTS collection_translations_languages_code_foreign CASCADE;

-- Drop foreign keys from collection
ALTER TABLE IF EXISTS collection 
    DROP CONSTRAINT IF EXISTS collection_template_foreign CASCADE;

ALTER TABLE IF EXISTS collection 
    DROP CONSTRAINT IF EXISTS collection_post_template_foreign CASCADE;
*/

-- ============================================
-- PART 3: ADD/UPDATE PRIMARY KEYS
-- ============================================

-- Ensure primary keys exist on all tables
-- (These should already exist, but this ensures they're properly defined)

-- post table: primary key on id
ALTER TABLE post 
    DROP CONSTRAINT IF EXISTS post_pkey CASCADE;
ALTER TABLE post 
    ADD CONSTRAINT post_pkey PRIMARY KEY (id);

-- post_translations table: composite primary key on (post_id, languages_code)
ALTER TABLE post_translations 
    DROP CONSTRAINT IF EXISTS post_translations_pkey CASCADE;
ALTER TABLE post_translations 
    ADD CONSTRAINT post_translations_pkey PRIMARY KEY (post_id, languages_code);

-- tag table: primary key on id
ALTER TABLE tag 
    DROP CONSTRAINT IF EXISTS tag_pkey CASCADE;
ALTER TABLE tag 
    ADD CONSTRAINT tag_pkey PRIMARY KEY (id);

-- tag_translations table: primary key on id (auto-generated)
-- Note: tag_translations uses auto-increment id, not composite key
ALTER TABLE tag_translations 
    DROP CONSTRAINT IF EXISTS tag_translations_pkey CASCADE;
ALTER TABLE tag_translations 
    ADD CONSTRAINT tag_translations_pkey PRIMARY KEY (id);

-- collection table: primary key on id
ALTER TABLE collection 
    DROP CONSTRAINT IF EXISTS collection_pkey CASCADE;
ALTER TABLE collection 
    ADD CONSTRAINT collection_pkey PRIMARY KEY (id);

-- collection_translations table: primary key on id (auto-generated)
ALTER TABLE collection_translations 
    DROP CONSTRAINT IF EXISTS collection_translations_pkey CASCADE;
ALTER TABLE collection_translations 
    ADD CONSTRAINT collection_translations_pkey PRIMARY KEY (id);

-- post_tag table: primary key on id (auto-generated)
ALTER TABLE post_tag 
    DROP CONSTRAINT IF EXISTS post_tag_pkey CASCADE;
ALTER TABLE post_tag 
    ADD CONSTRAINT post_tag_pkey PRIMARY KEY (id);

-- ============================================
-- PART 4: ADD/UPDATE FOREIGN KEYS
-- ============================================

-- post_translations table
-- Foreign key: post_id references post(id)
ALTER TABLE post_translations 
    DROP CONSTRAINT IF EXISTS post_translations_post_id_foreign CASCADE;
ALTER TABLE post_translations 
    ADD CONSTRAINT post_translations_post_id_foreign 
    FOREIGN KEY (post_id) REFERENCES post(id) 
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Foreign key: languages_code references languages(code)
ALTER TABLE post_translations 
    DROP CONSTRAINT IF EXISTS post_translations_languages_code_foreign CASCADE;
ALTER TABLE post_translations 
    ADD CONSTRAINT post_translations_languages_code_foreign 
    FOREIGN KEY (languages_code) REFERENCES languages(code) 
    ON DELETE CASCADE ON UPDATE CASCADE;

-- post_tag table
-- Foreign key: post_id references post(id)
ALTER TABLE post_tag 
    DROP CONSTRAINT IF EXISTS post_tag_post_id_foreign CASCADE;
ALTER TABLE post_tag 
    ADD CONSTRAINT post_tag_post_id_foreign 
    FOREIGN KEY (post_id) REFERENCES post(id) 
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Foreign key: tag_id references tag(id)
ALTER TABLE post_tag 
    DROP CONSTRAINT IF EXISTS post_tag_tag_id_foreign CASCADE;
ALTER TABLE post_tag 
    ADD CONSTRAINT post_tag_tag_id_foreign 
    FOREIGN KEY (tag_id) REFERENCES tag(id) 
    ON DELETE CASCADE ON UPDATE CASCADE;

-- post table
-- Foreign key: collection references collection(id)
ALTER TABLE post 
    DROP CONSTRAINT IF EXISTS post_collection_foreign CASCADE;
ALTER TABLE post 
    ADD CONSTRAINT post_collection_foreign 
    FOREIGN KEY (collection) REFERENCES collection(id) 
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Foreign key: author references directus_users(id)
ALTER TABLE post 
    DROP CONSTRAINT IF EXISTS post_author_foreign CASCADE;
ALTER TABLE post 
    ADD CONSTRAINT post_author_foreign 
    FOREIGN KEY (author) REFERENCES directus_users(id) 
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Foreign key: thumbnail references directus_files(id)
ALTER TABLE post 
    DROP CONSTRAINT IF EXISTS post_thumbnail_foreign CASCADE;
ALTER TABLE post 
    ADD CONSTRAINT post_thumbnail_foreign 
    FOREIGN KEY (thumbnail) REFERENCES directus_files(id) 
    ON DELETE SET NULL ON UPDATE CASCADE;

-- tag_translations table
-- Foreign key: tag_id references tag(id)
ALTER TABLE tag_translations 
    DROP CONSTRAINT IF EXISTS tag_translations_tag_id_foreign CASCADE;
ALTER TABLE tag_translations 
    ADD CONSTRAINT tag_translations_tag_id_foreign 
    FOREIGN KEY (tag_id) REFERENCES tag(id) 
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Foreign key: languages_code references languages(code)
ALTER TABLE tag_translations 
    DROP CONSTRAINT IF EXISTS tag_translations_languages_code_foreign CASCADE;
ALTER TABLE tag_translations 
    ADD CONSTRAINT tag_translations_languages_code_foreign 
    FOREIGN KEY (languages_code) REFERENCES languages(code) 
    ON DELETE CASCADE ON UPDATE CASCADE;

-- collection_translations table
-- Foreign key: collection_id references collection(id)
ALTER TABLE collection_translations 
    DROP CONSTRAINT IF EXISTS collection_translations_collection_id_foreign CASCADE;
ALTER TABLE collection_translations 
    ADD CONSTRAINT collection_translations_collection_id_foreign 
    FOREIGN KEY (collection_id) REFERENCES collection(id) 
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Foreign key: languages_code references languages(code)
ALTER TABLE collection_translations 
    DROP CONSTRAINT IF EXISTS collection_translations_languages_code_foreign CASCADE;
ALTER TABLE collection_translations 
    ADD CONSTRAINT collection_translations_languages_code_foreign 
    FOREIGN KEY (languages_code) REFERENCES languages(code) 
    ON DELETE CASCADE ON UPDATE CASCADE;

-- collection table
-- Foreign key: template references pages(id)
ALTER TABLE collection 
    DROP CONSTRAINT IF EXISTS collection_template_foreign CASCADE;
ALTER TABLE collection 
    ADD CONSTRAINT collection_template_foreign 
    FOREIGN KEY (template) REFERENCES pages(id) 
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Foreign key: post_template references pages(id)
ALTER TABLE collection 
    DROP CONSTRAINT IF EXISTS collection_post_template_foreign CASCADE;
ALTER TABLE collection 
    ADD CONSTRAINT collection_post_template_foreign 
    FOREIGN KEY (post_template) REFERENCES pages(id) 
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================
-- PART 5: ADD INDEXES FOR PERFORMANCE
-- ============================================

-- Indexes on foreign key columns for better query performance

-- post_translations indexes
CREATE INDEX IF NOT EXISTS idx_post_translations_post_id 
    ON post_translations(post_id);
CREATE INDEX IF NOT EXISTS idx_post_translations_languages_code 
    ON post_translations(languages_code);

-- post_tag indexes
CREATE INDEX IF NOT EXISTS idx_post_tag_post_id 
    ON post_tag(post_id);
CREATE INDEX IF NOT EXISTS idx_post_tag_tag_id 
    ON post_tag(tag_id);

-- post indexes
CREATE INDEX IF NOT EXISTS idx_post_collection 
    ON post(collection);
CREATE INDEX IF NOT EXISTS idx_post_author 
    ON post(author);
CREATE INDEX IF NOT EXISTS idx_post_thumbnail 
    ON post(thumbnail);
CREATE INDEX IF NOT EXISTS idx_post_status 
    ON post(status);
CREATE INDEX IF NOT EXISTS idx_post_publish_date 
    ON post(publish_date);

-- tag_translations indexes
CREATE INDEX IF NOT EXISTS idx_tag_translations_tag_id 
    ON tag_translations(tag_id);
CREATE INDEX IF NOT EXISTS idx_tag_translations_languages_code 
    ON tag_translations(languages_code);

-- collection_translations indexes
CREATE INDEX IF NOT EXISTS idx_collection_translations_collection_id 
    ON collection_translations(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_translations_languages_code 
    ON collection_translations(languages_code);

-- collection indexes
CREATE INDEX IF NOT EXISTS idx_collection_template 
    ON collection(template);
CREATE INDEX IF NOT EXISTS idx_collection_post_template 
    ON collection(post_template);
CREATE INDEX IF NOT EXISTS idx_collection_sort 
    ON collection(sort);

-- ============================================
-- PART 6: VERIFY CONSTRAINTS
-- ============================================

-- Verify all primary keys are in place
SELECT 
    tc.table_name, 
    kcu.column_name,
    tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu 
    ON tc.constraint_name = kcu.constraint_name
WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name IN ('post', 'post_translations', 'tag', 'tag_translations', 
                          'collection', 'collection_translations', 'post_tag')
ORDER BY tc.table_name;

-- Verify all foreign keys are in place
SELECT 
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name,
    tc.constraint_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name IN ('post', 'post_translations', 'tag', 'tag_translations', 
                          'collection', 'collection_translations', 'post_tag')
ORDER BY tc.table_name;

-- ============================================
-- PART 7: CHECK DATA INTEGRITY
-- ============================================

-- Check for orphaned records in post_translations (post_id not in post)
SELECT COUNT(*) as orphaned_post_translations
FROM post_translations pt
LEFT JOIN post p ON pt.post_id = p.id
WHERE p.id IS NULL;

-- Check for orphaned records in post_tag (post_id not in post)
SELECT COUNT(*) as orphaned_post_tag_posts
FROM post_tag pt
LEFT JOIN post p ON pt.post_id = p.id
WHERE p.id IS NULL;

-- Check for orphaned records in post_tag (tag_id not in tag)
SELECT COUNT(*) as orphaned_post_tag_tags
FROM post_tag pt
LEFT JOIN tag t ON pt.tag_id = t.id
WHERE t.id IS NULL;

-- Check for orphaned records in tag_translations (tag_id not in tag)
SELECT COUNT(*) as orphaned_tag_translations
FROM tag_translations tt
LEFT JOIN tag t ON tt.tag_id = t.id
WHERE t.id IS NULL;

-- Check for orphaned records in collection_translations (collection_id not in collection)
SELECT COUNT(*) as orphaned_collection_translations
FROM collection_translations ct
LEFT JOIN collection c ON ct.collection_id = c.id
WHERE c.id IS NULL;

-- Check for posts with invalid collection references
SELECT COUNT(*) as posts_with_invalid_collection
FROM post p
LEFT JOIN collection c ON p.collection = c.id
WHERE p.collection IS NOT NULL AND c.id IS NULL;

-- ============================================
-- SUMMARY
-- ============================================

-- This script has:
-- 1. Checked existing primary key and foreign key constraints
-- 2. Dropped and recreated primary keys for all migration tables
-- 3. Dropped and recreated foreign keys with proper CASCADE rules
-- 4. Added indexes on foreign key columns for performance
-- 5. Verified all constraints are in place
-- 6. Checked for orphaned records that violate referential integrity

-- IMPORTANT NOTES:
-- - post_translations: Composite PK (post_id, languages_code), FK to post(id)
-- - post_tag: Auto-increment PK (id), FKs to post(id) and tag(id)
-- - post: PK (id), FKs to collection(id), directus_users(id), directus_files(id)
-- - tag_translations: Auto-increment PK (id), FK to tag(id)
-- - collection_translations: Auto-increment PK (id), FK to collection(id)
-- - collection: PK (id), FKs to pages(id) for templates

-- CASCADE RULES:
-- - ON DELETE CASCADE: Child records are deleted when parent is deleted
-- - ON DELETE SET NULL: Foreign key is set to NULL when parent is deleted
-- - ON UPDATE CASCADE: Foreign key is updated when parent key changes
