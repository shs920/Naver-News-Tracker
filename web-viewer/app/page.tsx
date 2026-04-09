"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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

function extractImageFilename(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.split("/").pop() || url;
  } catch {
    return url;
  }
}

function compareImages(oldImgs: string[], newImgs: string[]) {
  const old_ = oldImgs || [];
  const new_ = newImgs || [];
  const result: {
    type: "same" | "uncertain" | "removed" | "added";
    oldUrl?: string;
    newUrl?: string;
  }[] = [];
  const usedNew = new Set<number>();

  old_.forEach((oldUrl) => {
    const oldFile = extractImageFilename(oldUrl);
    const exactIdx = new_.findIndex((u, i) => !usedNew.has(i) && u === oldUrl);
    if (exactIdx !== -1) {
      usedNew.add(exactIdx);
      result.push({ type: "same", oldUrl, newUrl: new_[exactIdx] });
      return;
    }
    const nameIdx = new_.findIndex(
      (u, i) => !usedNew.has(i) && extractImageFilename(u) === oldFile
    );
    if (nameIdx !== -1) {
      usedNew.add(nameIdx);
      result.push({ type: "uncertain", oldUrl, newUrl: new_[nameIdx] });
      return;
    }
    result.push({ type: "removed", oldUrl });
  });

  new_.forEach((newUrl, i) => {
    if (!usedNew.has(i)) result.push({ type: "added", newUrl });
  });

  return { result, changed: result.some((r) => r.type !== "same") };
}

function splitSentences(text: string): string[] {
  return (text || "").split(/(?<=[.!?。])\s+|\n+/).filter((s) => s.trim().length > 0);
}

type DiffItem = { type: "same"|"del"|"add"|"change"; old?: string; new?: string };

function diffSentences(oldText: string, newText: string): DiffItem[] {
  const oldS = splitSentences(oldText);
  const newS = splitSentences(newText);
  const m = oldS.length, n = newS.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldS[i-1] === newS[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);

  const raw: DiffItem[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldS[i-1] === newS[j-1]) {
      raw.unshift({ type: "same", old: oldS[i-1], new: newS[j-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      raw.unshift({ type: "add", new: newS[j-1] }); j--;
    } else {
      raw.unshift({ type: "del", old: oldS[i-1] }); i--;
    }
  }

  const merged: DiffItem[] = [];
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].type === "del" && raw[k+1]?.type === "add") {
      merged.push({ type: "change", old: raw[k].old, new: raw[k+1].new }); k++;
    } else {
      merged.push(raw[k]);
    }
  }
  return merged;
}

function BodyDiff({ oldText, newText, vA, vB }: { oldText: string; newText: string; vA: number; vB: number }) {
  const diff = diffSentences(oldText, newText);
  const hl: React.CSSProperties = { background: "#ffd6d6", borderRadius: 4, padding: "2px 6px", color: "#7a0000", fontSize: 13, lineHeight: 1.7, margin: "3px 0" };
  const nm: React.CSSProperties = { fontSize: 13, lineHeight: 1.7, margin: "3px 0", color: "var(--color-text-primary)" };
  const em: React.CSSProperties = { margin: "3px 0", minHeight: 22 };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: "#c0392b" }}>수정 전 (v{vA})</div>
        <div style={{ fontSize: 11, fontWeight: 500, color: "#c0392b" }}>수정 후 (v{vB})</div>
      </div>
      {diff.map((d, idx) => (
        <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 2 }}>
          <div>
            {d.type === "same"   && <p style={nm}>{d.old}</p>}
            {d.type === "del"    && <p style={hl}>{d.old}</p>}
            {d.type === "add"    && <p style={em} />}
            {d.type === "change" && <p style={hl}>{d.old}</p>}
          </div>
          <div>
            {d.type === "same"   && <p style={nm}>{d.new}</p>}
            {d.type === "del"    && <p style={em} />}
            {d.type === "add"    && <p style={hl}>{d.new}</p>}
            {d.type === "change" && <p style={hl}>{d.new}</p>}
          </div>
        </div>
      ))}
    </>
  );
}

