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
  is_deleted: boolean;
  deleted_at: string | null;
}

interface Version {
  id: string;
  version: number;
  title: string;
  body: string;
  images: string[];
  fetched_at: string;
}

// ── 이미지 비교 (3단계) ───────────────────────────────────
function extractFilename(url: string): string {
  try { return new URL(url).pathname.split("/").pop() || url; }
  catch { return url; }
}

function compareImages(oldImgs: string[], newImgs: string[]) {
  const old_ = oldImgs || [], new_ = newImgs || [];
  const result: { type: "same"|"uncertain"|"removed"|"added"; oldUrl?: string; newUrl?: string }[] = [];
  const used = new Set<number>();
  old_.forEach((ou) => {
    const of_ = extractFilename(ou);
    const ei = new_.findIndex((u, i) => !used.has(i) && u === ou);
    if (ei !== -1) { used.add(ei); result.push({ type: "same", oldUrl: ou, newUrl: new_[ei] }); return; }
    const ni = new_.findIndex((u, i) => !used.has(i) && extractFilename(u) === of_);
    if (ni !== -1) { used.add(ni); result.push({ type: "uncertain", oldUrl: ou, newUrl: new_[ni] }); return; }
    result.push({ type: "removed", oldUrl: ou });
  });
  new_.forEach((nu, i) => { if (!used.has(i)) result.push({ type: "added", newUrl: nu }); });
  return { result, changed: result.some(r => r.type !== "same") };
}

// ── 단어 단위 토큰 diff ───────────────────────────────────
type Token = { text: string; changed: boolean };

function wordDiff(oldText: string, newText: string): { old: Token[]; new: Token[] } {
  // 공백 포함 토큰 분리
  const tokenize = (t: string) => t.split(/(\s+)/);
  const oldW = tokenize(oldText || "");
  const newW = tokenize(newText || "");
  const m = oldW.length, n = newW.length;

  const dp: number[][] = Array.from({ length: m+1 }, () => new Array(n+1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldW[i-1] === newW[j-1]
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);

  type Op = { type: "same"|"del"|"add"; text: string };
  const ops: Op[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldW[i-1] === newW[j-1]) {
      ops.unshift({ type: "same", text: oldW[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      ops.unshift({ type: "add", text: newW[j-1] }); j--;
    } else {
      ops.unshift({ type: "del", text: oldW[i-1] }); i--;
    }
  }

  const oldTokens: Token[] = [];
  const newTokens: Token[] = [];
  ops.forEach(op => {
    if (op.type === "same") {
      oldTokens.push({ text: op.text, changed: false });
      newTokens.push({ text: op.text, changed: false });
    } else if (op.type === "del") {
      oldTokens.push({ text: op.text, changed: true });
    } else {
      newTokens.push({ text: op.text, changed: true });
    }
  });
  return { old: oldTokens, new: newTokens };
}

// 토큰 배열 → React 노드 (변경된 단어: 붉은 형광펜 + 볼드)
function renderTokens(tokens: Token[]): React.ReactNode {
  return tokens.map((tok, i) =>
    tok.changed
      ? <mark key={i} style={{
          background: "#ffd6d6",
          color: "#7a0000",
          fontWeight: 700,
          borderRadius: 3,
          padding: "0 2px",
        }}>{tok.text}</mark>
      : <span key={i}>{tok.text}</span>
  );
}

// ── 본문 전문 비교 컴포넌트 ───────────────────────────────
// 문단 단위 LCS → 변경된 문단에 단어 단위 하이라이트
type ParaDiff = { type: "same"|"del"|"add"|"change"; old?: string; new?: string };

function paragraphDiff(oldText: string, newText: string): ParaDiff[] {
  const split = (t: string) => (t || "").split(/\n+/).filter(p => p.trim());
  const oldP = split(oldText), newP = split(newText);
  const m = oldP.length, n = newP.length;
  const dp: number[][] = Array.from({ length: m+1 }, () => new Array(n+1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldP[i-1] === newP[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);

  const raw: ParaDiff[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldP[i-1] === newP[j-1]) {
      raw.unshift({ type: "same", old: oldP[i-1], new: newP[j-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      raw.unshift({ type: "add", new: newP[j-1] }); j--;
    } else {
      raw.unshift({ type: "del", old: oldP[i-1] }); i--;
    }
  }
  const merged: ParaDiff[] = [];
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].type === "del" && raw[k+1]?.type === "add") {
      merged.push({ type: "change", old: raw[k].old, new: raw[k+1].new }); k++;
    } else merged.push(raw[k]);
  }
  return merged;
}

function BodyDiff({ oldText, newText, vA, vB }: {
  oldText: string; newText: string; vA: number; vB: number;
}) {
  const diff = paragraphDiff(oldText, newText);

  const colHeader = (label: string) => (
    <div style={{
      fontSize: 12, fontWeight: 700, color: "#c0392b",
      marginBottom: 10, paddingBottom: 6,
      borderBottom: "2px solid #f5c6c6",
    }}>{label}</div>
  );

  // 왼쪽/오른쪽 문단 목록 생성
  const leftParas: React.ReactNode[] = [];
  const rightParas: React.ReactNode[] = [];

  diff.forEach((d, idx) => {
    const key = idx;
    if (d.type === "same") {
      leftParas.push(
        <p key={key} style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.8, color: "var(--color-text-primary)" }}>
          {d.old}
        </p>
      );
      rightParas.push(
        <p key={key} style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.8, color: "var(--color-text-primary)" }}>
          {d.new}
        </p>
      );
    } else if (d.type === "del") {
      leftParas.push(
        <p key={key} style={{
          margin: "0 0 10px", fontSize: 13, lineHeight: 1.8,
          background: "#ffd6d6", borderRadius: 4, padding: "4px 8px",
          borderLeft: "3px solid #e53935",
        }}>
          <strong style={{ color: "#7a0000", fontWeight: 700 }}>{d.old}</strong>
        </p>
      );
      rightParas.push(
        <div key={key} style={{ margin: "0 0 10px", minHeight: 28 }} />
      );
    } else if (d.type === "add") {
      leftParas.push(
        <div key={key} style={{ margin: "0 0 10px", minHeight: 28 }} />
      );
      rightParas.push(
        <p key={key} style={{
          margin: "0 0 10px", fontSize: 13, lineHeight: 1.8,
          background: "#ffd6d6", borderRadius: 4, padding: "4px 8px",
          borderLeft: "3px solid #e53935",
        }}>
          <strong style={{ color: "#7a0000", fontWeight: 700 }}>{d.new}</strong>
        </p>
      );
    } else {
      // change: 단어 단위 하이라이트
      const wdiff = wordDiff(d.old!, d.new!);
      leftParas.push(
        <p key={key} style={{
          margin: "0 0 10px", fontSize: 13, lineHeight: 1.8,
          background: "#fff0f0", borderRadius: 4, padding: "4px 8px",
          borderLeft: "3px solid #e57373",
        }}>
          {renderTokens(wdiff.old)}
        </p>
      );
      rightParas.push(
        <p key={key} style={{
          margin: "0 0 10px", fontSize: 13, lineHeight: 1.8,
          background: "#fff0f0", borderRadius: 4, padding: "4px 8px",
          borderLeft: "3px solid #e57373",
        }}>
          {renderTokens(wdiff.new)}
        </p>
      );
    }
  });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div>
        {colHeader(`수정 전 (v${vA})`)}
        {leftParas}
      </div>
      <div>
        {colHeader(`수정 후 (v${vB})`)}
        {rightParas}
      </div>
    </div>
  );
}

