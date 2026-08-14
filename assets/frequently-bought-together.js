/**
 * Frequently Bought Together — controller
 * Pairs with sections/frequently-bought-together.liquid.
 */
(function () {
  if (customElements.get('frequently-bought-together')) return;

  function formatMoney(cents, format) {
    if (cents == null || isNaN(cents)) cents = 0;
    var formatString = format || '${{amount}}';

    function withDelimiters(number, precision, thousands, decimalSep) {
      precision = precision == null ? 2 : precision;
      thousands = thousands == null ? ',' : thousands;
      decimalSep = decimalSep == null ? '.' : decimalSep;
      var value = (number / 100).toFixed(precision);
      var parts = value.split('.');
      var dollars = parts[0].replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1' + thousands);
      var decimals = parts[1] ? decimalSep + parts[1] : '';
      return dollars + decimals;
    }

    var match = formatString.match(/\{\{\s*(\w+)\s*\}\}/);
    var token = match ? match[1] : 'amount';
    var value;
    switch (token) {
      case 'amount_no_decimals': value = withDelimiters(cents, 0); break;
      case 'amount_with_comma_separator': value = withDelimiters(cents, 2, '.', ','); break;
      case 'amount_no_decimals_with_comma_separator': value = withDelimiters(cents, 0, '.', ','); break;
      default: value = withDelimiters(cents, 2);
    }
    return match ? formatString.replace(match[0], value) : formatString + value;
  }

  function shuffle(array) {
    var result = array.slice();
    for (var i = result.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = result[i]; result[i] = result[j]; result[j] = tmp;
    }
    return result;
  }

  var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  class FBT extends HTMLElement {
    connectedCallback() {
      var configEl = this.querySelector('script[data-fbt-config]');
      if (!configEl) return;

      try { this.config = JSON.parse(configEl.textContent); }
      catch (err) { console.error('Frequently Bought Together: invalid config JSON', err); return; }

      var poolEl = this.querySelector('script[data-fbt-pool]');
      this.pool = [];
      if (poolEl) {
        try { this.pool = JSON.parse(poolEl.textContent) || []; }
        catch (err) { console.warn('Frequently Bought Together: invalid pool JSON', err); }
      }

      this.cardsContainer = this.querySelector('[data-fbt-cards]');
      this.messageEl = this.querySelector('[data-fbt-message]');
      this.currentTotalEl = this.querySelector('[data-fbt-current-total]');
      this.compareTotalEl = this.querySelector('[data-fbt-compare-total]');
      this.savingsEl = this.querySelector('[data-fbt-savings]');
      this.submitEl = this.querySelector('[data-fbt-submit]');
      this.submitTextEl = this.querySelector('[data-fbt-submit-text]');

      this.cards = [];
      this.knownProductIds = new Set();
      this._nextIndex = this.cardsContainer.querySelectorAll('[data-fbt-card]').length;
      this._displayedCents = 0;

      this.registerExistingCards();
      this.submitEl && this.submitEl.addEventListener('click', () => this.handleAddToCart());

      this.ensureEnoughProducts();
      this.recalcTotals();
    }

    // ---- sourcing ----
    companionCount() { return this.cards.filter(function (c) { return !c.isCurrent; }).length; }
    needed() { return Math.max(0, (this.config.maxProducts || 3) - this.companionCount()); }

    async ensureEnoughProducts() {
      var source = this.config.productSource;
      if (source === 'manual' && this.companionCount() > 0) return;
      if (this.needed() === 0) return;

      if (source === 'automatic' || (source === 'manual' && this.companionCount() === 0)) {
        await this.tryAutomatic();
      }
      if (this.needed() > 0 && (source !== 'manual' || this.config.disableSmartFallback === false)) {
        this.tryCollectionPool();
      }
      if (this.companionCount() === 0) {
        this.hidden = true;
        this.style.display = 'none';
      }
      this.recalcTotals();
    }

    async tryAutomatic() {
      try {
        var url = '/recommendations/products.json?product_id=' + encodeURIComponent(this.config.productId) +
          '&limit=' + encodeURIComponent(Math.min(this.needed() + 2, 10)) + '&intent=related';
        var res = await fetch(url);
        if (!res.ok) return;
        var data = await res.json();
        var products = (data && data.products) || [];
        for (var i = 0; i < products.length && this.needed() > 0; i++) {
          var normalized = this.normalizeAutomaticProduct(products[i]);
          if (normalized) this.appendCard(normalized);
        }
      } catch (err) {
        console.warn('Frequently Bought Together: automatic recommendations failed', err);
      }
    }

    tryCollectionPool() {
      if (!this.pool || !this.pool.length) return;
      var candidates = shuffle(this.pool);
      for (var i = 0; i < candidates.length && this.needed() > 0; i++) {
        var normalized = this.normalizePoolProduct(candidates[i]);
        if (normalized) this.appendCard(normalized);
      }
    }

    normalizeAutomaticProduct(raw) {
      if (!raw || this.knownProductIds.has(raw.id)) return null;
      var variants = (raw.variants || []).filter(function (v) { return v.available; }).map(function (v) {
        return {
          id: v.id, title: v.title,
          priceCents: Math.round(parseFloat(v.price) * 100),
          compareCents: v.compare_at_price ? Math.round(parseFloat(v.compare_at_price) * 100) : null,
          available: !!v.available
        };
      });
      if (!variants.length) return null;
      var image = raw.featured_image || (raw.images && raw.images[0]) || null;
      if (image && typeof image === 'object') image = image.src;
      return { id: raw.id, title: raw.title, url: raw.url, vendor: raw.vendor, image: image, variants: variants };
    }

    normalizePoolProduct(raw) {
      if (!raw || this.knownProductIds.has(raw.id)) return null;
      var variants = (raw.variants || []).filter(function (v) { return v.available; }).map(function (v) {
        return { id: v.id, title: v.title, priceCents: v.price, compareCents: v.compare_at_price || null, available: !!v.available };
      });
      if (!variants.length) return null;
      return { id: raw.id, title: raw.title, url: raw.url, vendor: raw.vendor, image: raw.image, variants: variants };
    }

    // ---- rendering ----
    appendCard(product) {
      this.knownProductIds.add(product.id);
      var variant = product.variants[0];

      if (this.config.layout === 'horizontal' && this.cardsContainer.querySelector('[data-fbt-card]')) {
        var connector = document.createElement('div');
        connector.className = 'fbt__connector';
        connector.setAttribute('aria-hidden', 'true');
        connector.textContent = '+';
        this.cardsContainer.appendChild(connector);
      }

      var card = document.createElement('div');
      card.className = 'fbt__card';
      card.setAttribute('data-fbt-card', '');
      card.setAttribute('data-current', 'false');
      card.dataset.productId = product.id;
      card.dataset.variantId = variant.id;
      card.dataset.priceCents = variant.priceCents;
      card.dataset.compareCents = variant.compareCents || '';
      card.dataset.available = 'true';
      card.style.setProperty('--fbt-i', this._nextIndex++);

      var mediaHtml = product.image
        ? '<img class="fbt__image" src="' + product.image + '" loading="lazy" alt="' + escapeHtml(product.title) + '">'
        : '';

      var variantHtml = '';
      if (this.config.showVariantPicker && product.variants.length > 1) {
        var options = product.variants.map(function (v) {
          return '<option value="' + v.id + '" data-price="' + v.priceCents + '" data-compare="' + (v.compareCents || '') + '" data-available="true">' + escapeHtml(v.title) + '</option>';
        }).join('');
        variantHtml = '<select class="fbt__variant-select" data-fbt-variant-select aria-label="Variant - ' + escapeHtml(product.title) + '">' + options + '</select>';
      }

      var vendorHtml = (this.config.showVendor && product.vendor)
        ? '<span class="fbt__vendor">' + escapeHtml(product.vendor) + '</span>' : '';

      var priceHtml = '';
      if (this.config.showPrice) {
        var compareHtml = (this.config.showComparePrice && variant.compareCents && variant.compareCents > variant.priceCents)
          ? '<span class="fbt__price-compare" data-fbt-compare>' + formatMoney(variant.compareCents, this.config.moneyFormat) + '</span>' : '';
        priceHtml = '<span class="fbt__price" data-fbt-price>' + compareHtml +
          '<span class="fbt__price-current" data-fbt-current-price>' + formatMoney(variant.priceCents, this.config.moneyFormat) + '</span></span>';
      }

      card.innerHTML =
        '<label class="fbt__select"><input type="checkbox" data-fbt-checkbox checked><span class="visually-hidden">' + escapeHtml(product.title) + '</span></label>' +
        '<a class="fbt__media" href="' + product.url + '">' + mediaHtml + '</a>' +
        '<span class="fbt__info">' + vendorHtml +
        '<a class="fbt__title" href="' + product.url + '">' + escapeHtml(product.title) + '</a>' +
        variantHtml + priceHtml +
        '<span class="fbt__stock" data-fbt-stock hidden>Out of stock</span></span>';

      this.cardsContainer.appendChild(card);
      this.registerCard(card);
    }

    registerExistingCards() {
      var els = this.cardsContainer.querySelectorAll('[data-fbt-card]');
      for (var i = 0; i < els.length; i++) this.registerCard(els[i]);
    }

    registerCard(el) {
      var record = {
        el: el,
        isCurrent: el.dataset.current === 'true',
        checkbox: el.querySelector('[data-fbt-checkbox]'),
        variantSelect: el.querySelector('[data-fbt-variant-select]')
      };
      this.cards.push(record);
      if (record.checkbox) record.checkbox.addEventListener('change', () => this.recalcTotals());
      if (record.variantSelect) record.variantSelect.addEventListener('change', () => this.onVariantChange(record));
    }

    onVariantChange(record) {
      var select = record.variantSelect;
      var option = select.options[select.selectedIndex];
      var priceCents = parseInt(option.getAttribute('data-price'), 10);
      var compareRaw = option.getAttribute('data-compare');
      var compareCents = compareRaw ? parseInt(compareRaw, 10) : null;
      var available = option.getAttribute('data-available') !== 'false';

      record.el.dataset.variantId = option.value;
      record.el.dataset.priceCents = priceCents;
      record.el.dataset.compareCents = compareCents || '';
      record.el.dataset.available = available ? 'true' : 'false';

      var priceEl = record.el.querySelector('[data-fbt-current-price]');
      var compareEl = record.el.querySelector('[data-fbt-compare]');
      if (priceEl) priceEl.textContent = formatMoney(priceCents, this.config.moneyFormat);
      if (compareEl) {
        if (this.config.showComparePrice && compareCents && compareCents > priceCents) {
          compareEl.hidden = false;
          compareEl.textContent = formatMoney(compareCents, this.config.moneyFormat);
        } else { compareEl.hidden = true; }
      }

      var stockEl = record.el.querySelector('[data-fbt-stock]');
      if (stockEl) stockEl.hidden = available;
      if (record.checkbox) {
        record.checkbox.disabled = !available;
        if (!available) record.checkbox.checked = false;
      }
      this.recalcTotals();
    }

    // ---- totals ----
    computeDiscount(subtotalCents) {
      if (!this.config.enableDiscount || subtotalCents <= 0) return 0;
      var raw = this.config.discountType === 'fixed'
        ? Math.round(Number(this.config.discountValue || 0) * 100)
        : Math.round(subtotalCents * (Number(this.config.discountValue || 0) / 100));
      return Math.min(Math.max(raw, 0), subtotalCents);
    }

    selectedRecords() {
      return this.cards.filter(function (c) {
        return c.checkbox && c.checkbox.checked && c.el.dataset.available !== 'false';
      });
    }

    // Animated count-up between the previously shown total and the new one.
    animateTotal(toCents) {
      if (!this.currentTotalEl) return;
      var fromCents = this._displayedCents || 0;
      this._displayedCents = toCents;

      if (REDUCED_MOTION || fromCents === toCents) {
        this.currentTotalEl.textContent = formatMoney(toCents, this.config.moneyFormat);
        return;
      }

      this.currentTotalEl.classList.remove('fbt--bump');
      void this.currentTotalEl.offsetWidth; // restart animation
      this.currentTotalEl.classList.add('fbt--bump');

      var start = null, duration = 450, el = this.currentTotalEl, fmt = this.config.moneyFormat;
      var self = this;
      function step(ts) {
        if (start === null) start = ts;
        var p = Math.min((ts - start) / duration, 1);
        var eased = 1 - Math.pow(1 - p, 3);
        var val = Math.round(fromCents + (toCents - fromCents) * eased);
        el.textContent = formatMoney(val, fmt);
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = formatMoney(toCents, fmt);
      }
      requestAnimationFrame(step);
    }

    recalcTotals() {
      var selected = this.selectedRecords();
      var subtotalCents = 0, compareSubtotalCents = 0;

      selected.forEach((record) => {
        var price = parseInt(record.el.dataset.priceCents, 10) || 0;
        var compare = parseInt(record.el.dataset.compareCents, 10) || price;
        subtotalCents += price;
        compareSubtotalCents += compare;
      });

      var discountCents = this.computeDiscount(subtotalCents);
      var finalCents = subtotalCents - discountCents;

      if (this.config.showTotal && this.currentTotalEl) this.animateTotal(finalCents);

      if (this.compareTotalEl) {
        var showCompare = compareSubtotalCents > finalCents;
        this.compareTotalEl.hidden = !showCompare;
        if (showCompare) this.compareTotalEl.textContent = formatMoney(compareSubtotalCents, this.config.moneyFormat);
      }
      if (this.savingsEl) {
        var totalSavings = discountCents + Math.max(0, compareSubtotalCents - subtotalCents);
        if (this.config.enableDiscount && totalSavings > 0) {
          this.savingsEl.hidden = false;
          var label = this.config.discountBadgeText || (this.config.strings && this.config.strings.savings) || 'You save __AMOUNT__';
          this.savingsEl.textContent = label.indexOf('__AMOUNT__') > -1
            ? label.replace('__AMOUNT__', formatMoney(totalSavings, this.config.moneyFormat))
            : label + ' — ' + formatMoney(totalSavings, this.config.moneyFormat);
        } else { this.savingsEl.hidden = true; }
      }

      if (this.submitEl) this.submitEl.disabled = selected.length === 0;
      if (this.submitTextEl) {
        var strings = this.config.strings || {};
        if (selected.length > 1 && strings.buttonCount) {
          this.submitTextEl.textContent = strings.buttonCount.replace('__COUNT__', selected.length);
        } else {
          this.submitTextEl.textContent = strings.buttonSingle || this.config.buttonText || 'Add to cart';
        }
      }
      this.setMessage(selected.length === 0 ? this.defaultMessage() : '', false);
    }

    defaultMessage() { return "Select the items you'd like to add together."; }

    setMessage(text, isError) {
      if (!this.messageEl) return;
      this.messageEl.textContent = text || this.defaultMessage();
      this.messageEl.classList.toggle('is-error', !!isError);
      if (isError) this.messageEl.setAttribute('role', 'alert');
      else this.messageEl.removeAttribute('role');
    }

    // ---- add to cart ----
    async handleAddToCart() {
      var selected = this.selectedRecords();
      var strings = this.config.strings || {};

      if (selected.length === 0) { this.setMessage(strings.selectAtLeastOne, true); return; }

      var items = [];
      for (var i = 0; i < selected.length; i++) {
        var variantId = parseInt(selected[i].el.dataset.variantId, 10);
        if (!variantId) { this.setMessage(strings.chooseOptions, true); return; }
        items.push({ id: variantId, quantity: 1 });
      }

      this.submitEl.disabled = true;
      var originalText = this.submitTextEl ? this.submitTextEl.textContent : '';
      if (this.submitTextEl && strings.adding) this.submitTextEl.textContent = strings.adding;

      try {
        var res = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ items: items })
        });
        if (!res.ok) {
          var errBody = await res.json().catch(function () { return {}; });
          throw new Error(errBody.description || 'Add to cart failed');
        }

        if (this.config.reloadAfterAdd) { window.location.reload(); return; }

        await this.refreshCartUI();

        if (this.config.enableDiscount && this.config.discountCode) {
          fetch('/discount/' + encodeURIComponent(this.config.discountCode) + '?redirect=/cart', { redirect: 'follow' }).catch(function () {});
        }

        if (this.submitTextEl && strings.added) {
          this.submitTextEl.textContent = strings.added;
          setTimeout(() => this.recalcTotals(), 1800);
        } else { this.recalcTotals(); }
        this.setMessage('', false);
      } catch (err) {
        console.error('Frequently Bought Together: add to cart failed', err);
        this.setMessage(strings.genericError, true);
        if (this.submitTextEl) this.submitTextEl.textContent = originalText;
        this.recalcTotals();
      }
    }

    // Auto-detect Horizon's cart drawer: refresh its contents via the Section
    // Rendering API, fire the events Horizon listens for, then open it.
    async refreshCartUI() {
      // 1. Patch any configured section IDs into the live DOM.
      var raw = this.config.cartSectionsToRenderRaw || '';
      var ids = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var cart = null;

      try {
        var cartRes = await fetch('/cart.js');
        if (cartRes.ok) cart = await cartRes.json();
      } catch (err) { /* non-fatal */ }

      if (ids.length) {
        try {
          var res = await fetch('/?sections=' + ids.map(encodeURIComponent).join(','));
          if (res.ok) {
            var data = await res.json();
            var parser = new DOMParser();
            ids.forEach(function (id) {
              var html = data[id];
              if (!html) return;
              var doc = parser.parseFromString(html, 'text/html');
              var incoming = doc.getElementById(id) || doc.body.firstElementChild;
              var existing = document.getElementById(id) ||
                document.querySelector('#shopify-section-' + id + ' [id]') ||
                document.querySelector('[data-section-id="' + id + '"]');
              if (incoming && existing) existing.innerHTML = incoming.innerHTML;
            });
          }
        } catch (err) {
          console.warn('FBT: section refresh failed', err);
        }
      }

      // 2. Broadcast the events Horizon / Dawn-family themes listen for so
      //    the drawer + cart bubble re-sync from the server cart.
      ['cart:refresh', 'cart:updated', 'cart:update', 'cart:change', 'cart:build'].forEach(function (name) {
        document.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: { cart: cart } }));
      });
      if (window.Shopify && window.Shopify.designMode) { /* editor: no-op */ }

      // 3. Find the cart drawer web component and call whatever open/refresh
      //    method it exposes. We don't assume a single API — we probe the
      //    common ones across Horizon and Dawn-derived themes.
      var drawer =
        document.querySelector('cart-drawer') ||
        document.querySelector('[id*="cart-drawer" i]') ||
        document.querySelector('.cart-drawer') ||
        document.querySelector('[data-cart-drawer]');

      if (drawer) {
        // Refresh contents if the component supports it.
        ['refresh', 'renderContents', 'updateContents', 'fetchCart', 'onCartUpdate'].forEach(function (fn) {
          try { if (typeof drawer[fn] === 'function' && fn !== 'renderContents') drawer[fn](); } catch (e) {}
        });
        // Open it.
        var opened = false;
        ['open', 'show', 'showDialog'].forEach(function (fn) {
          if (opened) return;
          try { if (typeof drawer[fn] === 'function') { drawer[fn](); opened = true; } } catch (e) {}
        });
        // Some Horizon drawers open via attribute / class or a <dialog> child.
        if (!opened) {
          var dialog = drawer.querySelector('dialog');
          if (dialog && typeof dialog.showModal === 'function') {
            try { dialog.showModal(); opened = true; } catch (e) {}
          }
        }
        if (!opened) {
          drawer.setAttribute('open', '');
          drawer.classList.add('active', 'is-open', 'open');
        }
        return;
      }

      // 4. No drawer component found — fall back to opening a cart notification
      //    popup if present, else send the shopper to the cart page.
      var notif = document.querySelector('cart-notification');
      if (notif && typeof notif.open === 'function') { try { notif.open(); return; } catch (e) {} }
      console.warn('FBT: no cart drawer detected. Turn on "Reload page after adding to cart" as a fallback, or set the correct cart section IDs.');
    }
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  customElements.define('frequently-bought-together', FBT);
})();