import {
  buildUrl,
  escapeHtml,
  fetchDashboardData,
  formatNumber,
  renderError,
  renderHeaderStats,
  renderLoading,
  setupAutoRefresh,
} from "./shared.js";

const app = document.getElementById("app");
const headerStats = document.getElementById("header-stats");

document.addEventListener("DOMContentLoaded", initialize);
setupAutoRefresh();

async function initialize() {
  renderHeaderStats(headerStats, null);
  renderLoading(app, "Loading live categories...");

  try {
    const dashboard = await fetchDashboardData();
    renderHeaderStats(headerStats, dashboard);
    renderCategories(dashboard);
  } catch (error) {
    renderError(app, error);
  }
}

function renderCategories(dashboard) {
  app.innerHTML = `
    <section class="panel">
      <div class="section-head">
        <div>
          <p class="section-kicker">Step 1</p>
          <h2 class="section-title">Choose a Category</h2>
        </div>
        <div class="section-meta">${dashboard.categories.length} live categories from API</div>
      </div>
      <p class="page-copy">
        Categories are built dynamically from the latest API response. Selecting a category opens a dedicated page with only that category's topic clusters.
      </p>
      <div class="topic-grid">
        ${dashboard.categories
          .map(
            (category) => `
              <a class="topic-card card-link" href="${buildUrl("topics.html", { category: category.id })}">
                <h3>${escapeHtml(category.label)}</h3>
                <div class="topic-card-meta">
                  <span>${formatNumber(category.topicCount)} topics</span>
                  <span>${formatNumber(category.storyCount)} stories</span>
                </div>

              </a>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}
