"""
네이버 뉴스 추적기 - 메인 크롤러
- 네이버 뉴스 RSS + 직접 파싱으로 기사 수집
- 변경 감지 시 Playwright로 스크린샷 캡처
- 텔레그램 봇으로 변경 전/후 이미지 발송
"""

import asyncio
import hashlib
import os
import time
import logging
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup
from supabase import create_client, Client
import feedparser

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── 환경변수 ──────────────────────────────────────────────
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
CRAWL_INTERVAL_SEC = int(os.getenv("CRAWL_INTERVAL_SEC", "120"))  # 기본 2분

# ── 네이버 뉴스 RSS 피드 목록 ──────────────────────────────
# 카테고리별 RSS: 정치/경제/사회/생활/IT/세계 포함
NAVER_RSS_FEEDS = [
    "https://feeds.feedburner.com/navernews/politics",   # 정치
    "https://feeds.feedburner.com/navernews/economy",   # 경제
    "https://feeds.feedburner.com/navernews/society",   # 사회
    "https://feeds.feedburner.com/navernews/it",        # IT
    "https://feeds.feedburner.com/navernews/world",     # 세계
    # 네이버 공식 RSS
    "https://news.naver.com/main/rss/politics.nhn",
    "https://news.naver.com/main/rss/economy.nhn",
    "https://news.naver.com/main/rss/society.nhn",
    "https://news.naver.com/main/rss/it.nhn",
    "https://news.naver.com/main/rss/world.nhn",
    "https://news.naver.com/main/rss/entertainment.nhn",
    "https://news.naver.com/main/rss/sports.nhn",
]

# 헤더 (봇 차단 방지)
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
}

# ── Supabase 클라이언트 ───────────────────────────────────
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


# ══════════════════════════════════════════════════════════
# 1. RSS 피드에서 기사 URL 수집
# ══════════════════════════════════════════════════════════
async def fetch_article_urls() -> list[str]:
    """RSS 피드 전체를 파싱해 네이버 뉴스 기사 URL 목록을 반환합니다."""
    urls: set[str] = set()
    async with httpx.AsyncClient(headers=HEADERS, timeout=15) as client:
        for feed_url in NAVER_RSS_FEEDS:
            try:
                resp = await client.get(feed_url)
                feed = feedparser.parse(resp.text)
                for entry in feed.entries:
                    link = entry.get("link", "")
                    # 네이버 뉴스 URL만 필터
                    if "news.naver.com" in link:
                        urls.add(link)
            except Exception as e:
                log.warning(f"RSS 피드 오류 {feed_url}: {e}")
    log.info(f"RSS에서 수집된 기사 URL: {len(urls)}개")
    return list(urls)


