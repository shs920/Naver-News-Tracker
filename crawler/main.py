import asyncio
import hashlib
import os
import time
import logging
from datetime import datetime, timezone, timedelta

import httpx
from bs4 import BeautifulSoup
import feedparser
from aiohttp import web

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
CRAWL_INTERVAL_SEC = int(os.getenv("CRAWL_INTERVAL_SEC", "120"))

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9",
}

SUPA_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

NAVER_RSS_FEEDS = [
    "https://news.naver.com/main/rss/politics.nhn",
    "https://news.naver.com/main/rss/economy.nhn",
    "https://news.naver.com/main/rss/society.nhn",
    "https://news.naver.com/main/rss/it.nhn",
    "https://news.naver.com/main/rss/world.nhn",
    "https://news.naver.com/main/rss/entertainment.nhn",
    "https://news.naver.com/main/rss/sports.nhn",
]

ADDITIONAL_URLS = [
    "https://n.news.naver.com/mnews/article/list?sid=100",
    "https://n.news.naver.com/mnews/article/list?sid=101",
    "https://n.news.naver.com/mnews/article/list?sid=102",
]


# ── Supabase REST API 직접 호출 ──────────────────────────
async def supa_get(table: str, params: dict) -> list:
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    async with httpx.AsyncClient(headers=SUPA_HEADERS, timeout=10) as c:
        r = await c.get(url, params=params)
        return r.json() if r.status_code == 200 else []


async def supa_post(table: str, data: dict) -> dict | None:
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    async with httpx.AsyncClient(headers=SUPA_HEADERS, timeout=10) as c:
        r = await c.post(url, json=data)
        result = r.json()
        return result[0] if isinstance(result, list) and result else None


async def supa_patch(table: str, match: dict, data: dict):
    params = {k: f"eq.{v}" for k, v in match.items()}
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    async with httpx.AsyncClient(headers=SUPA_HEADERS, timeout=10) as c:
        await c.patch(url, params=params, json=data)


# ── RSS 수집 ─────────────────────────────────────────────
async def fetch_urls() -> list[str]:
    urls: set[str] = set()
    async with httpx.AsyncClient(headers=HEADERS, timeout=15, follow_redirects=True) as c:
        for feed_url in NAVER_RSS_FEEDS:
            try:
                r = await c.get(feed_url)
                feed = feedparser.parse(r.text)
                for e in feed.entries:
                    link = e.get("link", "")
                    if "news.naver.com" in link or "n.news.naver.com" in link:
                        urls.add(link)
            except Exception as ex:
                log.warning(f"RSS 오류: {ex}")

        # 네이버 뉴스 홈에서 직접 기사 링크 수집
        try:
            r = await c.get("https://news.naver.com/")
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(r.text, "lxml")
            for a in soup.select("a[href*='news.naver.com/article']"):
                urls.add(a["href"])
            for a in soup.select("a[href*='n.news.naver.com/article']"):
                urls.add(a["href"])
        except Exception as ex:
            log.warning(f"홈 수집 오류: {ex}")

    log.info(f"수집 URL: {len(urls)}개")
    return list(urls)


