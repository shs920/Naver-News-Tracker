"""
네이버 뉴스 추적기 - 완성본 v3
개선사항:
- 이미지 URL을 해시에서 제외 → 사진 오탐 완전 차단
- 단순 오탈자(변경량 5% 미만) 알림 생략, DB만 저장
- 기사 삭제 감지 → 텔레그램 알림
- Render 무료 호환 헬스체크 서버
"""

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

KST = timezone(timedelta(hours=9))

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
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

DELETED_KEYWORDS = [
    "삭제된 기사",
    "존재하지 않는 기사",
    "서비스하지 않는 기사",
    "이 기사는 언론사가 삭제했습니다",
    "요청하신 페이지를 찾을 수 없습니다",
]

# 오탈자 필터: 변경된 단어 비율이 이 값 미만이면 알림 생략
TYPO_THRESHOLD = 0.05  # 5%


# ── Supabase REST API ─────────────────────────────────────
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


# ── RSS + 홈페이지에서 URL 수집 ───────────────────────────
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

        try:
            r = await c.get("https://news.naver.com/")
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

            # ★ 이미지 URL은 해시에서 제외 → 사진 URL 재발급으로 인한 오탐 차단
            h = hashlib.sha256((title + body).encode()).hexdigest()

            return {
                "url": url, "title": title, "body": body,
                "images": images, "press": press, "hash": h,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as ex:
            log.warning(f"파싱 오류 {url}: {ex}")
            return None


# ── 오탈자 여부 판단 ──────────────────────────────────────
def is_typo_only(old_title: str, new_title: str, old_body: str, new_body: str) -> bool:
    """변경량이 전체 단어 대비 TYPO_THRESHOLD 미만이면 단순 오탈자로 판단."""
    # 제목이 바뀌었으면 무조건 알림
    if old_title != new_title:
        return False

    old_words = set(old_body.split())
    new_words = set(new_body.split())
    changed = len(old_words.symmetric_difference(new_words))
    total = max(len(old_words | new_words), 1)
    return (changed / total) < TYPO_THRESHOLD


# ── 삭제 여부 확인 ────────────────────────────────────────
async def check_deleted(url: str) -> bool:
    async with httpx.AsyncClient(headers=HEADERS, timeout=20, follow_redirects=False) as c:
        try:
            r = await c.get(url)
            if r.status_code == 404:
                return True
            if r.status_code in (301, 302, 303):
                location = r.headers.get("location", "")
                if ("news.naver.com/article" not in location and
                        "n.news.naver.com/article" not in location):
                    return True
            if r.status_code == 200:
                if any(kw in r.text for kw in DELETED_KEYWORDS):
                    return True
        except Exception:
            pass
    return False


# ── 텔레그램: 기사 수정 알림 ─────────────────────────────
async def send_telegram_modified(old: dict, new: dict, url: str, press: str, version: int):
    changes = []
    if old["title"] != new["title"]:
        changes.append(f"📌 제목 변경\n  이전: {old['title']}\n  이후: {new['title']}")
    if old["body"] != new["body"]:
        changes.append("📝 본문 변경됨")

    msg = (
        f"🔴 기사 수정 감지! (v{version})\n\n"
        f"📰 {press}\n"
        f"🕐 {datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S')} (KST)\n"
        f"🔗 {url}\n\n"
        + ("\n\n".join(changes) if changes else "내용 변경 감지") +
        "\n\n👉 웹 뷰어에서 전체 비교 확인 가능"
    )
    async with httpx.AsyncClient(timeout=15) as c:
        await c.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": msg},
        )
    log.info(f"텔레그램 수정 알림: {url}")


# ── 텔레그램: 기사 삭제 알림 ─────────────────────────────
async def send_telegram_deleted(record: dict, url: str):
    msg = (
        f"🚨 기사 삭제 감지!\n\n"
        f"📰 {record.get('press', '알 수 없음')}\n"
        f"📌 {record.get('title', '제목 없음')}\n"
        f"🕐 {datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S')} (KST)\n"
        f"🔗 {url}\n\n"
        f"⚠️ 이 기사는 네이버에서 삭제되었습니다.\n"
        f"👉 웹 뷰어에서 삭제 전 마지막 내용 확인 가능"
    )
    async with httpx.AsyncClient(timeout=15) as c:
        await c.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": msg},
        )
    log.info(f"텔레그램 삭제 알림: {url}")


# ── 삭제된 기사 DB 처리 ───────────────────────────────────
async def handle_deleted_article(url: str):
    rows = await supa_get("articles", {"url": f"eq.{url}", "select": "*"})
    if not rows:
        return
    record = rows[0]
    if record.get("is_deleted"):
        return
    article_id = record["id"]
    log.info(f"기사 삭제 처리: {record.get('title', url)[:40]}")
    await supa_patch("articles", {"id": article_id}, {
        "is_deleted": True,
        "deleted_at": datetime.now(KST).isoformat(),
    })
    await send_telegram_deleted(record, url)


# ── 기사 1개 처리 파이프라인 ─────────────────────────────
async def process_article(url: str):
    # 1. 삭제 여부 먼저 확인
    if await check_deleted(url):
        await handle_deleted_article(url)
        return

    # 2. 정상 기사 파싱
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

    if record.get("is_deleted"):
        return

    versions = await supa_get("article_versions", {
        "article_id": f"eq.{article_id}",
        "select": "*",
        "order": "version.desc",
        "limit": "1",
    })
    latest = versions[0] if versions else None

    # 최초 수집
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

    # 변경 없으면 종료
    if latest["hash"] == parsed["hash"]:
        return

    # 새 버전 항상 저장 (오탈자 포함)
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

    # ★ 오탈자 수준이면 DB만 저장, 텔레그램 알림 생략
    if is_typo_only(latest["title"], parsed["title"], latest["body"], parsed["body"]):
        log.info(f"오탈자 수준 변경 (알림 생략): {parsed['title'][:40]}")
        return

    log.info(f"변경 감지 (알림 발송): {parsed['title'][:40]}")
    await send_telegram_modified(latest, parsed, url, parsed["press"], new_v)


# ── 헬스체크 서버 ─────────────────────────────────────────
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