// ── 제목 비교 컴포넌트 ────────────────────────────────────
function TitleDiff({ oldTitle, newTitle, vA, vB }: {
  oldTitle: string; newTitle: string; vA: number; vB: number;
}) {
  const wdiff = wordDiff(oldTitle, newTitle);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div style={{ background: "#fff5f5", border: "1px solid #f5c6c6", borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 700, marginBottom: 8 }}>수정 전 (v{vA})</div>
        <div style={{ fontSize: 15, lineHeight: 1.6 }}>{renderTokens(wdiff.old)}</div>
      </div>
      <div style={{ background: "#fff5f5", border: "1px solid #f5c6c6", borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 700, marginBottom: 8 }}>수정 후 (v{vB})</div>
        <div style={{ fontSize: 15, lineHeight: 1.6 }}>{renderTokens(wdiff.new)}</div>
      </div>
    </div>
  );
}

// ── 삭제된 기사 뷰 ───────────────────────────────────────
function DeletedView({ article, versions }: { article: Article; versions: Version[] }) {
  const last = versions[versions.length - 1];
  if (!last) return <p style={{ color: "#999" }}>저장된 내용이 없습니다</p>;
  const paras = (last.body || "").split(/\n+/).filter(p => p.trim());
  return (
    <div>
      <div style={{ background: "#fff3cd", border: "1px solid #ffc107", borderRadius: 8, padding: "12px 16px", marginBottom: 20 }}>
        <div style={{ fontWeight: 700, color: "#7a4f00", marginBottom: 4 }}>🚨 삭제된 기사</div>
        <div style={{ fontSize: 13, color: "#7a4f00" }}>
          이 기사는 네이버에서 삭제됐습니다.
          {article.deleted_at && <> 삭제 감지: {new Date(article.deleted_at).toLocaleString("ko-KR")}</>}
        </div>
      </div>
      <section style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 14, color: "#333", margin: "0 0 8px" }}>📌 삭제 전 마지막 제목 (v{last.version})</h3>
        <div style={{ background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 8, padding: "10px 14px", fontSize: 15, fontWeight: 500 }}>{last.title}</div>
      </section>
      <section style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 14, color: "#333", margin: "0 0 8px" }}>📝 삭제 전 마지막 본문</h3>
        <div style={{ background: "#fffde7", border: "1px solid #fff9c4", borderRadius: 8, padding: "14px 16px", fontSize: 13, lineHeight: 1.8, maxHeight: 500, overflowY: "auto" }}>
          {paras.map((p, i) => <p key={i} style={{ margin: "4px 0" }}>{p}</p>)}
        </div>
      </section>
      {(last.images || []).length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, color: "#333", margin: "0 0 8px" }}>🖼️ 삭제 전 마지막 사진</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 12 }}>
            {(last.images || []).map((img, i) => (
              <img key={i} src={img} alt="" style={{ width: "100%", borderRadius: 6, border: "1px solid #ddd" }} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── 메인 컴포넌트 ────────────────────────────────────────
export default function NewsTracker() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [selected, setSelected] = useState<Article | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [vA, setVersionA] = useState(0);
  const [vB, setVersionB] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"modified"|"deleted">("modified");

  const fetchArticles = useCallback(async () => {
    const { data } = await supabase.from("articles").select("*")
      .order("updated_at", { ascending: false }).limit(200);
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
      else if (data.length === 1) { setVersionA(data[0].version); setVersionB(data[0].version); }
    }
    setLoading(false);
  };

  const verA = versions.find(v => v.version === vA);
  const verB = versions.find(v => v.version === vB);

  const modifiedList = articles.filter(a =>
    !a.is_deleted && a.current_version > 1 &&
    (a.title?.includes(search) || a.press?.includes(search))
  );
  const deletedList = articles.filter(a =>
    a.is_deleted && (a.title?.includes(search) || a.press?.includes(search))
  );
  const activeList = tab === "modified" ? modifiedList : deletedList;

  const imgDiff = verA && verB ? compareImages(verA.images || [], verB.images || []) : null;
  const titleChanged = verA && verB && verA.title !== verB.title;
  const bodyChanged  = verA && verB && verA.body  !== verB.body;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif", fontSize: 14 }}>

      {/* ── 왼쪽 목록 ── */}
      <div style={{ width: 300, borderRight: "1px solid #e0e0e0", display: "flex", flexDirection: "column", background: "#f9f9f9", flexShrink: 0 }}>
        <div style={{ padding: "14px 12px 8px", borderBottom: "1px solid #e0e0e0" }}>
          <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>📡 네이버 뉴스 추적기</h2>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <button onClick={() => { setTab("modified"); setSelected(null); }}
              style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "1px solid #ccc", fontSize: 12, fontWeight: 600, cursor: "pointer",
                background: tab === "modified" ? "#1a73e8" : "#fff", color: tab === "modified" ? "#fff" : "#333" }}>
              ✏️ 수정 ({modifiedList.length})
            </button>
            <button onClick={() => { setTab("deleted"); setSelected(null); }}
              style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "1px solid #ccc", fontSize: 12, fontWeight: 600, cursor: "pointer",
                background: tab === "deleted" ? "#e53935" : "#fff", color: tab === "deleted" ? "#fff" : "#333" }}>
              🚨 삭제 ({deletedList.length})
            </button>
          </div>
          <input placeholder="제목·언론사 검색" value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: "100%", padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13, boxSizing: "border-box" }} />
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {activeList.length === 0 && (
            <p style={{ color: "#999", textAlign: "center", marginTop: 40, fontSize: 13 }}>
              {tab === "modified" ? "수정된 기사가 없습니다" : "삭제된 기사가 없습니다"}
            </p>
          )}
          {activeList.map(a => (
            <div key={a.id} onClick={() => selectArticle(a)}
              style={{ padding: "10px 12px", borderBottom: "1px solid #eee", cursor: "pointer",
                background: selected?.id === a.id ? (a.is_deleted ? "#ffebee" : "#e8f0fe") : "transparent" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 4, marginBottom: 3 }}>
                {a.is_deleted && (
                  <span style={{ fontSize: 10, background: "#e53935", color: "#fff", borderRadius: 4, padding: "1px 5px", flexShrink: 0, marginTop: 2 }}>삭제</span>
                )}
                <div style={{ fontWeight: 600, lineHeight: 1.4, fontSize: 13 }}>{a.title || "제목 없음"}</div>
              </div>
              <div style={{ color: "#666", fontSize: 11 }}>
                {a.press} · {a.is_deleted
                  ? `삭제: ${a.deleted_at ? new Date(a.deleted_at).toLocaleString("ko-KR") : "알 수 없음"}`
                  : `v${a.current_version}회 수정 · ${new Date(a.updated_at).toLocaleString("ko-KR")}`}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 오른쪽 비교 뷰 ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        {!selected && (
          <div style={{ textAlign: "center", color: "#999", marginTop: 100 }}>
            <div style={{ fontSize: 40 }}>{tab === "deleted" ? "🚨" : "📰"}</div>
            <p>왼쪽에서 기사를 선택하면 내용이 표시됩니다</p>
          </div>
        )}

        {selected && loading && <p style={{ color: "#999" }}>로딩 중...</p>}

        {/* 삭제된 기사 */}
        {selected && !loading && selected.is_deleted && (
          <>
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ margin: "0 0 6px", fontSize: 17 }}>{selected.title}</h2>
              <a href={selected.url} target="_blank" rel="noreferrer" style={{ color: "#1a73e8", fontSize: 12 }}>{selected.url}</a>
            </div>
            <DeletedView article={selected} versions={versions} />
          </>
        )}

        {/* 수정된 기사 */}
        {selected && !loading && !selected.is_deleted && (
          <>
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ margin: "0 0 6px", fontSize: 17 }}>{selected.title}</h2>
              <a href={selected.url} target="_blank" rel="noreferrer" style={{ color: "#1a73e8", fontSize: 12 }}>{selected.url}</a>
            </div>

            {/* 버전 선택 */}
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 24, background: "#f0f4ff", padding: "10px 14px", borderRadius: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>비교:</span>
              <select value={vA} onChange={e => setVersionA(Number(e.target.value))}
                style={{ padding: "4px 8px", borderRadius: 5, border: "1px solid #ccc", fontSize: 12 }}>
                {versions.map(v => (
                  <option key={v.id} value={v.version}>v{v.version} — {new Date(v.fetched_at).toLocaleString("ko-KR")}</option>
                ))}
              </select>
              <span>↔</span>
              <select value={vB} onChange={e => setVersionB(Number(e.target.value))}
                style={{ padding: "4px 8px", borderRadius: 5, border: "1px solid #ccc", fontSize: 12 }}>
                {versions.map(v => (
                  <option key={v.id} value={v.version}>v{v.version} — {new Date(v.fetched_at).toLocaleString("ko-KR")}</option>
                ))}
              </select>
            </div>

            {verA && verB && (
              <>
                {/* ── 제목 비교 ── */}
                {titleChanged && (
                  <section style={{ marginBottom: 32 }}>
                    <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#333", fontWeight: 700 }}>📌 제목 변경</h3>
                    <TitleDiff oldTitle={verA.title} newTitle={verB.title} vA={vA} vB={vB} />
                  </section>
                )}

                {/* ── 본문 비교 (전문 좌우 나란히) ── */}
                <section style={{ marginBottom: 32 }}>
                  <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#333", fontWeight: 700 }}>📝 본문 비교</h3>
                  {!bodyChanged ? (
                    <p style={{ color: "#999", fontSize: 13 }}>본문 변경 없음</p>
                  ) : (
                    <div style={{
                      border: "1px solid #e0e0e0",
                      borderRadius: 10,
                      padding: "16px 18px",
                      background: "var(--color-background-primary)",
                      maxHeight: 700,
                      overflowY: "auto",
                    }}>
                      <BodyDiff oldText={verA.body} newText={verB.body} vA={vA} vB={vB} />
                    </div>
                  )}
                </section>

                {/* ── 사진 비교 ── */}
                <section style={{ marginBottom: 32 }}>
                  <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#333", fontWeight: 700 }}>🖼️ 사진 비교</h3>
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
                              <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 700, marginBottom: 6 }}>이전 사진</div>
                              <img src={item.oldUrl} alt="" style={{ width: "100%", borderRadius: 6, border: "1px solid #ddd" }} />
                            </div>
                            <div>
                              <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 700, marginBottom: 6 }}>현재 사진</div>
                              <img src={item.newUrl} alt="" style={{ width: "100%", borderRadius: 6, border: "1px solid #ddd" }} />
                            </div>
                          </div>
                        </div>
                      );

                      if (item.type === "removed") return (
                        <div key={i} style={{ marginBottom: 16 }}>
                          <div style={{ fontSize: 11, color: "#c0392b", fontWeight: 700, marginBottom: 6 }}>🗑️ 삭제된 사진</div>
                          <img src={item.oldUrl} alt="" style={{ width: "50%", borderRadius: 6, border: "2px solid #f5c6c6" }} />
                        </div>
                      );

                      if (item.type === "added") return (
                        <div key={i} style={{ marginBottom: 16 }}>
                          <div style={{ fontSize: 11, color: "#27ae60", fontWeight: 700, marginBottom: 6 }}>➕ 추가된 사진</div>
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
