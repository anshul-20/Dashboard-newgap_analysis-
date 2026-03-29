import {
  buildUrl,
  escapeHtml,
  fetchDashboardData,
  formatDateTime,
  formatNumber,
  getQueryParam,
  getStoriesForTopic,
  getTopicById,
  renderError,
  renderFinalVerdict,
  renderHeaderStats,
  renderLoading,
  renderStoryPreview,
  setupAutoRefresh,
  titleCase,
} from "./shared.js";

const app = document.getElementById("app");
const headerStats = document.getElementById("header-stats");

document.addEventListener("DOMContentLoaded", initialize);
setupAutoRefresh();

async function initialize() {
  const categoryId = getQueryParam("category").toLowerCase();
  const topicId = getQueryParam("topic");

  renderHeaderStats(headerStats, null);
  renderLoading(app, "Loading newsroom coverage...");

  try {
    const dashboard = await fetchDashboardData();
    const category = dashboard.categories.find((item) => item.id === categoryId);
    const topic = getTopicById(dashboard.topics, topicId, categoryId);

    if (!category) {
      throw new Error("The selected category was not found in the latest API response.");
    }

    if (!topic) {
      throw new Error("The selected topic was not found for this category.");
    }

    const stories = getStoriesForTopic(topic, categoryId);
    const activeStory = stories[0] || null;

    renderHeaderStats(headerStats, dashboard);
    app.innerHTML = `

      <section class="panel">
        <div class="section-head">
          <div>
            <p class="section-kicker">Step 3</p>
            <h2 class="section-title">${escapeHtml(topic.topicName)}</h2>
          </div>
          <!-- <div class="section-meta">${formatNumber(stories.length)} newsroom banners</div> -->
        </div>
        <div class="utility-row">
          <a class="page-link" href="./index.html">Home</a>
          <a class="page-link" href="${buildUrl("topics.html", { category: categoryId })}">Back to ${escapeHtml(
      titleCase(categoryId)
    )} topics</a>
        </div>
        <p class="page-copy">
          Hover a newsroom banner to preview its missing facts and combined English text here. Click a newsroom banner to pin it to the preview drawer.
        </p>

        <div class="story-grid">
          ${stories.map((story) => renderStoryCard(topic, categoryId, story)).join("")}
        </div>

        <div id="story-preview">
          ${activeStory ? renderStoryPreview(activeStory) : ""}
        </div>

        ${renderFinalVerdict(topic)}
      </section>
    `;

    attachPreviewHandlers(stories);
  } catch (error) {
    renderError(app, error);
  }
}

function renderStoryCard(topic, categoryId, story) {
  return `
    <a
      class="newsroom-card card-link"
      data-story-id="${escapeHtml(story.id)}"
      href="#"
    >
      <div class="newsroom-header">
        <div>
          <h3 class="newsroom-name">${escapeHtml(story.newsroom)}</h3>
          <span class="newsroom-date">${escapeHtml(formatDateTime(story.publishedAt))}</span>
        </div>
        <span class="status-pill ${story.coverageStatus}">
          ${story.coverageStatus === "covered" ? "Covered" : "Missed"}
        </span>
      </div>
      <p class="newsroom-title">${escapeHtml(story.title)}</p>
      <div class="metric-strip">
        <span class="metric-pill">${formatNumber(story.missingFacts.length)} missing facts</span>
        
      </div>
    </a>
  `;
}

function attachPreviewHandlers(stories) {
  const preview = document.getElementById("story-preview");
  const storyMap = new Map(stories.map((story) => [story.id, story]));
  let currentPinnedStory = stories[0] || null;

  for (const card of document.querySelectorAll("[data-story-id]")) {
    const storyId = card.dataset.storyId;
    const story = storyMap.get(storyId);

    const syncDrawerHeight = () => {
      const summary = preview.querySelector('.drawer-summary');
      const factList = preview.querySelector('.fact-list');
      if (summary && factList) {
        // Match the fact list scrollable area to the exact height of the story summary text
        factList.style.maxHeight = `${summary.offsetHeight}px`;
      }
    };

    const updatePreview = () => {
      if (story) {
        preview.innerHTML = renderStoryPreview(story);
        syncDrawerHeight();
      }
    };

    const handleLeave = () => {
      if (currentPinnedStory) {
        preview.innerHTML = renderStoryPreview(currentPinnedStory);
        syncDrawerHeight();
      }
    };

    const handleClick = (e) => {
      e.preventDefault();
      currentPinnedStory = story;
      updatePreview();

      document.querySelectorAll(".newsroom-card").forEach((c) => c.style.borderColor = "");
      card.style.borderColor = "var(--primary)";
    };

    card.addEventListener("mouseenter", updatePreview);
    card.addEventListener("focus", updatePreview);
    card.addEventListener("mouseleave", handleLeave);
    card.addEventListener("blur", handleLeave);
    card.addEventListener("click", handleClick);
  }

  const firstCard = document.querySelector("[data-story-id]");
  if (firstCard) {
    firstCard.style.borderColor = "var(--primary)";
  }

  const summary = preview.querySelector('.drawer-summary');
  const factList = preview.querySelector('.fact-list');
  if (summary && factList) {
    factList.style.maxHeight = `${summary.offsetHeight}px`;
  }
}
