-- ============================================================
-- 네이버 뉴스 추적기 — Supabase 테이블 초기화 SQL
-- Supabase 대시보드 > SQL Editor 에서 그대로 실행하세요
-- ============================================================

-- 1. 기사 테이블 (기사 1개 = 1행)
CREATE TABLE IF NOT EXISTS articles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url             TEXT UNIQUE NOT NULL,           -- 기사 고유 URL
    title           TEXT,                           -- 현재 제목
    press           TEXT,                           -- 언론사
    current_version INTEGER DEFAULT 0,              -- 현재 버전 번호
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 2. 버전 이력 테이블 (수정될 때마다 행 추가)
CREATE TABLE IF NOT EXISTS article_versions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id  UUID REFERENCES articles(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,                   -- 1, 2, 3 ...
    title       TEXT,                               -- 해당 시점 제목
    body        TEXT,                               -- 해당 시점 본문 전체
    images      JSONB DEFAULT '[]',                 -- 해당 시점 이미지 URL 배열
    press       TEXT,                               -- 언론사
    hash        TEXT,                               -- 내용 해시 (변경 감지용)
    fetched_at  TIMESTAMPTZ DEFAULT now(),          -- 수집 시각
    UNIQUE(article_id, version)
);

-- 3. 인덱스 (조회 성능 향상)
CREATE INDEX IF NOT EXISTS idx_articles_url           ON articles(url);
CREATE INDEX IF NOT EXISTS idx_versions_article_id    ON article_versions(article_id);
CREATE INDEX IF NOT EXISTS idx_versions_fetched_at    ON article_versions(fetched_at DESC);

-- 4. updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER articles_updated_at
    BEFORE UPDATE ON articles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 5. 웹 뷰어용 조회 뷰 (버전 비교 API에서 사용)
CREATE OR REPLACE VIEW v_article_changes AS
SELECT
    a.id            AS article_id,
    a.url,
    a.press,
    av.version,
    av.title,
    av.body,
    av.images,
    av.hash,
    av.fetched_at,
    LAG(av.title) OVER (PARTITION BY a.id ORDER BY av.version) AS prev_title,
    LAG(av.body)  OVER (PARTITION BY a.id ORDER BY av.version) AS prev_body,
    LAG(av.images) OVER (PARTITION BY a.id ORDER BY av.version) AS prev_images
FROM articles a
JOIN article_versions av ON av.article_id = a.id
ORDER BY av.fetched_at DESC;

-- 6. RLS(Row Level Security) — 읽기 공개, 쓰기 서비스 키만 허용
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_versions ENABLE ROW LEVEL SECURITY;

-- anon 역할(웹 뷰어 읽기용)에게 SELECT 허용
CREATE POLICY "Public read articles"
    ON articles FOR SELECT USING (true);

CREATE POLICY "Public read versions"
    ON article_versions FOR SELECT USING (true);

-- service_role 키로만 INSERT/UPDATE/DELETE 허용 (크롤러 전용)
CREATE POLICY "Service write articles"
    ON articles FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Service write versions"
    ON article_versions FOR ALL
    USING (auth.role() = 'service_role');

-- ============================================================
-- 완료! 이제 크롤러와 웹 뷰어를 배포하면 됩니다.
-- ============================================================
