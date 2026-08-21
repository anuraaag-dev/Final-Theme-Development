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

      this.modal = root.querySelector('[data-quiz-modal]');
      this.panel = root.querySelector('[data-quiz-panel]');
      this.body = root.querySelector('[data-quiz-body]');
      this.progressBar = root.querySelector('[data-quiz-progress-bar]');
      this.nextBtn = root.querySelector('[data-quiz-next]');
      this.backBtn = root.querySelector('[data-quiz-back]');

      this.bindLaunchers();
      this.bindModalControls();
      this.maybeAutoPopup();
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
      this.modal.hidden = true;
      document.body.style.overflow = '';
      if (this.lastFocusedEl) this.lastFocusedEl.focus();
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
          body: JSON.stringify({ items: [{ id: parseInt(variantId, 10), quantity: 1 }] }),
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.description || 'Could not add to cart.');
        }

        statusEl.textContent = `${product ? product.title : 'Item'} added to your cart.`;
        btn.textContent = 'Added ✓';
        this.refreshCartUI();
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

    refreshCartUI() {
      fetch('/cart.js')
        .then((r) => r.json())
        .then((cart) => {
          document.querySelectorAll('[data-cart-count]').forEach((el) => {
            el.textContent = cart.item_count;
          });
          document.dispatchEvent(new CustomEvent('cart:updated', { detail: { cart } }));
        })
        .catch(() => {});
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