/**
 * 네이버 뉴스 추적기 — 웹 뷰어
 * Next.js App Router 단일 페이지 (app/page.tsx)
 *
 * 기능:
 *  - 수정된 기사 목록 표시
 *  - 버전 선택 후 제목·본문 diff 하이라이트
 *  - 이전·이후 이미지 나란히 비교
 *
 * 배포: Vercel에 GitHub 연동 후 자동 배포
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ── Supabase 클라이언트 (anon key — 읽기 전용) ──────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── 타입 ──────────────────────────────────────────────────
interface Article {
  id: string;
  url: string;
  title: string;
  press: string;
  current_version: number;
  updated_at: string;
}

interface Version {
  id: string;
  version: number;
  title: string;
  body: string;
  images: string[];
  fetched_at: string;
}

// ── diff 유틸: 변경된 문장을 하이라이트 ──────────────────────
function diffText(oldText: string, newText: string): React.ReactNode {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");
  const result: React.ReactNode[] = [];

  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i] ?? "";
    const n = newLines[i] ?? "";
    if (o === n) {
      result.push(<p key={i} style={{ margin: "2px 0" }}>{n || "\u00A0"}</p>);
    } else if (!o && n) {
      result.push(
        <p key={i} style={{ background: "#d4edda", margin: "2px 0", padding: "1px 4px", borderRadius: 3 }}>
          + {n}
        </p>
      );
    } else if (o && !n) {
      result.push(
        <p key={i} style={{ background: "#f8d7da", margin: "2px 0", padding: "1px 4px", borderRadius: 3, textDecoration: "line-through" }}>
          - {o}
        </p>
      );
    } else {
      result.push(
        <div key={i}>
          <p style={{ background: "#f8d7da", margin: "2px 0", padding: "1px 4px", borderRadius: 3, textDecoration: "line-through" }}>- {o}</p>
          <p style={{ background: "#d4edda", margin: "2px 0", padding: "1px 4px", borderRadius: 3 }}>+ {n}</p>
        </div>
      );
    }
  }
  return <div style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 1.6 }}>{result}</div>;
}

// ── 메인 컴포넌트 ────────────────────────────────────────────
export default function NewsTracker() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [vA, setVersionA] = useState<number>(0);
  const [vB, setVersionB] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  // 수정된 기사 목록 불러오기
  const fetchArticles = useCallback(async () => {
    const { data } = await supabase
      .from("articles")
      .select("*")
      .gt("current_version", 1)          // 2버전 이상 = 최소 1회 수정
      .order("updated_at", { ascending: false })
      .limit(100);
    if (data) setArticles(data);
  }, []);

  useEffect(() => {
    fetchArticles();
    const interval = setInterval(fetchArticles, 60_000); // 1분마다 갱신
    return () => clearInterval(interval);
  }, [fetchArticles]);

  // 기사 선택 → 버전 목록 불러오기
  const selectArticle = async (article: Article) => {
    setSelectedArticle(article);
    setLoading(true);
    const { data } = await supabase
      .from("article_versions")
      .select("*")
      .eq("article_id", article.id)
      .order("version", { ascending: true });
    if (data) {
      setVersions(data);
      // 기본: 마지막 두 버전 비교
      if (data.length >= 2) {
        setVersionA(data[data.length - 2].version);
        setVersionB(data[data.length - 1].version);
      }
    }
    setLoading(false);
  };

  const verA = versions.find((v) => v.version === vA);
  const verB = versions.find((v) => v.version === vB);
  const filteredArticles = articles.filter(
    (a) =>
      a.title?.includes(search) ||
      a.press?.includes(search) ||
      a.url?.includes(search)
  );

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif", fontSize: 14 }}>

      {/* ── 왼쪽 패널: 기사 목록 ── */}
      <div style={{ width: 340, borderRight: "1px solid #e0e0e0", display: "flex", flexDirection: "column", background: "#f9f9f9" }}>
        <div style={{ padding: "16px 12px 8px", borderBottom: "1px solid #e0e0e0" }}>
          <h2 style={{ margin: "0 0 10px", fontSize: 16 }}>📡 수정된 기사 목록</h2>
          <input
            placeholder="제목·언론사 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13, boxSizing: "border-box" }}
          />
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filteredArticles.length === 0 && (
            <p style={{ color: "#999", textAlign: "center", marginTop: 40 }}>수정된 기사가 없습니다</p>
          )}
          {filteredArticles.map((a) => (
            <div
              key={a.id}
              onClick={() => selectArticle(a)}
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid #eee",
                cursor: "pointer",
                background: selectedArticle?.id === a.id ? "#e8f0fe" : "transparent",
                transition: "background 0.15s",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 3, lineHeight: 1.4 }}>{a.title || "제목 없음"}</div>
              <div style={{ color: "#666", fontSize: 12 }}>
                {a.press} · v{a.current_version}회 수정 · {new Date(a.updated_at).toLocaleString("ko-KR")}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 오른쪽 패널: 버전 비교 ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        {!selectedArticle && (
          <div style={{ textAlign: "center", color: "#999", marginTop: 100 }}>
            <div style={{ fontSize: 40 }}>📰</div>
            <p>왼쪽에서 기사를 선택하면 버전 비교가 표시됩니다</p>
          </div>
        )}

        {selectedArticle && (
          <>
            {/* 기사 정보 */}
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>{selectedArticle.title}</h2>
              <a href={selectedArticle.url} target="_blank" rel="noreferrer" style={{ color: "#1a73e8", fontSize: 13 }}>
                {selectedArticle.url}
              </a>
            </div>

            {/* 버전 선택기 */}
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 20, background: "#f0f4ff", padding: "10px 14px", borderRadius: 8 }}>
              <label style={{ fontWeight: 600 }}>비교:</label>
              <select value={vA} onChange={(e) => setVersionA(Number(e.target.value))}
                style={{ padding: "4px 8px", borderRadius: 5, border: "1px solid #ccc" }}>
                {versions.map((v) => (
                  <option key={v.id} value={v.version}>
                    v{v.version} — {new Date(v.fetched_at).toLocaleString("ko-KR")}
                  </option>
                ))}
              </select>
              <span>↔</span>
              <select value={vB} onChange={(e) => setVersionB(Number(e.target.value))}
                style={{ padding: "4px 8px", borderRadius: 5, border: "1px solid #ccc" }}>
                {versions.map((v) => (
                  <option key={v.id} value={v.version}>
                    v{v.version} — {new Date(v.fetched_at).toLocaleString("ko-KR")}
                  </option>
                ))}
              </select>
            </div>

            {loading && <p style={{ color: "#999" }}>로딩 중...</p>}

            {verA && verB && !loading && (
              <>
                {/* 제목 비교 */}
                {verA.title !== verB.title && (
                  <section style={{ marginBottom: 24 }}>
                    <h3 style={{ margin: "0 0 10px", fontSize: 15, color: "#333" }}>📌 제목 변경</h3>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div style={{ background: "#fff5f5", border: "1px solid #f5c6c6", borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 600, marginBottom: 6 }}>수정 전 (v{vA})</div>
                        <div>{verA.title}</div>
                      </div>
                      <div style={{ background: "#f0fff4", border: "1px solid #b2dfdb", borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 11, color: "#27ae60", fontWeight: 600, marginBottom: 6 }}>수정 후 (v{vB})</div>
                        <div>{verB.title}</div>
                      </div>
                    </div>
                  </section>
                )}

                {/* 본문 diff */}
                <section style={{ marginBottom: 24 }}>
                  <h3 style={{ margin: "0 0 10px", fontSize: 15, color: "#333" }}>📝 본문 비교</h3>
                  <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: 16, maxHeight: 500, overflowY: "auto" }}>
                    {verA.body === verB.body
                      ? <p style={{ color: "#999" }}>본문 변경 없음</p>
                      : diffText(verA.body, verB.body)
                    }
                  </div>
                </section>

                {/* 사진 비교 */}
                <section style={{ marginBottom: 24 }}>
                  <h3 style={{ margin: "0 0 10px", fontSize: 15, color: "#333" }}>🖼️ 사진 비교</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#c0392b", marginBottom: 8 }}>수정 전 (v{vA})</div>
                      {(verA.images || []).length === 0
                        ? <p style={{ color: "#999" }}>사진 없음</p>
                        : (verA.images || []).map((img, i) => (
                            <img key={i} src={img} alt="" style={{ width: "100%", borderRadius: 6, marginBottom: 8, border: "1px solid #ddd" }} />
                          ))
                      }
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#27ae60", marginBottom: 8 }}>수정 후 (v{vB})</div>
                      {(verB.images || []).length === 0
                        ? <p style={{ color: "#999" }}>사진 없음</p>
                        : (verB.images || []).map((img, i) => (
                            <img key={i} src={img} alt="" style={{ width: "100%", borderRadius: 6, marginBottom: 8, border: "1px solid #ddd" }} />
                          ))
                      }
                    </div>
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
