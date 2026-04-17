# 증권사 디지털 / AI / 스테이블코인 주간 뉴스 스크랩 대시보드

증권사 디지털 혁신, AI, 스테이블코인 관련 뉴스를 기준일 기준 최근 1주일 단위로 자동 수집·가공하여 메일에 바로 붙여넣기 가능한 형태로 제공하는 동적 웹 대시보드입니다.

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| 기준일 설정 | Date Picker로 기준일 선택 → 최근 7일 기사 자동 조회 |
| 국내·해외 수집 | RSS 기반 국내·해외 뉴스 동시 수집 |
| 해외 기사 표시 | 제목 앞 `(해외)` 자동 표시, 한국어 요약 제공, 원문 링크 유지 |
| 유사 기사 제거 | 제목 유사도·키워드 중복 기반 dedup |
| Top 5 자동 선정 | 최신성 + 핵심 키워드 가점 기반 중요도 점수화 |
| 메일 복사 | Outlook 붙여넣기 최적화 텍스트 자동 생성 + 원클릭 복사 |
| 통계 패널 | 수집/필터/중복제거/최종 선정 건수 실시간 표시 |
| Fallback 데이터 | RSS 수집 실패 시 샘플 데이터 자동 사용 |

---

## 프로젝트 구조

```
news-dashboard/
├── server.js          # Express 백엔드 (뉴스 수집·가공 API)
├── package.json
├── README.md
└── public/
    ├── index.html     # 대시보드 UI
    ├── style.css      # 스타일
    └── app.js         # 프론트엔드 로직
```

---

## 로컬 실행

### 사전 요건

- Node.js 18 이상

### 설치 및 실행

```bash
# 의존성 설치
npm install

# 서버 시작
npm start

# 개발 모드 (파일 변경 감지)
npm run dev
```

브라우저에서 `http://localhost:3000` 접속

### API 직접 호출 예시

```bash
# 오늘 기준 1주일 전체 기사
curl "http://localhost:3000/api/news?baseDate=2026-04-17&category=all"

# 스테이블코인만
curl "http://localhost:3000/api/news?baseDate=2026-04-17&category=스테이블코인"
```

---

## API 응답 형식

`GET /api/news?baseDate=YYYY-MM-DD&category=all|증권사 디지털혁신/AI|스테이블코인`

```json
{
  "baseDate": "2026-04-17",
  "dateRange": { "start": "2026-04-11", "end": "2026-04-17" },
  "stats": {
    "rawCount": 24,
    "filteredCount": 16,
    "dedupedCount": 9,
    "finalCount": 5,
    "domesticCount": 3,
    "foreignCount": 2
  },
  "topNews": [ ...5개 ],
  "allNews": [ ...전체 ]
}
```

---

## 배포 방법

### Render.com

1. GitHub에 소스 push
2. [render.com](https://render.com) → New Web Service
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Environment: Node

### Railway.app

1. [railway.app](https://railway.app) → New Project → GitHub Repo
2. 자동 감지 후 배포 완료

### Vercel (서버리스 방식)

> 주의: Vercel은 서버리스 환경이므로 `server.js`를 `/api/news.js` 형태로 변환하고 `vercel.json` 라우팅 설정이 필요합니다.

```json
// vercel.json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/public/index.html" }
  ]
}
```

---

## 향후 개선 포인트

- **LLM API 연동**: `summarizeArticle()`, `translateAndSummarizeForeignArticle()` 함수에 Claude/OpenAI API 연결
- **뉴스 소스 확장**: 더 많은 RSS 피드 및 뉴스 검색 API 추가
- **스케줄링**: node-cron으로 매일 자동 수집·캐싱
- **캐시 레이어**: Redis 또는 파일 캐시로 반복 호출 최적화
- **이메일 발송**: Nodemailer 연동으로 자동 메일 발송

---

## 라이선스

MIT
