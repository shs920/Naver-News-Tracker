"""
네이버 뉴스 추적기 - 경량 크롤러 (Render 무료 호환)
- playwright 제거, httpx만 사용
- 스크린샷 대신 텔레그램에 텍스트 diff 발송
"""

import asyncio
import hashlib
import os
import time
import logging
from datetime import datetime, timezone

import httpx
from bs4 import BeautifulSoup
from supabase import create_client, Client
import feedparser

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
CRAWL_INTERVAL_SEC = int(os.getenv("CRAWL_INTERVAL_SEC", "120"))

NAVER_RSS_FEEDS = [
    "https://news.naver.com/main/rss/politics.nhn",
    "https://news.naver.com/main/rss/economy.nhn",
    "https://news.naver.com/main/rss/society.nhn",
    "https://news.naver.com/main/rss/it.nhn",
    "https://news.naver.com/main/rss/world.nhn",
    "https://news.naver.com/main/rss/entertainment.nhn",
    "https://news.naver.com/main/rss/sports.nhn",
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
}

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


async def fetch_article_urls() -> list[str]:
    urls: set[str] = set()
    async with httpx.AsyncClient(headers=HEADERS, timeout=15) as client:
        for feed_url in NAVER_RSS_FEEDS:
            try:
                resp = await client.get(feed_url)
                feed = feedparser.parse(resp.text)
                for entry in feed.entries:
                    link = entry.get("link", "")
                    if "news.naver.com" in link:
                        urls.add(link)
            except Exception as e:
                log.warning(f"RSS 오류 {feed_url}: {e}")
    log.info(f"수집된 URL: {len(urls)}개")
    return list(urls)


async def parse_article(url: str) -> dict | None:
    async with httpx.AsyncClient(headers=HEADERS, timeout=20, follow_redirects=True) as client:
        try:
            resp = await client.get(url)
            if resp.status_code != 200:
                return None
            soup = BeautifulSoup(resp.text, "lxml")

            title = ""
            for sel in ["h2#title_area span", "#ct h2", ".media_end_head_title"]:
                tag = soup.select_one(sel)
                if tag:
                    title = tag.get_text(strip=True)
                    break

            body = ""
            for sel in ["#dic_area", "#articeBody", ".go_trans._article_content"]:
                tag = soup.select_one(sel)
                if tag:
                    body = tag.get_text(separator="\n", strip=True)
                    break

            images: list[str] = []
            for img in soup.select("#dic_area img"):
                src = img.get("data-src") or img.get("src", "")
                if src.startswith("http"):
                    images.append(src)

            press = ""
            tag = soup.select_one(".media_end_head_top a")
            if tag:
                press = tag.get_text(strip=True)

            if not title and not body:
                return None

            content_hash = hashlib.sha256(
                (title + body + str(images)).encode()
            ).hexdigest()

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


async def send_telegram_text(old: dict, new: dict, url: str, press: str, version: int):
    base = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"
    detected_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    changes = []
    if old["title"] != new["title"]:
        changes.append(f"📌 제목 변경\n  이전: {old['title']}\n  이후: {new['title']}")
    if old["body"] != new["body"]:
        # 본문 첫 200자만 비교해서 표시
        old_preview = (old["body"] or "")[:200]
        new_preview = (new["body"] or "")[:200]
        changes.append(f"📝 본문 변경\n  이전: {old_preview}...\n  이후: {new_preview}...")
    if old["images"] != new["images"]:
        changes.append(f"🖼️ 사진 변경\n  이전: {len(old['images'])}장 → 이후: {len(new['images'])}장")

    change_text = "\n\n".join(changes) if changes else "내용 변경 감지"

    message = (
        f"🔴 기사 수정 감지! (v{version})\n\n"
        f"📰 {press}\n"
        f"🕐 {detected_at}\n"
        f"🔗 {url}\n\n"
        f"{change_text}\n\n"
        f"👉 웹 뷰어에서 전체 비교 확인 가능"
    )

    async with httpx.AsyncClient(timeout=15) as client:
        await client.post(
            f"{base}/sendMessage",
            json={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": message,
            },
        )
    log.info(f"텔레그램 알림 발송: {url}")


def get_or_create_article(url: str) -> dict | None:
    res = supabase.table("articles").select("*").eq("url", url).execute()
    if res.data:
        return res.data[0]
    res = supabase.table("articles").insert({
        "url": url,
        "current_version": 0
    }).execute()
    return res.data[0] if res.data else None


def save_version(article_id: str, version_num: int, data: dict):
    supabase.table("article_versions").insert({
        "article_id": article_id,
        "version": version_num,
        "title": data["title"],
        "body": data["body"],
        "images": data["images"],
        "press": data["press"],
        "hash": data["hash"],
        "fetched_at": data["fetched_at"],
    }).execute()


def get_latest_version(article_id: str) -> dict | None:
    res = (
        supabase.table("article_versions")
        .select("*")
        .eq("article_id", article_id)
        .order("version", desc=True)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


async def process_article(url: str):
    parsed = await parse_article(url)
    if not parsed:
        return

    article_record = get_or_create_article(url)
    if not article_record:
        return

    article_id = article_record["id"]
    latest = get_latest_version(article_id)

    if not latest:
        save_version(article_id, 1, parsed)
        supabase.table("articles").update({
            "current_version": 1,
            "title": parsed["title"],
            "press": parsed["press"],
        }).eq("id", article_id).execute()
        log.info(f"신규 저장: {parsed['title'][:40]}")
        return

    if latest["hash"] == parsed["hash"]:
        return

    log.info(f"변경 감지: {parsed['title'][:40]}")
    new_version_num = latest["version"] + 1
    save_version(article_id, new_version_num, parsed)
    supabase.table("articles").update({
        "current_version": new_version_num,
        "title": parsed["title"],
    }).eq("id", article_id).execute()

    await send_telegram_text(
        old=latest,
        new=parsed,
        url=url,
        press=parsed["press"],
        version=new_version_num,
    )


# Render 무료 웹서비스용 — 포트를 열어야 잠들지 않음
async def health_server():
    from aiohttp import web
    app = web.Application()
    app.router.add_get("/", lambda r: web.Response(text="running"))
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.getenv("PORT", "10000"))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    log.info(f"헬스체크 서버 시작 (포트 {port})")


async def main():
    log.info(f"추적기 시작 — 주기: {CRAWL_INTERVAL_SEC}초")
    await health_server()
    while True:
        start = time.monotonic()
        try:
            urls = await fetch_article_urls()
            sem = asyncio.Semaphore(5)
            async def run(url):
                async with sem:
                    await process_article(url)
            await asyncio.gather(*[run(u) for u in urls])
        except Exception as e:
            log.error(f"루프 오류: {e}")
        elapsed = time.monotonic() - start
        await asyncio.sleep(max(0, CRAWL_INTERVAL_SEC - elapsed))


if __name__ == "__main__":
    asyncio.run(main())
