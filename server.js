'use strict';

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const path = require('path');
const he = require('he');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─────────────────────────────────────────────
// 1. 날짜 범위 계산
// ─────────────────────────────────────────────
function getDateRange(baseDate) {
  const end = new Date(baseDate);
  end.setHours(23, 59, 59, 999);
  const start = new Date(baseDate);
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    startDate: start,
    endDate: end
  };
}

// ─────────────────────────────────────────────
// 2. 제목 정규화 (dedupe용)
// ─────────────────────────────────────────────
function normalizeTitle(title) {
  return title
    .replace(/\[.*?\]|\(.*?\)/g, '')
    .replace(/[^\uAC00-\uD7A3a-zA-Z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ─────────────────────────────────────────────
// 3. 기사 요약 함수 (추후 LLM API 교체 가능)
// ─────────────────────────────────────────────
function summarizeArticle(article) {
  const desc = article.description || article.title || '';
  const clean = he.decode(desc.replace(/<[^>]+>/g, '').trim());
  if (!clean) return `${article.title}에 관한 기사입니다.`;
  const sentences = clean.split(/(?<=[.!?。])\s+/);
  return sentences.slice(0, 3).join(' ').slice(0, 300) || clean.slice(0, 300);
}

function translateAndSummarizeForeignArticle(article) {
  // 실제 운영 시 Claude/OpenAI API 호출로 교체
  const desc = article.description || article.title || '';
  const clean = he.decode(desc.replace(/<[^>]+>/g, '').trim());

  // 간단 패턴 기반 한국어 힌트 매핑
  const patterns = [
    { en: /stablecoin/i,        ko: '스테이블코인' },
    { en: /tokeniz/i,           ko: '토큰화' },
    { en: /digital asset/i,     ko: '디지털 자산' },
    { en: /AI/i,                ko: 'AI' },
    { en: /regulation/i,        ko: '규제' },
    { en: /settlement/i,        ko: '결제·정산' },
    { en: /broker/i,            ko: '증권사' },
    { en: /capital market/i,    ko: '자본시장' },
    { en: /blockchain/i,        ko: '블록체인' },
    { en: /crypto/i,            ko: '암호화폐' },
    { en: /partnership/i,       ko: '파트너십' },
    { en: /payment/i,           ko: '결제' },
    { en: /innovation/i,        ko: '혁신' },
    { en: /defi/i,              ko: 'DeFi' },
    { en: /SEC|CFTC|FSC/i,      ko: '금융당국' },
  ];

  const matched = patterns
    .filter(p => p.en.test(clean))
    .map(p => p.ko);
  const keywordStr = matched.length ? `(${matched.slice(0, 3).join(', ')} 관련) ` : '';

  // 문장 길이가 충분하면 첫 2문장 사용, 아니면 전체 사용
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const usable = sentences.slice(0, 2).join(' ');

  if (usable.length > 40) {
    return `${keywordStr}${usable.slice(0, 280)} [해외 기사 원문 요약]`;
  }
  return `${keywordStr}${clean.slice(0, 280)} [해외 기사 원문 요약]`;
}

// ─────────────────────────────────────────────
// 4. 중요도 점수 산정
// ─────────────────────────────────────────────
const SCORE_KEYWORDS = [
  { w: ['ai', '인공지능', 'artificial intelligence', 'llm', 'gpt', 'claude'], pts: 3 },
  { w: ['stablecoin', '스테이블코인'], pts: 4 },
  { w: ['디지털혁신', '디지털 혁신', 'digital transformation', 'digital innovation'], pts: 3 },
  { w: ['증권사', 'brokerage', 'securities', 'capital market'], pts: 3 },
  { w: ['토큰화', 'tokeniz'], pts: 3 },
  { w: ['결제', 'payment', 'settlement'], pts: 2 },
  { w: ['제도화', 'regulation', '규제'], pts: 2 },
  { w: ['협업', 'partnership', 'collaboration'], pts: 1 },
  { w: ['블록체인', 'blockchain'], pts: 2 },
  { w: ['fintech', '핀테크'], pts: 2 },
  { w: ['defi'], pts: 2 },
  { w: ['blackrock', 'jp morgan', 'goldman', 'fidelity', '미래에셋', '삼성증권', 'kb증권', '한투'], pts: 2 },
];

function scoreNewsItem(item) {
  let score = 0;
  const text = `${item.title} ${item.summary} ${(item.keywords || []).join(' ')}`.toLowerCase();

  SCORE_KEYWORDS.forEach(({ w, pts }) => {
    if (w.some(kw => text.includes(kw))) score += pts;
  });

  // 최신성: 오늘 기준 일수
  try {
    const daysOld = (Date.now() - new Date(item.publishedAt).getTime()) / 86400000;
    score += Math.max(0, 7 - Math.floor(daysOld));
  } catch (_) {}

  // 해외 기사 소폭 가점
  if (item.isForeign) score += 1;

  item._score = score;
  return score;
}

// ─────────────────────────────────────────────
// 5. 날짜 필터
// ─────────────────────────────────────────────
function filterByDateRange(news, baseDate) {
  const { startDate, endDate } = getDateRange(baseDate);
  return news.filter(item => {
    try {
      const d = new Date(item.publishedAt);
      return d >= startDate && d <= endDate;
    } catch (_) {
      return true; // 날짜 파싱 실패 시 포함
    }
  });
}

// ─────────────────────────────────────────────
// 6. 유사 기사 제거
// ─────────────────────────────────────────────
function titleSimilarity(a, b) {
  const wordsA = new Set(normalizeTitle(a).split(' ').filter(w => w.length > 1));
  const wordsB = new Set(normalizeTitle(b).split(' ').filter(w => w.length > 1));
  if (!wordsA.size || !wordsB.size) return 0;
  const intersection = [...wordsA].filter(w => wordsB.has(w));
  return intersection.length / Math.max(wordsA.size, wordsB.size);
}

function dedupeNews(news) {
  const sorted = [...news].sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
  );
  const kept = [];
  for (const item of sorted) {
    const isDup = kept.some(k => {
      if (k.category !== item.category) return false;
      const sim = titleSimilarity(k.title, item.title);
      if (sim >= 0.55) return true;
      // 키워드 겹침
      const kA = new Set((k.keywords || []).map(w => w.toLowerCase()));
      const kB = (item.keywords || []).map(w => w.toLowerCase());
      const kwOverlap = kB.filter(w => kA.has(w)).length;
      return kwOverlap >= 3;
    });
    if (!isDup) kept.push(item);
  }
  return kept;
}

// ─────────────────────────────────────────────
// 7. Top 5 선정
// ─────────────────────────────────────────────
function selectTopFive(news) {
  return [...news]
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, 5);
}

// ─────────────────────────────────────────────
// 8. RSS 파싱 공통 함수
// ─────────────────────────────────────────────
async function parseRSS(url, timeout = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' }
    });
    clearTimeout(timer);
    const text = await res.text();
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: false });
    const result = await parser.parseStringPromise(text);

    const channel = result?.rss?.channel || result?.feed;
    if (!channel) return [];

    // RSS 2.0
    const items = channel.item
      ? (Array.isArray(channel.item) ? channel.item : [channel.item])
      : [];

    // Atom feed
    const entries = channel.entry
      ? (Array.isArray(channel.entry) ? channel.entry : [channel.entry])
      : [];

    return [...items, ...entries].map(it => ({
      rawTitle: he.decode((it.title?._ || it.title || '').replace(/<[^>]+>/g, '').trim()),
      rawDescription: he.decode((it.description?._ || it.description || it.summary?._ || it.summary || '').replace(/<[^>]+>/g, '').trim()),
      rawLink: it.link?.$ ? it.link.$['href'] : (it.link?._ || it.link || ''),
      rawDate: it.pubDate || it['dc:date'] || it.published || it.updated || '',
      rawSource: channel.title?._ || channel.title || url,
    }));
  } catch (e) {
    clearTimeout(timer);
    return [];
  }
}