# ── 기사 파싱 ─────────────────────────────────────────────
async def parse_article(url: str) -> dict | None:
    async with httpx.AsyncClient(headers=HEADERS, timeout=20, follow_redirects=True) as c:
        try:
            r = await c.get(url)
            if r.status_code != 200:
                return None
            soup = BeautifulSoup(r.text, "lxml")

            title = ""
            for sel in ["h2#title_area span", "#ct h2", ".media_end_head_title"]:
                t = soup.select_one(sel)
                if t:
                    title = t.get_text(strip=True)
                    break

            body = ""
            for sel in ["#dic_area", "#articeBody", ".go_trans._article_content"]:
                t = soup.select_one(sel)
                if t:
                    body = t.get_text(separator="\n", strip=True)
                    break

            images = []
            for img in soup.select("#dic_area img"):
                src = img.get("data-src") or img.get("src", "")
                if src.startswith("http"):
                    images.append(src)

            press = ""
            t = soup.select_one(".media_end_head_top a")
            if t:
                press = t.get_text(strip=True)

            if not title and not body:
                return None

            h = hashlib.sha256((title + body + str(images)).encode()).hexdigest()
            return {
                "url": url, "title": title, "body": body,
                "images": images, "press": press, "hash": h,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as ex:
            log.warning(f"파싱 오류 {url}: {ex}")
            return None


# ── 텔레그램 알림 ─────────────────────────────────────────
async def send_telegram(old: dict, new: dict, url: str, press: str, version: int):
    changes = []
    if old["title"] != new["title"]:
        changes.append(f"📌 제목\n  이전: {old['title']}\n  이후: {new['title']}")
    if old["body"] != new["body"]:
        changes.append(f"📝 본문 변경됨")
    if old.get("images") != new.get("images"):
        changes.append(f"🖼️ 사진 변경됨")

    msg = (
        f"🔴 기사 수정 감지 (v{version})\n\n"
        f"📰 {press}\n"
        f"🕐 {datetime.now(timezone(timedelta(hours=9))).strftime('%Y-%m-%d %H:%M:%S')} (KST)\n"
        f"🔗 {url}\n\n"
        + ("\n\n".join(changes) if changes else "내용 변경 감지")
    )
    async with httpx.AsyncClient(timeout=15) as c:
        await c.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": msg},
        )
    log.info(f"텔레그램 발송: {url}")


# ── 기사 처리 ─────────────────────────────────────────────
async def process_article(url: str):
    parsed = await parse_article(url)
    if not parsed:
        return

    rows = await supa_get("articles", {"url": f"eq.{url}", "select": "*"})
    if not rows:
        record = await supa_post("articles", {"url": url, "current_version": 0})
    else:
        record = rows[0]
    if not record:
        return

    article_id = record["id"]
    versions = await supa_get("article_versions", {
        "article_id": f"eq.{article_id}",
        "select": "*",
        "order": "version.desc",
        "limit": "1",
    })
    latest = versions[0] if versions else None

    if not latest:
        await supa_post("article_versions", {
            "article_id": article_id, "version": 1,
            "title": parsed["title"], "body": parsed["body"],
            "images": parsed["images"], "press": parsed["press"],
            "hash": parsed["hash"], "fetched_at": parsed["fetched_at"],
        })
        await supa_patch("articles", {"id": article_id}, {
            "current_version": 1,
            "title": parsed["title"],
            "press": parsed["press"],
        })
        log.info(f"신규 저장: {parsed['title'][:40]}")
        return

    if latest["hash"] == parsed["hash"]:
        return

    log.info(f"변경 감지: {parsed['title'][:40]}")
    new_v = latest["version"] + 1
    await supa_post("article_versions", {
        "article_id": article_id, "version": new_v,
        "title": parsed["title"], "body": parsed["body"],
        "images": parsed["images"], "press": parsed["press"],
        "hash": parsed["hash"], "fetched_at": parsed["fetched_at"],
    })
    await supa_patch("articles", {"id": article_id}, {
        "current_version": new_v, "title": parsed["title"],
    })
    await send_telegram(latest, parsed, url, parsed["press"], new_v)


# ── 헬스체크 서버 (Render 무료 필수) ─────────────────────
async def health_server():
    app = web.Application()
    app.router.add_get("/", lambda r: web.Response(text="ok"))
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.getenv("PORT", "10000"))
    await web.TCPSite(runner, "0.0.0.0", port).start()
    log.info(f"헬스체크 서버: 포트 {port}")


# ── 메인 루프 ─────────────────────────────────────────────
async def main():
    log.info(f"추적기 시작 — 주기: {CRAWL_INTERVAL_SEC}초")
    await health_server()
    while True:
        start = time.monotonic()
        try:
            urls = await fetch_urls()
            sem = asyncio.Semaphore(5)
            async def run(u):
                async with sem:
                    await process_article(u)
            await asyncio.gather(*[run(u) for u in urls])
        except Exception as ex:
            log.error(f"루프 오류: {ex}")
        await asyncio.sleep(max(0, CRAWL_INTERVAL_SEC - (time.monotonic() - start)))


if __name__ == "__main__":
    asyncio.run(main())
