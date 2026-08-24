(function () {
  'use strict';

  class AIQuiz {
    constructor(root) {
      this.root = root;
      this.id = root.dataset.quizId;
      this.products = this.readJSON('[data-quiz-products]');
      this.questions = this.readJSON('[data-quiz-questions]');
      this.fallbackProducts = this.readJSON('[data-quiz-fallback]');
      this.minScore = parseInt(root.dataset.minScore, 10) || 10;
      this.maxResults = parseInt(root.dataset.maxResults, 10) || 3;
      this.launchMode = root.dataset.launchMode;
      this.popupDelay = parseInt(root.dataset.popupDelay, 10) || 8;
      this.popupFrequency = root.dataset.popupFrequency;

      this.answers = {};
      this.currentIndex = 0;
      this.lastFocusedEl = null;
      this.submitting = false;
      this.isEmbedded = this.launchMode === 'embedded';
      this.hasCompletedThisRun = false;

      // In embedded mode there is no <dialog>/modal wrapper — this.modal
      // stays null and every modal-only code path below checks isEmbedded first.
      this.modal = root.querySelector('[data-quiz-modal]');
      this.panel = root.querySelector('[data-quiz-panel]');
      this.body = root.querySelector('[data-quiz-body]');
      this.progressBar = root.querySelector('[data-quiz-progress-bar]');
      this.nextBtn = root.querySelector('[data-quiz-next]');
      this.backBtn = root.querySelector('[data-quiz-back]');

      this.bindLaunchers();
      this.bindModalControls();
      this.maybeAutoPopup();

      if (this.isEmbedded) {
        this.startEmbedded();
      }
    }

    readJSON(selector) {
      const el = this.root.querySelector(selector);
      if (!el) return [];
      try {
        return JSON.parse(el.textContent);
      } catch (e) {
        console.error('AIQuiz: failed to parse', selector, e);
        return [];
      }
    }

    bindLaunchers() {
      this.root.querySelectorAll('[data-quiz-open]').forEach((btn) => {
        btn.addEventListener('click', () => this.open());
      });
    }

    bindModalControls() {
      this.root.querySelectorAll('[data-quiz-close]').forEach((el) => {
        el.addEventListener('click', () => this.close());
      });
      this.nextBtn.addEventListener('click', () => this.goNext());
      this.backBtn.addEventListener('click', () => this.goBack());
      document.addEventListener('keydown', (e) => {
        if (this.isEmbedded) return; // no modal to close/trap in embedded mode
        if (this.modal.hidden) return;
        if (e.key === 'Escape') this.close();
        if (e.key === 'Tab') this.trapFocus(e);
      });
    }

    maybeAutoPopup() {
      if (this.launchMode !== 'popup') return;
      const storageKey = `ai_quiz_popup_${this.id}`;
      const now = Date.now();
      const stored = localStorage.getItem(storageKey);

      if (this.popupFrequency === 'session' && sessionStorage.getItem(storageKey)) return;
      if (this.popupFrequency === 'day' && stored && now - parseInt(stored, 10) < 86400000) return;

      setTimeout(() => {
        this.open();
        if (this.popupFrequency === 'session') sessionStorage.setItem(storageKey, '1');
        if (this.popupFrequency === 'day') localStorage.setItem(storageKey, String(now));
      }, this.popupDelay * 1000);
    }

    open() {
      if (this.isEmbedded) return; // embedded quiz is always visible, nothing to "open"
      this.lastFocusedEl = document.activeElement;
      this.modal.hidden = false;
      document.body.style.overflow = 'hidden';
      this.answers = {};
      this.currentIndex = 0;
      this.nextBtn.hidden = false;
      this.backBtn.hidden = true;
      this.renderQuestion();
      requestAnimationFrame(() => {
        const firstFocusable = this.panel.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (firstFocusable) firstFocusable.focus();
      });
    }

    close() {
      if (this.isEmbedded) return;
      this.modal.hidden = true;
      document.body.style.overflow = '';
      if (this.lastFocusedEl) this.lastFocusedEl.focus();
    }

    // Starts (or restarts) the embedded quiz in place — no dialog to open,
    // just resets state and renders question 1 directly into the page.
    startEmbedded() {
      this.answers = {};
      this.currentIndex = 0;
      this.nextBtn.hidden = false;
      if (this.backBtn) this.backBtn.hidden = true;
      this.renderQuestion();
      this.setupEmbeddedResetObserver();
    }

    // "While moving up and down again quiz section shows question number
    // one": once the shopper has completed a run (added something to cart),
    // scrolling the embedded section out of view and back in resets it to
    // question 1 for the next round — the shopper never has to press
    // anything else.
    setupEmbeddedResetObserver() {
      if (this._embeddedObserver || !('IntersectionObserver' in window)) return;

      let wasInView = true;
      this._embeddedObserver = new IntersectionObserver(
        (entries) => {
          const isInView = entries[0].isIntersecting;
          if (isInView && !wasInView && this.hasCompletedThisRun) {
            this.hasCompletedThisRun = false;
            this.startEmbedded();
          }
          wasInView = isInView;
        },
        { threshold: 0.25 }
      );
      this._embeddedObserver.observe(this.root);
    }
    trapFocus(e) {
      const focusables = Array.from(
        this.panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    renderQuestion() {
      if (this.currentIndex >= this.questions.length) {
        this.renderLoading();
        setTimeout(() => this.renderResults(), 600);
        return;
      }

      const q = this.questions[this.currentIndex];
      const pct = Math.round((this.currentIndex / this.questions.length) * 100);
      this.progressBar.style.width = pct + '%';
      this.backBtn.hidden = this.currentIndex === 0;
      this.nextBtn.disabled = !this.answers[q.id];
      this.nextBtn.textContent = this.currentIndex === this.questions.length - 1 ? 'See My Matches' : 'Next';

      const options = Array.isArray(q.options) ? q.options : [];

      if (!options.length) {
        this.body.innerHTML = `
          <h2 class="ai-quiz-q-title" id="quiz-title-${this.id}">${this.escape(q.title)}</h2>
          <p class="ai-quiz-q-subtitle">This question has no answer options configured yet. Open this block's settings and fill in at least Option 1's Label and Value.</p>
        `;
        return;
      }

      this.body.innerHTML = `
        <h2 class="ai-quiz-q-title" id="quiz-title-${this.id}">${this.escape(q.title)}</h2>
        ${q.subtitle ? `<p class="ai-quiz-q-subtitle">${this.escape(q.subtitle)}</p>` : ''}
        <div class="ai-quiz-options" role="group" aria-label="${this.escape(q.title)}">
          ${options
            .map(
              (opt) => `
            <button type="button"
              class="ai-quiz-option ${this.answers[q.id] === opt.value ? 'is-selected' : ''}"
              data-quiz-option
              data-value="${this.escape(opt.value)}"
              aria-pressed="${this.answers[q.id] === opt.value}">
              <span>${this.escape(opt.label)}</span>
            </button>
          `
            )
            .join('')}
        </div>
      `;

      this.body.querySelectorAll('[data-quiz-option]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.answers[q.id] = btn.dataset.value;
          this.body.querySelectorAll('[data-quiz-option]').forEach((b) => {
            b.classList.remove('is-selected');
            b.setAttribute('aria-pressed', 'false');
          });
          btn.classList.add('is-selected');
          btn.setAttribute('aria-pressed', 'true');
          this.nextBtn.disabled = false;
        });
      });
    }

    goNext() {
      this.currentIndex += 1;
      this.renderQuestion();
    }

    goBack() {
      this.currentIndex = Math.max(0, this.currentIndex - 1);
      this.renderQuestion();
    }

    renderLoading() {
      this.progressBar.style.width = '100%';
      this.backBtn.hidden = true;
      this.nextBtn.hidden = true;
      this.body.innerHTML = `
        <div class="ai-quiz-loading">
          <div class="ai-quiz-spinner" aria-hidden="true"></div>
          <p>Finding your best matches…</p>
        </div>
      `;
    }

    scoreProduct(product) {
      const tags = (product.tags || []).map((t) => String(t).toLowerCase());
      let score = 0;

      for (const q of this.questions) {
        const answerValue = this.answers[q.id];
        if (!answerValue) continue;

        const matchTag = `${q.tag_prefix}-${answerValue}`.toLowerCase();
        const excludeTag = `exclude-${q.tag_prefix}-${answerValue}`.toLowerCase();

        if (tags.includes(excludeTag)) return -1;
        if (tags.includes(matchTag)) score += Number(q.weight) || 0;
      }

      return score;
    }

    matchLabel(score) {
      const maxPossible = this.questions.reduce((sum, q) => sum + (Number(q.weight) || 0), 0) || 1;
      const pct = Math.round((score / maxPossible) * 100);
      if (pct >= 85) return 'Best Match';
      if (pct >= 60) return 'Great Match';
      return 'Good Match';
    }

    renderResults() {
      const scored = this.products
        .map((p) => ({ product: p, score: this.scoreProduct(p) }))
        .filter((entry) => entry.score >= this.minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, this.maxResults);

      this.nextBtn.hidden = true;
      this.backBtn.hidden = true;

      if (!scored.length) {
        this.renderFallback();
        return;
      }

      this.body.innerHTML = `
        <h2 class="ai-quiz-results-title">Your Recommended Products</h2>
        <div class="ai-quiz-results">
          ${scored.map((entry, i) => this.renderProductCard(entry, i === 0)).join('')}
        </div>
      `;

      this.bindResultCards(scored.map((e) => e.product));
    }

    renderFallback() {
      if (!this.fallbackProducts.length) {
        this.body.innerHTML = `
          <div class="ai-quiz-empty">
            <p>We couldn't find a strong match right now.</p>
            <a href="/collections/all" class="ai-quiz-btn ai-quiz-btn--primary">Browse All Products</a>
          </div>
        `;
        return;
      }
      this.body.innerHTML = `
        <h2 class="ai-quiz-results-title">Popular Picks For You</h2>
        <div class="ai-quiz-results">
          ${this.fallbackProducts.map((p) => this.renderProductCard({ product: p, score: null }, false)).join('')}
        </div>
      `;
      this.bindResultCards(this.fallbackProducts);
    }

    renderProductCard(entry, featured) {
      const p = entry.product;
      const hasMultipleVariants = Array.isArray(p.variants) && p.variants.length > 1;
      const singleVariant = Array.isArray(p.variants) && p.variants.length === 1 ? p.variants[0] : null;

      return `
        <div class="ai-quiz-product-card ${featured ? 'is-featured' : ''}" data-quiz-product="${p.id}">
          ${entry.score !== null ? `<span class="ai-quiz-match-badge">${this.matchLabel(entry.score)}</span>` : ''}
          <img src="${p.image || ''}" alt="${this.escape(p.title)}" loading="lazy" width="90" height="90">
          <h3>${this.escape(p.title)}</h3>
          <p class="ai-quiz-price">${this.formatMoney(p.price)}</p>
          ${!p.available ? '<p class="ai-quiz-soldout">Currently sold out</p>' : ''}

          ${
            hasMultipleVariants
              ? `<select class="ai-quiz-variant-select" data-quiz-variant-select>
                  ${p.variants
                    .map(
                      (v) =>
                        `<option value="${v.id}" ${!v.available ? 'disabled' : ''}>${this.escape(v.title)}${
                          !v.available ? ' (sold out)' : ''
                        }</option>`
                    )
                    .join('')}
                </select>`
              : ''
          }

          <div class="ai-quiz-card-actions">
            <a href="${p.url}" class="ai-quiz-btn ai-quiz-btn--ghost">View Product</a>
            <button type="button"
              class="ai-quiz-btn ai-quiz-btn--primary"
              data-quiz-add-to-cart
              data-single-variant-id="${singleVariant ? singleVariant.id : ''}"
              ${!p.available ? 'disabled' : ''}>
              Add to Cart
            </button>
          </div>
          <p class="ai-quiz-cart-status" data-quiz-cart-status aria-live="polite"></p>
        </div>
      `;
    }

    bindResultCards(products) {
      this.body.querySelectorAll('[data-quiz-product]').forEach((card) => {
        const productId = card.dataset.quizProduct;
        const product = products.find((p) => String(p.id) === String(productId));
        const addBtn = card.querySelector('[data-quiz-add-to-cart]');
        const variantSelect = card.querySelector('[data-quiz-variant-select]');
        const statusEl = card.querySelector('[data-quiz-cart-status]');

        addBtn.addEventListener('click', () => {
          let variantId = addBtn.dataset.singleVariantId;
          if (variantSelect) variantId = variantSelect.value;
          if (!variantId) {
            statusEl.textContent = 'Please select an option.';
            return;
          }
          this.addToCart(variantId, addBtn, statusEl, product);
        });
      });
    }

    async addToCart(variantId, btn, statusEl, product) {
      if (this.submitting) return;
      this.submitting = true;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = 'Adding…';
      statusEl.textContent = '';

      try {
        const response = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [{ id: parseInt(variantId, 10), quantity: 1 }],
            // The wrapper div in cart-drawer.liquid is
            // id="shopify-section-cart-drawer-section", which means the
            // real registered section ID is "cart-drawer-section" (Shopify
            // always prefixes real IDs with "shopify-section-"). The inner
            // <theme-drawer id="cart-drawer"> is a different, nested ID —
            // requesting the wrong one silently returns nothing.
            sections: 'cart-drawer-section',
            sections_url: window.location.pathname,
          }),
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.description || 'Could not add to cart.');
        }

        const data = await response.json();

        statusEl.textContent = `${product ? product.title : 'Item'} added to your cart.`;
        btn.textContent = 'Added ✓';
        this.hasCompletedThisRun = true;

        if (data.sections && data.sections['cart-drawer-section']) {
          this.injectFreshCartDrawer(data.sections['cart-drawer-section']);
        }
        this.openCartDrawer();
      } catch (err) {
        console.error('AIQuiz add to cart failed:', err);
        statusEl.textContent = err.message || 'Something went wrong. Please try again.';
        btn.textContent = originalText;
        btn.disabled = false;
      } finally {
        this.submitting = false;
        setTimeout(() => {
          if (btn.textContent === 'Added ✓') {
            btn.textContent = originalText;
            btn.disabled = false;
          }
        }, 2000);
      }
    }

    // Replaces the live <theme-drawer id="cart-drawer"> with the freshly
    // server-rendered version Shopify just sent back, so the drawer's
    // Liquid-generated item list is correct without a page reload.
    injectFreshCartDrawer(html) {
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');

        // Prefer swapping the whole section wrapper (matches what a real
        // page load produces); fall back to just the inner drawer element
        // if the wrapper isn't present in the live DOM for some reason.
        const freshWrapper = doc.getElementById('shopify-section-cart-drawer-section');
        const currentWrapper = document.getElementById('shopify-section-cart-drawer-section');

        if (freshWrapper && currentWrapper && currentWrapper.parentNode) {
          currentWrapper.replaceWith(freshWrapper);
          return;
        }

        const freshDrawer = doc.getElementById('cart-drawer');
        const currentDrawer = document.getElementById('cart-drawer');
        if (freshDrawer && currentDrawer && currentDrawer.parentNode) {
          currentDrawer.replaceWith(freshDrawer);
        }
      } catch (e) {
        console.error('AIQuiz: failed to refresh cart drawer markup', e);
      }
    }

    // Calls the theme's own drawer open method directly — the same call
    // CartDrawerComponent makes internally — instead of simulating clicks.
    openCartDrawer() {
      const drawer = document.getElementById('cart-drawer');
      if (drawer && typeof drawer.open === 'function') {
        drawer.open();
      } else {
        console.warn('AIQuiz: could not find cart-drawer element with an open() method.');
      }
    }

    // Best-effort attempt to re-fetch the cart drawer's own HTML via
    // Shopify's Section Rendering API, since /cart/add.js only updates
    // cart data — it never re-renders the drawer's server-side markup.
    // This guesses common section IDs; a guaranteed fix needs your
    // theme's real cart-drawer file (ask your developer/AI for it).
    async refreshCartDrawerContents() {
      const guessedSectionIds = ['cart-drawer', 'cart-notification', 'CartDrawer'];

      for (const sectionId of guessedSectionIds) {
        try {
          const response = await fetch(`/?section_id=${sectionId}`);
          if (!response.ok) continue;
          const html = await response.text();
          if (!html || html.length < 50) continue;

          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          const newContent = doc.body.firstElementChild;
          const existing =
            document.getElementById(sectionId) ||
            document.querySelector(`[data-section-id="${sectionId}"]`) ||
            document.querySelector('cart-drawer') ||
            document.querySelector('cart-notification');

          if (newContent && existing && existing.parentNode) {
            existing.replaceWith(newContent);
            return;
          }
        } catch (e) {
          // Try the next guess silently.
        }
      }
      // None of the guesses matched this theme's structure.
    }

    openThemeCartDrawer() {
      document.dispatchEvent(new CustomEvent('cart:refresh'));
      document.dispatchEvent(new CustomEvent('cart:open'));

      const candidates = [
        '[data-cart-drawer-toggle]',
        '#cart-icon-bubble',
        'cart-icon-bubble',
        'a[href="/cart"]',
        'a[href*="/cart"]',
        '[data-cart-icon]',
      ];

      for (const selector of candidates) {
        const el = document.querySelector(selector);
        if (el) {
          el.click();
          return;
        }
      }
    }

    escape(str) {
      if (str == null) return '';
      const div = document.createElement('div');
      div.textContent = String(str);
      return div.innerHTML;
    }

    formatMoney(cents) {
      if (typeof cents !== 'number') return '';
      return (cents / 100).toLocaleString(undefined, {
        style: 'currency',
        currency: (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || 'USD',
      });
    }
  }

  function init() {
    document.querySelectorAll('.ai-quiz-root').forEach((root) => {
      if (root.dataset.quizInitialized) return;
      root.dataset.quizInitialized = 'true';
      new AIQuiz(root);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();