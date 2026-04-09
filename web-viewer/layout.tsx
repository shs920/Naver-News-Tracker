import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "네이버 뉴스 추적기",
  description: "기사 수정 이력 비교 뷰어",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
