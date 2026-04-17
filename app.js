'use strict';

// ─────────────────────────────────────────────
// 상태
// ─────────────────────────────────────────────
let currentData = null;
let currentCategory = 'all';

// ─────────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  initDatePicker();
  fetchNews();
});

function initDatePicker() {
  const picker = document.getElementById('datePicker');
  const today = new Date();
  picker.value = today.toISOString().slice(0, 10);
  picker.max = today.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────
// 이벤트 바인딩
// ─────────────────────────────────────────────
function bindEvents() {
  // 날짜 변경 → 자동 조회
  document.getElementById('datePicker').addEventListener('change', () => fetchNews());

  // 카테고리 필터
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCategory = btn.dataset.cat;
      if (currentData) renderDashboard(filterByCategory(currentData, currentCategory));
    });
  });

  // 전체 기사 접기/펼치기
  document.getElementById('allNewsToggle').addEventListener('click', () => {
    const list = document.getElementById('allNewsList');
    const toggle = document.getElementById('allNewsToggle');
    const isCollapsed = list.classList.contains('collapsed');
    list.classList.toggle('collapsed', !isCollapsed);
    toggle.classList.toggle('open', isCollapsed);
  });
}

// ─────────────────────────────────────────────
// API 호출
// ─────────────────────────────────────────────
async function fetchNews(baseDateOverride, categoryOverride) {
  const baseDate = baseDateOverride || document.getElementById('datePicker').value;
  const category = categoryOverride || currentCategory;

  if (!baseDate) return;

  setLoading(true);
  clearError();

  try {
    const url = `/api/news?baseDate=${baseDate}&category=${category}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`서버 오류: ${res.status}`);
    const data = await res.json();

    // 클라이언트 방어 필터 (날짜 범위 재확인)
    data.topNews = clientFilterByDate(data.topNews, data.dateRange);
    data.allNews = clientFilterByDate(data.allNews, data.dateRange);

    currentData = data;
    renderDashboard(data);
  } catch (err) {
    showError(`뉴스를 불러오지 못했습니다. 서버가 실행 중인지 확인해 주세요.<br><small>${err.message}</small>`);
  } finally {
    setLoading(false);
  }
}

// ─────────────────────────────────────────────
// 클라이언트 날짜 방어 필터
// ─────────────────────────────────────────────
function clientFilterByDate(news, dateRange) {
  if (!dateRange) return news;
  const start = new Date(dateRange.start + 'T00:00:00');
  const end = new Date(dateRange.end + 'T23:59:59');
  return news.filter(item => {
    try {
      const d = new Date(item.publishedAt);
      return d >= start && d <= end;
    } catch (_) { return true; }
  });
}

// ─────────────────────────────────────────────
// 카테고리 필터 (프론트)
// ─────────────────────────────────────────────
function filterByCategory(data, category) {
  if (category === 'all') return data;
  return {
    ...data,
    topNews: data.topNews.filter(a => a.category === category),
    allNews: data.allNews.filter(a => a.category === category),
  };
}

// ─────────────────────────────────────────────
// 대시보드 렌더링
// ─────────────────────────────────────────────
function renderDashboard(data) {
  renderStats(data);
  renderTopNews(data.topNews);
  renderAllNews(data.allNews);
  renderMailPanel(data);
}

// ─────────────────────────────────────────────
// 통계 렌더링
// ─────────────────────────────────────────────
function renderStats(data) {
  const { stats, baseDate, dateRange } = data;
  document.getElementById('statBaseDate').textContent = baseDate || '—';
  document.getElementById('statRange').textContent =
    dateRange ? `${dateRange.start} ~ ${dateRange.end}` : '—';
  document.getElementById('statRaw').textContent = stats.rawCount ?? '—';
  document.getElementById('statFiltered').textContent = stats.filteredCount ?? '—';
  document.getElementById('statDeduped').textContent = stats.dedupedCount ?? '—';
  document.getElementById('statFinal').textContent = stats.finalCount ?? '—';
  document.getElementById('statDomestic').textContent = stats.domesticCount ?? '—';
  document.getElementById('statForeign').textContent = stats.foreignCount ?? '—';
}

// ─────────────────────────────────────────────
// Top 5 렌더링
// ─────────────────────────────────────────────
function renderTopNews(news) {
  const section = document.getElementById('topNewsSection');
  const list = document.getElementById('topNewsList');

  if (!news || news.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = news.map((item, idx) => buildNewsCard(item, idx + 1, true)).join('');
}

// ─────────────────────────────────────────────
// 전체 기사 렌더링
// ─────────────────────────────────────────────
function renderAllNews(news) {
  const section = document.getElementById('allNewsSection');
  const list = document.getElementById('allNewsList');

  if (!news || news.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = news.map((item, idx) => buildNewsCard(item, idx + 1, false)).join('');
}

// ─────────────────────────────────────────────
// 뉴스 카드 HTML 빌더
// ─────────────────────────────────────────────
function buildNewsCard(item, rank, isTop) {
  const isForeign = item.isForeign;
  const titlePrefix = isForeign ? '<span class="foreign-label">(해외)</span> ' : '';
  const cardClass = `news-card ${isTop ? 'top-card' : ''} ${isForeign ? 'foreign-card' : ''}`;
  const catClass = item.category === '스테이블코인' ? 'cat-stable' : 'cat-ai';
  const keywords = (item.keywords || []).slice(0, 4)
    .map(kw => `<span class="kw-tag">${escHtml(kw)}</span>`)
    .join('');

  return `
    <div class="${cardClass}">
      <div class="card-header">
        <div class="card-rank">${rank}</div>
        <div class="card-title-wrap">
          <span class="card-category-tag ${catClass}">${escHtml(item.category)}</span>
          <div class="card-title">
            ${titlePrefix}
            <a href="${escHtml(item.url || '#')}" target="_blank" rel="noopener">${escHtml(item.title)}</a>
          </div>
        </div>
      </div>
      <div class="card-summary">${escHtml(item.summary)}</div>
      <div class="card-footer">
        <span class="card-source">${escHtml(item.source || '')}</span>
        <span class="card-date">${item.publishedAt || ''}</span>
        <div class="card-keywords">${keywords}</div>
        ${item.url ? `<a class="card-link" href="${escHtml(item.url)}" target="_blank" rel="noopener">원문 →</a>` : ''}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────
// 메일 패널 렌더링
// ─────────────────────────────────────────────
function renderMailPanel(data) {
  const periodEl = document.getElementById('mailPeriod');
  const textEl = document.getElementById('mailText');

  if (data.dateRange) {
    periodEl.textContent = `${data.dateRange.start} ~ ${data.dateRange.end} | 기준일: ${data.baseDate}`;
  }

  textEl.textContent = generateMailText(data.topNews, data.dateRange, data.baseDate);
}

// ─────────────────────────────────────────────
// 메일용 텍스트 생성
// ─────────────────────────────────────────────
function generateMailText(news, dateRange, baseDate) {
  if (!news || news.length === 0) return '선정된 뉴스가 없습니다.';

  const period = dateRange
    ? `${dateRange.start} ~ ${dateRange.end}`
    : baseDate || '';

  const header = [
    '══════════════════════════════════════════',
    '  증권사 디지털 / AI / 스테이블코인 주간 뉴스',
    `  기간: ${period}`,
    '══════════════════════════════════════════',
    '',
  ].join('\n');

  const body = news.map((item, idx) => {
    const titleLine = item.isForeign
      ? `[${idx + 1}] (해외) ${item.title}`
      : `[${idx + 1}] ${item.title}`;

    const summaryLines = splitSummaryToBullets(item.summary);
    const source = `  출처: ${item.source || ''}  |  ${item.publishedAt || ''}`;
    const urlLine = item.url ? `  URL: ${item.url}` : '';

    return [
      titleLine,
      '',
      summaryLines,
      '',
      source,
      urlLine,
      '',
      '──────────────────────────────────────────',
      '',
    ].flat().join('\n');
  }).join('\n');

  const footer = [
    `※ 본 자료는 기준일 ${baseDate || ''} 기준 최근 1주일 내 주요 기사 중`,
    '   유사 기사 제거 후 자동 선정된 핵심 5건입니다.',
  ].join('\n');

  return header + body + footer;
}

function splitSummaryToBullets(summary) {
  if (!summary) return [];
  // 문장 단위로 나누어 bullet 처리
  const sentences = summary
    .replace(/\[해외 기사 원문 요약\]/g, '')
    .split(/(?<=[.!?。])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);

  if (sentences.length === 0) return [`  • ${summary.trim()}`];
  return sentences.slice(0, 3).map(s => `  • ${s}`);
}

// ─────────────────────────────────────────────
// 복사 버튼
// ─────────────────────────────────────────────
function copyMailText() {
  const text = document.getElementById('mailText').textContent;
  if (!text || text.includes('뉴스를 조회하면')) {
    showToast('먼저 뉴스를 조회해 주세요.');
    return;
  }

  navigator.clipboard.writeText(text)
    .then(() => {
      const btn = document.getElementById('copyBtn');
      btn.classList.add('copied');
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        복사됨
      `;
      showToast('✓ 클립보드에 복사되었습니다. Outlook에 붙여넣기 하세요.');
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          복사
        `;
      }, 2500);
    })
    .catch(() => {
      // 구버전 브라우저 fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('✓ 복사되었습니다.');
    });
}

// ─────────────────────────────────────────────
// UI 유틸
// ─────────────────────────────────────────────
function setLoading(on) {
  document.getElementById('loadingWrap').style.display = on ? 'flex' : 'none';
  document.getElementById('topNewsSection').style.display = on ? 'none' : '';
  document.getElementById('allNewsSection').style.display = on ? 'none' : '';
  document.getElementById('refreshBtn').disabled = on;
}

function clearError() {
  document.getElementById('errorWrap').style.display = 'none';
}

function showError(msg) {
  const wrap = document.getElementById('errorWrap');
  document.getElementById('errorMsg').innerHTML = msg;
  wrap.style.display = 'block';
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