// ─────────────────────────────────────────────
// 9. 카테고리 자동 분류
// ─────────────────────────────────────────────
function classifyCategory(title, desc) {
  const text = `${title} ${desc}`.toLowerCase();
  const stableMatches = ['스테이블코인', 'stablecoin', 'usdc', 'usdt', 'cbdc', '디지털화폐'];
  if (stableMatches.some(k => text.includes(k))) return '스테이블코인';
  return '증권사 디지털혁신/AI';
}

function extractKeywords(title, desc) {
  const pool = [
    'AI', '인공지능', '스테이블코인', '디지털혁신', '토큰화', '결제', '블록체인',
    '증권사', '핀테크', '혁신', 'DeFi', '규제', '제도화', '협업',
    'stablecoin', 'tokenization', 'blockchain', 'digital asset', 'settlement',
    'regulation', 'fintech', 'brokerage', 'capital market',
  ];
  const text = `${title} ${desc}`.toLowerCase();
  return pool.filter(kw => text.toLowerCase().includes(kw.toLowerCase())).slice(0, 6);
}

function parseDate(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10);
  try {
    return new Date(raw).toISOString().slice(0, 10);
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

// ─────────────────────────────────────────────
// 10. 국내 뉴스 수집
// ─────────────────────────────────────────────
const DOMESTIC_RSS_SOURCES = [
  // 네이버 뉴스 검색 RSS
  {
    url: 'https://news.naver.com/rss/industry.nhn?sid1=101',
    label: '네이버 금융'
  },
  {
    url: 'https://rss.hankyung.com/economy.xml',
    label: '한국경제'
  },
  {
    url: 'https://www.mk.co.kr/rss/40300001/',
    label: '매일경제'
  },
  {
    url: 'https://rss.etnews.com/Section901.xml',
    label: '전자신문'
  },
  // 구글 뉴스 RSS (국내 증권사 AI 키워드)
  {
    url: 'https://news.google.com/rss/search?q=%EC%A6%9D%EA%B6%8C%EC%82%AC+AI+%EB%94%94%EC%A7%80%ED%84%B8&hl=ko&gl=KR&ceid=KR:ko',
    label: 'Google뉴스-증권AI'
  },
  {
    url: 'https://news.google.com/rss/search?q=%EC%A6%9D%EA%B6%8C%EC%82%AC+%EC%8A%A4%ED%85%8C%EC%9D%B4%EB%B8%94%EC%BD%94%EC%9D%B8&hl=ko&gl=KR&ceid=KR:ko',
    label: 'Google뉴스-스테이블코인'
  },
  {
    url: 'https://news.google.com/rss/search?q=%EC%A6%9D%EA%B6%8C%EC%82%AC+%EB%94%94%EC%A7%80%ED%84%B8+%ED%98%81%EC%8B%A0&hl=ko&gl=KR&ceid=KR:ko',
    label: 'Google뉴스-디지털혁신'
  },
];

async function fetchDomesticNews(baseDate) {
  const results = [];
  for (const src of DOMESTIC_RSS_SOURCES) {
    const items = await parseRSS(src.url);
    for (const it of items) {
      if (!it.rawTitle) continue;
      results.push({
        id: `dom-${Buffer.from(it.rawTitle).toString('base64').slice(0, 12)}-${Date.now()}`,
        category: classifyCategory(it.rawTitle, it.rawDescription),
        title: it.rawTitle,
        summary: summarizeArticle({ title: it.rawTitle, description: it.rawDescription }),
        url: it.rawLink,
        source: src.label,
        publishedAt: parseDate(it.rawDate),
        isForeign: false,
        originalLanguage: 'ko',
        keywords: extractKeywords(it.rawTitle, it.rawDescription),
      });
    }
  }
  return results;
}

// ─────────────────────────────────────────────
// 11. 해외 뉴스 수집
// ─────────────────────────────────────────────
const FOREIGN_RSS_SOURCES = [
  {
    url: 'https://news.google.com/rss/search?q=stablecoin+finance+securities&hl=en&gl=US&ceid=US:en',
    label: 'Google News-Stablecoin'
  },
  {
    url: 'https://news.google.com/rss/search?q=brokerage+AI+digital+transformation&hl=en&gl=US&ceid=US:en',
    label: 'Google News-Brokerage AI'
  },
  {
    url: 'https://news.google.com/rss/search?q=capital+markets+blockchain+tokenization&hl=en&gl=US&ceid=US:en',
    label: 'Google News-Tokenization'
  },
  {
    url: 'https://cointelegraph.com/rss',
    label: 'CoinTelegraph'
  },
  {
    url: 'https://decrypt.co/feed',
    label: 'Decrypt'
  },
];

function isForeignSource(source) {
  const foreignMarkers = [
    'coindesk', 'cointelegraph', 'decrypt', 'theblock', 'bloomberg',
    'reuters', 'ft.com', 'wsj', 'google news-stablecoin', 'google news-brokerage', 'google news-tokenization',
  ];
  return foreignMarkers.some(m => source.toLowerCase().includes(m));
}

async function fetchForeignNews(baseDate) {
  const results = [];
  for (const src of FOREIGN_RSS_SOURCES) {
    const items = await parseRSS(src.url);
    for (const it of items) {
      if (!it.rawTitle) continue;
      results.push({
        id: `for-${Buffer.from(it.rawTitle).toString('base64').slice(0, 12)}-${Date.now()}`,
        category: classifyCategory(it.rawTitle, it.rawDescription),
        title: it.rawTitle,
        summary: translateAndSummarizeForeignArticle({ title: it.rawTitle, description: it.rawDescription }),
        url: it.rawLink,
        source: src.label,
        publishedAt: parseDate(it.rawDate),
        isForeign: true,
        originalLanguage: 'en',
        keywords: extractKeywords(it.rawTitle, it.rawDescription),
      });
    }
  }
  return results;
}

// ─────────────────────────────────────────────
// 12. Fallback 샘플 데이터
// ─────────────────────────────────────────────
function getFallbackNews(baseDate) {
  const { start, end } = getDateRange(baseDate);
  const d = (offset) => {
    const dt = new Date(baseDate);
    dt.setDate(dt.getDate() - offset);
    return dt.toISOString().slice(0, 10);
  };

  return [
    // ── 증권사 디지털혁신/AI ──
    {
      id: 'fb-001', category: '증권사 디지털혁신/AI',
      title: '미래에셋증권, AI 기반 투자 분석 플랫폼 정식 출시',
      summary: '미래에셋증권이 자체 개발한 AI 투자 분석 플랫폼을 전 고객 대상으로 정식 출시했다. 이 플랫폼은 대규모 언어모델(LLM)을 활용해 실시간 리서치 분석 및 포트폴리오 추천 기능을 제공한다. 회사 측은 향후 로보어드바이저 연동도 검토 중이라고 밝혔다.',
      url: 'https://www.mirae-asset.com/news/ai-platform', source: '미래에셋증권', publishedAt: d(1), isForeign: false, originalLanguage: 'ko',
      keywords: ['AI', '증권사', '투자분석', '플랫폼', 'LLM', '디지털혁신']
    },
    {
      id: 'fb-002', category: '증권사 디지털혁신/AI',
      title: '삼성증권, 생성형 AI 도입으로 리서치 업무 효율 40% 향상',
      summary: '삼성증권이 생성형 AI를 리서치 부서에 전면 도입한 결과 업무 효율이 40% 향상됐다고 발표했다. AI가 1차 초안 작성을 담당하고 애널리스트가 검수하는 방식으로 보고서 작성 시간을 대폭 단축했다. 타 증권사들도 유사 시스템 도입을 서두르고 있는 것으로 알려졌다.',
      url: 'https://www.samsungsec.co.kr/news/ai-research', source: '삼성증권', publishedAt: d(2), isForeign: false, originalLanguage: 'ko',
      keywords: ['AI', '삼성증권', '생성형AI', '리서치', '디지털혁신']
    },
    {
      id: 'fb-003', category: '증권사 디지털혁신/AI',
      title: 'KB증권, 챗봇 고도화로 고객 문의 응대율 90% 돌파',
      summary: 'KB증권이 AI 챗봇 시스템을 전면 개편하여 고객 문의 자동 응대율 90%를 달성했다. 자연어 처리 기술 향상으로 복잡한 금융 용어도 정확하게 인식하며, 야간·주말 고객 서비스 공백을 해소했다. KB금융그룹 차원에서 그룹사 통합 AI 서비스 플랫폼 구축도 검토 중이다.',
      url: 'https://www.kbsec.com/news/chatbot', source: 'KB증권', publishedAt: d(2), isForeign: false, originalLanguage: 'ko',
      keywords: ['AI', 'KB증권', '챗봇', '고객서비스', '디지털혁신']
    },
    {
      id: 'fb-004', category: '증권사 디지털혁신/AI',
      title: '한국투자증권, 핀테크 스타트업 3곳과 디지털 혁신 MOU 체결',
      summary: '한국투자증권이 블록체인, AI, 빅데이터 전문 핀테크 스타트업 3곳과 디지털 혁신 업무협약을 체결했다. 이번 협약은 증권사의 전통적 IT 인프라를 현대화하고 신기술 기반 금융 서비스를 공동 개발하기 위한 것이다. 구체적 서비스는 올해 하반기에 출시될 예정이다.',
      url: 'https://www.truefriend.com/news/mou', source: '한국투자증권', publishedAt: d(3), isForeign: false, originalLanguage: 'ko',
      keywords: ['증권사', '핀테크', '협업', 'MOU', '디지털혁신']
    },
    {
      id: 'fb-005', category: '증권사 디지털혁신/AI',
      title: '키움증권, AI 자동매매 시스템 고도화 완료…머신러닝 접목',
      summary: '키움증권이 머신러닝 기반 AI 자동매매 알고리즘을 기존 시스템에 통합한 고도화 작업을 완료했다고 밝혔다. 강화학습 모델이 실시간 시장 데이터를 분석해 매수·매도 신호를 생성하며, 백테스트 결과 기존 대비 수익률이 개선됐다. 해당 서비스는 법인·기관 고객을 대상으로 우선 제공된다.',
      url: 'https://www.kiwoom.com/news/ai-trading', source: '키움증권', publishedAt: d(4), isForeign: false, originalLanguage: 'ko',
      keywords: ['AI', '키움증권', '자동매매', '머신러닝', '알고리즘']
    },
    {
      id: 'fb-006', category: '증권사 디지털혁신/AI',
      title: '금융위, 증권사 AI 활용 가이드라인 2026년 상반기 내 발표 예고',
      summary: '금융위원회가 증권사의 AI 활용에 관한 규제·가이드라인을 2026년 상반기 안에 발표할 계획이라고 밝혔다. 가이드라인에는 AI 기반 투자 권유 시 설명 의무, 오류 책임 소재, 데이터 활용 범위 등이 포함될 예정이다. 업계는 명확한 기준 마련이 AI 투자 서비스 확산에 긍정적이라고 평가하고 있다.',
      url: 'https://www.fsc.go.kr/news/ai-guideline', source: '금융위원회', publishedAt: d(5), isForeign: false, originalLanguage: 'ko',
      keywords: ['AI', '금융위', '가이드라인', '규제', '증권사']
    },
    // ── 스테이블코인 ──
    {
      id: 'fb-007', category: '스테이블코인',
      title: '국내 4대 시중은행, 원화 스테이블코인 공동 발행 컨소시엄 구성',
      summary: '국내 4대 시중은행이 원화 연동 스테이블코인을 공동 발행하기 위한 컨소시엄을 구성하기로 합의했다. 금융당국과 사전 협의를 마친 상태이며, 기업 간 결제 및 증권 정산 분야에 우선 적용할 예정이다. 참여 은행들은 연내 파일럿 시스템 구축을 목표로 하고 있다.',
      url: 'https://example.com/krw-stablecoin', source: '한국경제', publishedAt: d(1), isForeign: false, originalLanguage: 'ko',
      keywords: ['스테이블코인', '은행', '원화', '결제', '컨소시엄', '제도화']
    },
    {
      id: 'fb-008', category: '스테이블코인',
      title: '증권업계, 스테이블코인 활용 증권 결제 시스템 도입 공동 연구 착수',
      summary: '한국증권업협회를 중심으로 주요 증권사들이 스테이블코인 기반 증권 결제 시스템 도입 가능성 공동 연구에 착수했다. T+1 결제 관행을 넘어 실시간 결제(T+0) 실현이 목표다. 블록체인 기술과 연동하면 결제 리스크와 비용을 크게 낮출 수 있을 것으로 기대된다.',
      url: 'https://example.com/securities-stablecoin', source: '매일경제', publishedAt: d(2), isForeign: false, originalLanguage: 'ko',
      keywords: ['스테이블코인', '증권사', '결제', '블록체인', '토큰화']
    },
    {
      id: 'fb-009', category: '스테이블코인',
      title: '국내 스테이블코인 규제 법안, 국회 정무위 통과…하반기 시행 전망',
      summary: '국내 스테이블코인 발행 및 유통에 관한 규제 법안이 국회 정무위원회를 통과했다. 법안은 원화 연동 스테이블코인 발행자의 준비금 요건, 공시 의무, 감독 체계 등을 규정하고 있다. 금융위는 하위 법령 정비 후 올해 하반기 시행을 목표로 하고 있다.',
      url: 'https://example.com/stablecoin-law', source: '연합뉴스', publishedAt: d(3), isForeign: false, originalLanguage: 'ko',
      keywords: ['스테이블코인', '규제', '법안', '국회', '제도화']
    },
    // ── 해외 기사 ──
    {
      id: 'fb-010', category: '스테이블코인',
      title: 'BlackRock Expands Digital Asset Payment Infrastructure with Stablecoin Integration',
      summary: '블랙록이 기관 투자자 대상 디지털 자산 결제 인프라를 스테이블코인과 연동하는 방향으로 확대 중이다. USDC 기반의 실시간 결제 파일럿을 완료했으며, 2026년 하반기 정식 서비스를 목표로 하고 있다. 이는 전통 금융과 디지털 자산 결제 인프라의 융합이 가속화되고 있음을 보여주는 사례다. [해외 기사 원문 요약]',
      url: 'https://www.bloomberg.com/news/blackrock-stablecoin', source: 'Bloomberg', publishedAt: d(1), isForeign: true, originalLanguage: 'en',
      keywords: ['스테이블코인', '블랙록', '디지털 자산', '결제', '기관투자자']
    },
    {
      id: 'fb-011', category: '증권사 디지털혁신/AI',
      title: 'Goldman Sachs Deploys AI Co-pilot for 10,000 Traders Across Fixed Income Desk',
      summary: '골드만삭스가 채권 트레이딩 부서 직원 1만여 명에게 AI 코파일럿 도구를 전면 배포했다. 이 도구는 시장 데이터 분석, 리스크 계산, 고객 보고서 초안 작성 등을 지원하며 생산성을 대폭 향상시켰다. 투자은행들이 AI를 핵심 업무에 통합하는 속도가 빠르게 증가하고 있음을 보여주는 사례다. [해외 기사 원문 요약]',
      url: 'https://www.ft.com/content/goldman-ai-traders', source: 'Financial Times', publishedAt: d(2), isForeign: true, originalLanguage: 'en',
      keywords: ['AI', '골드만삭스', '트레이딩', '코파일럿', '디지털혁신']
    },
    {
      id: 'fb-012', category: '스테이블코인',
      title: 'JPMorgan Launches Tokenized Treasury Collateral Network Using Stablecoin Settlement',
      summary: 'JP모건이 스테이블코인 정산 기반의 토큰화 국채 담보 네트워크를 정식 출시했다. 이 시스템은 기관 간 담보 교환을 실시간으로 처리하며, 전통적인 T+2 결제 대비 리스크와 비용을 크게 낮춘다. 글로벌 주요 은행들의 토큰화 자산 인프라 구축 경쟁이 본격화되는 신호로 분석된다. [해외 기사 원문 요약]',
      url: 'https://www.reuters.com/jpmorgan-tokenized-treasury', source: 'Reuters', publishedAt: d(3), isForeign: true, originalLanguage: 'en',
      keywords: ['스테이블코인', 'JP모건', '토큰화', '결제', '국채', '블록체인']
    },
    // 중복 샘플 (dedupe 테스트용)
    {
      id: 'fb-013', category: '스테이블코인',
      title: '원화 스테이블코인 발행 위해 4개 시중은행 컨소시엄 결성',
      summary: '시중은행 4곳이 원화 스테이블코인 공동 발행을 위한 컨소시엄을 결성했다는 보도가 나왔다.',
      url: 'https://example.com/krw-stablecoin-2', source: '이데일리', publishedAt: d(2), isForeign: false, originalLanguage: 'ko',
      keywords: ['스테이블코인', '은행', '원화', '컨소시엄']
    },
    {
      id: 'fb-014', category: '증권사 디지털혁신/AI',
      title: '미래에셋증권 AI 투자분석 플랫폼 출시, 전 고객 대상',
      summary: '미래에셋증권이 전 고객 대상으로 AI 기반 투자 분석 플랫폼을 출시한다고 밝혔다.',
      url: 'https://example.com/mirae-ai-2', source: '서울경제', publishedAt: d(2), isForeign: false, originalLanguage: 'ko',
      keywords: ['AI', '미래에셋증권', '투자분석', '플랫폼']
    },
  ];
}

// ─────────────────────────────────────────────
// 13. 전체 응답 빌드
// ─────────────────────────────────────────────
async function buildNewsResponse(baseDate, category) {
  const range = getDateRange(baseDate);

  // 수집
  const [domestic, foreign] = await Promise.all([
    fetchDomesticNews(baseDate),
    fetchForeignNews(baseDate),
  ]);

  let rawAll = [...domestic, ...foreign];
  const rawCount = rawAll.length;

  // 수집 실패 시 fallback
  const MIN_ARTICLES = 6;
  if (rawCount < MIN_ARTICLES) {
    const fallback = getFallbackNews(baseDate);
    const fallbackIds = new Set(rawAll.map(a => a.url));
    const newFallback = fallback.filter(f => !fallbackIds.has(f.url));
    rawAll = [...rawAll, ...newFallback];
  }

  // 날짜 필터
  let filtered = filterByDateRange(rawAll, baseDate);
  const filteredCount = filtered.length;

  // 카테고리 필터
  if (category && category !== 'all') {
    filtered = filtered.filter(a => a.category === category);
  }

  // dedupe
  const deduped = dedupeNews(filtered);
  const dedupedCount = deduped.length;

  // 점수화
  deduped.forEach(item => scoreNewsItem(item));

  // Top 5
  const topNews = selectTopFive(deduped);

  // 통계
  const finalAll = deduped;
  const domesticCount = topNews.filter(a => !a.isForeign).length;
  const foreignCount = topNews.filter(a => a.isForeign).length;

  return {
    baseDate,
    dateRange: { start: range.start, end: range.end },
    stats: {
      rawCount: rawAll.length,
      filteredCount,
      dedupedCount,
      finalCount: topNews.length,
      domesticCount,
      foreignCount,
    },
    topNews,
    allNews: finalAll,
  };
}

// ─────────────────────────────────────────────
// 14. API 라우트
// ─────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  try {
    const baseDate = req.query.baseDate || new Date().toISOString().slice(0, 10);
    const category = req.query.category || 'all';

    // 날짜 형식 검증
    if (!/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
      return res.status(400).json({ error: 'baseDate must be YYYY-MM-DD format' });
    }

    const data = await buildNewsResponse(baseDate, category);
    res.json(data);
  } catch (err) {
    console.error('[/api/news error]', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 뉴스 대시보드 서버 실행 중: http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/news?baseDate=YYYY-MM-DD&category=all\n`);
});
