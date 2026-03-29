import {
  buildUrl,
  escapeHtml,
  fetchDashboardData,
  formatNumber,
  getQueryParam,
  getTopicsForCategory,
  renderError,
  renderHeaderStats,
  renderLoading,
  setupAutoRefresh,
  titleCase,
} from "./shared.js";

const app = document.getElementById("app");
const headerStats = document.getElementById("header-stats");

document.addEventListener("DOMContentLoaded", initialize);
setupAutoRefresh();

async function initialize() {
  const categoryId = getQueryParam("category").toLowerCase();

  renderHeaderStats(headerStats, null);
  renderLoading(app, "Loading category topics...");

  try {
    const dashboard = await fetchDashboardData();
    const category = dashboard.categories.find((item) => item.id === categoryId);

    if (!category) {
      throw new Error("The selected category was not found in the latest API response.");
    }

    const topics = getTopicsForCategory(dashboard.topics, categoryId);

    renderHeaderStats(headerStats, dashboard);
    app.innerHTML = `

      <section class="panel">
        <div class="section-head">
          <div>
            <p class="section-kicker">Step 2</p>
            <h2 class="section-title">${escapeHtml(category.label)} Topics</h2>
          </div>
          <div class="section-meta">${formatNumber(topics.length)} topics in this category</div>
        </div>
        <div class="utility-row">
          <a class="page-link" href="./index.html">Home</a>
        </div>
        <p class="page-copy">
          Only topics from <strong>${escapeHtml(titleCase(category.id))}</strong> are shown here. Selecting a topic opens a dedicated page for newsroom coverage and gap review.
        </p>
        <div class="topic-grid">
          ${topics
        .map(
          (topic) => `
                <a class="topic-card card-link" href="${buildUrl("topic.html", { category: categoryId, topic: topic.id })}">
                  <h3>${escapeHtml(topic.topicName)}</h3>
                  <div class="topic-card-meta">
                    <span>${formatNumber(topic.totalStories)} total stories</span>
                    <span>${formatNumber(topic.finalMissingFacts.length)} final Missing facts</span>
                  </div>
                  <div class="metric-strip">
                    ${Object.entries(topic.statusCounts).map(([status, count]) => count > 0 ? `<span class="metric-pill">${formatNumber(count)} ${escapeHtml(status)}</span>` : '').join('')}
                  </div>
                </a>
              `
        )
        .join("")}
        </div>
      </section>
    `;
  } catch (error) {
    renderError(app, error);
  }
}