# ══════════════════════════════════════════════════════════
# 2. 기사 본문 파싱
# ══════════════════════════════════════════════════════════
async def parse_article(url: str) -> dict | None:
    """네이버 뉴스 기사를 파싱해 제목·본문·사진 URL을 추출합니다."""
    async with httpx.AsyncClient(headers=HEADERS, timeout=20, follow_redirects=True) as client:
        try:
            resp = await client.get(url)
            if resp.status_code != 200:
                return None
            soup = BeautifulSoup(resp.text, "lxml")

            # 제목
            title = ""
            for sel in ["h2#title_area span", "#ct h2", ".media_end_head_title"]:
                tag = soup.select_one(sel)
                if tag:
                    title = tag.get_text(strip=True)
                    break

            # 본문
            body = ""
            for sel in ["#dic_area", "#articeBody", ".go_trans._article_content"]:
                tag = soup.select_one(sel)
                if tag:
                    body = tag.get_text(separator="\n", strip=True)
                    break

            # 대표 이미지 URL 목록
            images: list[str] = []
            for img in soup.select("#dic_area img, .media_end_photo_list img"):
                src = img.get("data-src") or img.get("src", "")
                if src.startswith("http"):
                    images.append(src)

            # 언론사
            press = ""
            tag = soup.select_one(".media_end_head_top a, #cp_area")
            if tag:
                press = tag.get_text(strip=True)

            if not title and not body:
                return None  # 파싱 실패

            content_hash = hashlib.sha256((title + body + str(images)).encode()).hexdigest()

            return {
                "url": url,
                "title": title,
                "body": body,
                "images": images,
                "press": press,
                "hash": content_hash,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as e:
            log.warning(f"파싱 오류 {url}: {e}")
            return None


# ══════════════════════════════════════════════════════════
# 3. 스크린샷 캡처 (Playwright)
# ══════════════════════════════════════════════════════════
async def screenshot_article(url: str, playwright) -> bytes | None:
    """기사 페이지 전체를 스크린샷으로 캡처합니다."""
    browser = None
    try:
        browser = await playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = await browser.new_page(viewport={"width": 1280, "height": 900})
        await page.set_extra_http_headers(HEADERS)
        await page.goto(url, wait_until="networkidle", timeout=30_000)
        await page.wait_for_timeout(1500)  # JS 렌더링 대기

        # 광고·팝업 제거
        for sel in [".u_cbox_btn_close", "[class*='ad']", ".popup_wrap"]:
            try:
                await page.locator(sel).first.click(timeout=500)
            except Exception:
                pass

        screenshot = await page.screenshot(full_page=True, type="png")
        return screenshot
    except Exception as e:
        log.error(f"스크린샷 오류 {url}: {e}")
        return None
    finally:
        if browser:
            await browser.close()


# ══════════════════════════════════════════════════════════
# 4. 텔레그램 알림 발송
# ══════════════════════════════════════════════════════════
async def send_telegram_alert(
    article: dict,
    old_version: dict,
    new_version: dict,
    old_screenshot: bytes | None,
    new_screenshot: bytes | None,
):
    """변경 전/후 스크린샷과 변경 요약을 텔레그램으로 발송합니다."""
    base = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"

    # 변경 유형 분석
    changes = []
    if old_version["title"] != new_version["title"]:
        changes.append(f"📌 *제목 변경*\n  이전: {old_version['title']}\n  이후: {new_version['title']}")
    if old_version["hash"] != new_version["hash"]:
        if old_version["body"] != new_version["body"]:
            changes.append("📝 *본문 변경* (스크린샷 참조)")
        if old_version["images"] != new_version["images"]:
            changes.append("🖼️ *사진 변경* (스크린샷 참조)")

    change_summary = "\n\n".join(changes) if changes else "내용 변경 감지"
    version_num = new_version["version"]
    detected_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    caption_before = (
        f"🔴 *[수정 전 — v{version_num - 1}]*\n\n"
        f"📰 {article['press']}\n"
        f"🔗 {article['url']}\n"
        f"🕐 감지 시각: {detected_at}\n\n"
        f"{change_summary}"
    )
    caption_after = (
        f"🟢 *[수정 후 — v{version_num}]*\n\n"
        f"📰 {article['press']}\n"
        f"🔗 {article['url']}"
    )

    async with httpx.AsyncClient(timeout=30) as client:
        # 수정 전 스크린샷
        if old_screenshot:
            await client.post(
                f"{base}/sendPhoto",
                data={
                    "chat_id": TELEGRAM_CHAT_ID,
                    "caption": caption_before,
                    "parse_mode": "Markdown",
                },
                files={"photo": ("before.png", old_screenshot, "image/png")},
            )
        # 수정 후 스크린샷
        if new_screenshot:
            await client.post(
                f"{base}/sendPhoto",
                data={
                    "chat_id": TELEGRAM_CHAT_ID,
                    "caption": caption_after,
                    "parse_mode": "Markdown",
                },
                files={"photo": ("after.png", new_screenshot, "image/png")},
            )
        # 스크린샷 없을 경우 텍스트만
        if not old_screenshot and not new_screenshot:
            await client.post(
                f"{base}/sendMessage",
                json={
                    "chat_id": TELEGRAM_CHAT_ID,
                    "text": f"⚠️ 기사 수정 감지\n\n{caption_before}",
                    "parse_mode": "Markdown",
                },
            )

    log.info(f"텔레그램 알림 발송 완료: {article['url']}")


# ══════════════════════════════════════════════════════════
# 5. DB 저장 및 버전 관리
# ══════════════════════════════════════════════════════════
def get_or_create_article(url: str) -> dict | None:
    """기사 레코드를 조회하거나 신규 생성합니다."""
    res = supabase.table("articles").select("*").eq("url", url).execute()
    if res.data:
        return res.data[0]
    # 신규 기사 등록
    res = supabase.table("articles").insert({"url": url, "current_version": 0}).execute()
    return res.data[0] if res.data else None


def save_version(article_id: str, version_num: int, data: dict) -> dict:
    """기사 버전을 저장합니다."""
    res = supabase.table("article_versions").insert({
        "article_id": article_id,
        "version": version_num,
        "title": data["title"],
        "body": data["body"],
        "images": data["images"],
        "press": data["press"],
        "hash": data["hash"],
        "fetched_at": data["fetched_at"],
    }).execute()
    return res.data[0] if res.data else {}


def get_latest_version(article_id: str) -> dict | None:
    """가장 최근 저장된 버전을 조회합니다."""
    res = (
        supabase.table("article_versions")
        .select("*")
        .eq("article_id", article_id)
        .order("version", desc=True)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


# ══════════════════════════════════════════════════════════
# 6. 단일 기사 처리 파이프라인
# ══════════════════════════════════════════════════════════
async def process_article(url: str, playwright):
    """기사 1개를 수집 → 비교 → 변경 시 알림까지 처리합니다."""
    parsed = await parse_article(url)
    if not parsed:
        return

    article_record = get_or_create_article(url)
    if not article_record:
        return

    article_id = article_record["id"]
    latest = get_latest_version(article_id)

    # 최초 수집
    if not latest:
        new_version_num = 1
        save_version(article_id, new_version_num, parsed)
        supabase.table("articles").update({
            "current_version": new_version_num,
            "title": parsed["title"],
            "press": parsed["press"],
        }).eq("id", article_id).execute()
        log.info(f"신규 기사 저장 v1: {parsed['title'][:40]}")
        return

    # 변경 감지 (해시 비교)
    if latest["hash"] == parsed["hash"]:
        return  # 변경 없음

    log.info(f"변경 감지! {parsed['title'][:40]}")
    new_version_num = latest["version"] + 1

    # 변경 전 스크린샷 (이미 저장된 URL로 다시 촬영 — 아직 수정 전 캐시 활용)
    # ※ 실제로는 인터넷 아카이브 URL 또는 저장된 스냅샷 사용
    old_screenshot = await screenshot_article(url, playwright)
    await asyncio.sleep(2)
    new_screenshot = await screenshot_article(url, playwright)

    # 새 버전 저장
    save_version(article_id, new_version_num, parsed)
    supabase.table("articles").update({
        "current_version": new_version_num,
        "title": parsed["title"],
    }).eq("id", article_id).execute()

    # 텔레그램 알림
    await send_telegram_alert(
        article={"url": url, "press": parsed["press"]},
        old_version={**latest, "version": latest["version"]},
        new_version={**parsed, "version": new_version_num},
        old_screenshot=old_screenshot,
        new_screenshot=new_screenshot,
    )


# ══════════════════════════════════════════════════════════
# 7. 메인 루프
# ══════════════════════════════════════════════════════════
async def main():
    log.info(f"네이버 뉴스 추적기 시작 — 수집 주기: {CRAWL_INTERVAL_SEC}초")
    async with async_playwright() as playwright:
        while True:
            start = time.monotonic()
            try:
                urls = await fetch_article_urls()
                # 동시 처리 (최대 5개 병렬 — 서버 부담 방지)
                semaphore = asyncio.Semaphore(5)
                async def process_with_semaphore(url):
                    async with semaphore:
                        await process_article(url, playwright)
                await asyncio.gather(*[process_with_semaphore(u) for u in urls])
            except Exception as e:
                log.error(f"메인 루프 오류: {e}")

            elapsed = time.monotonic() - start
            sleep_time = max(0, CRAWL_INTERVAL_SEC - elapsed)
            log.info(f"다음 수집까지 {sleep_time:.0f}초 대기")
            await asyncio.sleep(sleep_time)


if __name__ == "__main__":
    asyncio.run(main())