export default function NewsTracker() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [selected, setSelected] = useState<Article | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [vA, setVersionA] = useState(0);
  const [vB, setVersionB] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  const fetchArticles = useCallback(async () => {
    const { data } = await supabase.from("articles").select("*")
      .gt("current_version", 1).order("updated_at", { ascending: false }).limit(100);
    if (data) setArticles(data);
  }, []);

  useEffect(() => {
    fetchArticles();
    const t = setInterval(fetchArticles, 60000);
    return () => clearInterval(t);
  }, [fetchArticles]);

  const selectArticle = async (a: Article) => {
    setSelected(a); setLoading(true);
    const { data } = await supabase.from("article_versions").select("*")
      .eq("article_id", a.id).order("version", { ascending: true });
    if (data) {
      setVersions(data);
      if (data.length >= 2) { setVersionA(data[data.length-2].version); setVersionB(data[data.length-1].version); }
    }
    setLoading(false);
  };

  const verA = versions.find((v) => v.version === vA);
  const verB = versions.find((v) => v.version === vB);
  const filtered = articles.filter((a) => a.title?.includes(search) || a.press?.includes(search) || a.url?.includes(search));
  const imgDiff = verA && verB ? compareImages(verA.images || [], verB.images || []) : null;
  const titleChanged = verA && verB && verA.title !== verB.title;
  const bodyChanged  = verA && verB && verA.body  !== verB.body;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif", fontSize: 14 }}>

      {/* 왼쪽 목록 */}
      <div style={{ width: 300, borderRight: "1px solid #e0e0e0", display: "flex", flexDirection: "column", background: "#f9f9f9", flexShrink: 0 }}>
        <div style={{ padding: "14px 12px 8px", borderBottom: "1px solid #e0e0e0" }}>
          <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>📡 수정된 기사 목록</h2>
          <input placeholder="제목·언론사 검색" value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13, boxSizing: "border-box" }} />
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filtered.length === 0 && <p style={{ color: "#999", textAlign: "center", marginTop: 40 }}>수정된 기사가 없습니다</p>}
          {filtered.map((a) => (
            <div key={a.id} onClick={() => selectArticle(a)}
              style={{ padding: "10px 12px", borderBottom: "1px solid #eee", cursor: "pointer", background: selected?.id === a.id ? "#e8f0fe" : "transparent" }}>
              <div style={{ fontWeight: 600, marginBottom: 3, lineHeight: 1.4, fontSize: 13 }}>{a.title || "제목 없음"}</div>
              <div style={{ color: "#666", fontSize: 11 }}>{a.press} · v{a.current_version}회 수정 · {new Date(a.updated_at).toLocaleString("ko-KR")}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 오른쪽 비교 */}
      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        {!selected && (
          <div style={{ textAlign: "center", color: "#999", marginTop: 100 }}>
            <div style={{ fontSize: 40 }}>📰</div>
            <p>왼쪽에서 기사를 선택하면 버전 비교가 표시됩니다</p>
          </div>
        )}

        {selected && (
          <>
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ margin: "0 0 6px", fontSize: 17 }}>{selected.title}</h2>
              <a href={selected.url} target="_blank" rel="noreferrer" style={{ color: "#1a73e8", fontSize: 12 }}>{selected.url}</a>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 24, background: "#f0f4ff", padding: "10px 14px", borderRadius: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>비교:</span>
              <select value={vA} onChange={(e) => setVersionA(Number(e.target.value))}
                style={{ padding: "4px 8px", borderRadius: 5, border: "1px solid #ccc", fontSize: 12 }}>
                {versions.map((v) => <option key={v.id} value={v.version}>v{v.version} — {new Date(v.fetched_at).toLocaleString("ko-KR")}</option>)}
              </select>
              <span>↔</span>
              <select value={vB} onChange={(e) => setVersionB(Number(e.target.value))}
                style={{ padding: "4px 8px", borderRadius: 5, border: "1px solid #ccc", fontSize: 12 }}>
                {versions.map((v) => <option key={v.id} value={v.version}>v{v.version} — {new Date(v.fetched_at).toLocaleString("ko-KR")}</option>)}
              </select>
            </div>

            {loading && <p style={{ color: "#999" }}>로딩 중...</p>}

            {verA && verB && !loading && (
              <>
                {/* 제목 비교 */}
                {titleChanged && (
                  <section style={{ marginBottom: 28 }}>
                    <h3 style={{ margin: "0 0 10px", fontSize: 14, color: "#333" }}>📌 제목 변경</h3>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div style={{ background: "#fff5f5", border: "1px solid #f5c6c6", borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 600, marginBottom: 6 }}>수정 전 (v{vA})</div>
                        <div style={{ background: "#ffd6d6", borderRadius: 4, padding: "4px 8px", color: "#7a0000", fontSize: 13, lineHeight: 1.6 }}>{verA.title}</div>
                      </div>
                      <div style={{ background: "#fff5f5", border: "1px solid #f5c6c6", borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 600, marginBottom: 6 }}>수정 후 (v{vB})</div>
                        <div style={{ background: "#ffd6d6", borderRadius: 4, padding: "4px 8px", color: "#7a0000", fontSize: 13, lineHeight: 1.6 }}>{verB.title}</div>
                      </div>
                    </div>
                  </section>
                )}

                {/* 본문 비교 */}
                <section style={{ marginBottom: 28 }}>
                  <h3 style={{ margin: "0 0 10px", fontSize: 14, color: "#333" }}>📝 본문 비교</h3>
                  {!bodyChanged ? (
                    <p style={{ color: "#999", fontSize: 13 }}>본문 변경 없음</p>
                  ) : (
                    <div style={{ maxHeight: 600, overflowY: "auto", border: "1px solid #e0e0e0", borderRadius: 8, padding: "14px 16px", background: "var(--color-background-primary)" }}>
                      <BodyDiff oldText={verA.body} newText={verB.body} vA={vA} vB={vB} />
                    </div>
                  )}
                </section>

                {/* 사진 비교 — 3단계 */}
                <section style={{ marginBottom: 28 }}>
                  <h3 style={{ margin: "0 0 10px", fontSize: 14, color: "#333" }}>🖼️ 사진 비교</h3>
                  {!imgDiff?.changed ? (
                    <p style={{ color: "#999", fontSize: 13 }}>사진 변경 없음</p>
                  ) : (
                    imgDiff.result.map((item, i) => {
                      if (item.type === "same") return null;

                      if (item.type === "uncertain") return (
                        <div key={i} style={{ marginBottom: 20 }}>
                          <div style={{ background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 8, padding: "8px 12px", marginBottom: 10, fontSize: 12, color: "#7a5c00" }}>
                            ⚠️ 파일명은 같지만 URL이 다릅니다 — 육안으로 직접 비교해 주세요
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            <div>
                              <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 600, marginBottom: 6 }}>이전 사진</div>
                              <img src={item.oldUrl} alt="" style={{ width: "100%", borderRadius: 6, border: "1px solid #ddd" }} />
                            </div>
                            <div>
                              <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 600, marginBottom: 6 }}>현재 사진</div>
                              <img src={item.newUrl} alt="" style={{ width: "100%", borderRadius: 6, border: "1px solid #ddd" }} />
                            </div>
                          </div>
                        </div>
                      );

                      if (item.type === "removed") return (
                        <div key={i} style={{ marginBottom: 16 }}>
                          <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 600, marginBottom: 6 }}>🗑️ 삭제된 사진</div>
                          <img src={item.oldUrl} alt="" style={{ width: "50%", borderRadius: 6, border: "2px solid #f5c6c6" }} />
                        </div>
                      );

                      if (item.type === "added") return (
                        <div key={i} style={{ marginBottom: 16 }}>
                          <div style={{ fontSize: 11, color: "#27ae60", fontWeight: 600, marginBottom: 6 }}>➕ 추가된 사진</div>
                          <img src={item.newUrl} alt="" style={{ width: "50%", borderRadius: 6, border: "2px solid #b2dfdb" }} />
                        </div>
                      );

                      return null;
                    })
                  )}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
