(function () {
  'use strict';

  function getConfig() {
    var el = document.getElementById('pob-config');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  }

  var config = getConfig();
  if (!config || !config.enabled) return;

  function formatDateForDisplay(dateString) {
    var d = new Date(dateString);
    if (isNaN(d.getTime())) return dateString;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function positionSuffix() {
    var pos = config.badgePosition || 'top-left';
    var valid = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    if (valid.indexOf(pos) === -1) pos = 'top-left';
    return pos;
  }

  /* ---------- Card auto-detection ----------
     IMPORTANT LIMITATION: Shopify's public /products/{handle}.js endpoint
     does not expose real inventory counts, only a Shopify-computed
     "available" flag — which becomes true once "Continue selling when out
     of stock" is on, same issue we just fixed for the PDP. So on collection/
     search cards, we rely ONLY on the merchant's "coming-soon" tag (which
     IS exposed publicly), not on auto-detecting out-of-stock. This is a
     Shopify platform limitation, not something fixable from a theme. */

  function extractRestockDate(tags) {
    if (!config.restockTagPrefix) return null;
    var prefix = config.restockTagPrefix.toLowerCase();
    var match = (tags || []).find(function (t) {
      return t.toLowerCase().indexOf(prefix) === 0;
    });
    return match ? match.slice(prefix.length) : null;
  }

  function computeCardStatus(product) {
    var tag = (config.tag || '').toLowerCase();
    var tagged = tag !== '' && (product.tags || []).some(function (t) {
      return t.toLowerCase() === tag;
    });
    return {
      show: tagged,
      restockDate: extractRestockDate(product.tags)
    };
  }

  function extractHandle(href) {
    var match = href.match(/\/products\/([a-zA-Z0-9\-_%]+)/);
    return match ? match[1].split('?')[0].split('#')[0] : null;
  }

  var cache = new Map();

  function fetchProduct(handle, bypassCache) {
    if (!bypassCache && cache.has(handle)) return cache.get(handle);
    var promise = fetch('/products/' + handle + '.js', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
    cache.set(handle, promise);
    return promise;
  }

  function createBadge() {
    var span = document.createElement('span');
    span.className = 'pob-badge pob-badge--card pob-badge--pos-' + positionSuffix();
    span.setAttribute('data-pob-badge', '');
    span.textContent = config.badgeText || 'Pre-order';
    return span;
  }

  function createDateEl(dateString, isCard) {
    var span = document.createElement('span');
    span.className = 'pob-restock-date' + (isCard ? ' pob-restock-date--card pob-restock-date--pos-' + positionSuffix() : '');
    span.setAttribute('data-pob-restock-date', '');
    span.textContent = (config.restockLabel || 'Expected restock:') + ' ' + formatDateForDisplay(dateString);
    return span;
  }

  function getImageFrame(img) {
    if (img.hasAttribute('data-pob-framed')) {
      return img.parentElement;
    }
    var parent = img.parentElement;
    if (parent) {
      var style = window.getComputedStyle(parent);
      var onlyChild = parent.children.length === 1;
      var clipped = style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden';
      var positioned = style.position === 'relative' || style.position === 'absolute' || style.position === 'sticky';
      if (onlyChild && (clipped || positioned)) {
        img.setAttribute('data-pob-framed', '');
        if (style.position === 'static') parent.style.position = 'relative';
        return parent;
      }
    }
    var wrapper = document.createElement('span');
    wrapper.setAttribute('data-pob-wrap', '');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'block';
    wrapper.style.lineHeight = '0';
    img.parentNode.insertBefore(wrapper, img);
    wrapper.appendChild(img);
    img.setAttribute('data-pob-framed', '');
    return wrapper;
  }

  var cardState = new Map();

  function updateCard(anchor, status) {
    var state = cardState.get(anchor);
    if (!status.show) {
      if (state) {
        if (state.badgeEl) state.badgeEl.remove();
        if (state.dateEl) state.dateEl.remove();
        cardState.delete(anchor);
      }
      return;
    }
    var img = anchor.querySelector('img');
    var container = img ? getImageFrame(img) : anchor;

    if (!state || state.container !== container) {
      if (state) {
        if (state.badgeEl) state.badgeEl.remove();
        if (state.dateEl) state.dateEl.remove();
      }
      var badgeEl = createBadge();
      container.appendChild(badgeEl);
      var dateEl = null;
      if (status.restockDate) {
        dateEl = createDateEl(status.restockDate, true);
        container.appendChild(dateEl);
      }
      cardState.set(anchor, { badgeEl: badgeEl, dateEl: dateEl, container: container });
    } else if (status.restockDate && !state.dateEl) {
      state.dateEl = createDateEl(status.restockDate, true);
      container.appendChild(state.dateEl);
    } else if (!status.restockDate && state.dateEl) {
      state.dateEl.remove();
      state.dateEl = null;
    }
  }

  function processAnchor(anchor, bypassCache) {
    var handle = extractHandle(anchor.getAttribute('href') || '');
    if (!handle) return;
    fetchProduct(handle, bypassCache).then(function (product) {
      if (product) updateCard(anchor, computeCardStatus(product));
    });
  }

  var seen = new WeakSet();
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) processAnchor(entry.target, false);
    });
  }, { rootMargin: '200px' });

  function scan(root) {
    var anchors = (root || document).querySelectorAll('a[href*="/products/"]');
    anchors.forEach(function (a) {
      if (seen.has(a)) return;
      seen.add(a);
      io.observe(a);
    });
  }

  function initCards() {
    if (!config.showOnCards) return;
    scan();
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType === 1) {
            if (node.matches && node.matches('a[href*="/products/"]') && !seen.has(node)) {
              seen.add(node);
              io.observe(node);
            }
            scan(node);
          }
        });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });

    var interval = (config.refreshSeconds || 45) * 1000;
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      cardState.forEach(function (_, anchor) { processAnchor(anchor, true); });
    }, interval);
  }

  /* ---------- PDP: instant, accurate variant-switch updates ---------- */

  function initPdp() {
    var dataEls = document.querySelectorAll('[data-pob-variants-json]');
    if (!dataEls.length) return;

    dataEls.forEach(function (dataEl) {
      var data;
      try {
        data = JSON.parse(dataEl.textContent);
      } catch (e) {
        return;
      }

      var host = dataEl.previousElementSibling;
      if (!host || !host.hasAttribute('data-pob-pdp-anchor')) {
        var parent = dataEl.parentElement;
        host = parent ? parent.querySelector('[data-pob-pdp-anchor]') : null;
      }

      function currentVariantId() {
        var input = document.querySelector('form[action*="/cart/add"] input[name="id"]');
        return input ? input.value : null;
      }

      function isPreorderForVariant(variantId) {
        var v = data.variants.find(function (v) { return String(v.id) === String(variantId); });
        var realOos = v ? v.realOutOfStock : false;
        if (data.tagged && realOos) return true;
        if (data.showOutOfStockSetting && realOos) return true;
        return false;
      }

      function renderBadge(show) {
        if (!host) return;
        host.innerHTML = '';
        if (!show) return;
        var badge = document.createElement('span');
        badge.className = 'pob-badge pob-badge--pdp';
        badge.setAttribute('data-pob-badge', '');
        badge.textContent = data.badgeText || 'Pre-order';
        host.appendChild(badge);
        if (data.restockDate) {
          host.appendChild(createDateEl(data.restockDate, false));
        }
      }

      function renderButtonText(show) {
        document.querySelectorAll('[data-pob-cta-text]').forEach(function (el) {
          if (show) {
            el.textContent = data.buttonText || 'Pre-order';
          } else if (el.dataset.pobOriginalText) {
            el.textContent = el.dataset.pobOriginalText;
          }
        });
      }

      document.querySelectorAll('[data-pob-cta-text]').forEach(function (el) {
        if (!el.dataset.pobOriginalText) {
          el.dataset.pobOriginalText = el.textContent.trim();
        }
      });

      function update() {
        var show = isPreorderForVariant(currentVariantId());
        renderBadge(show);
        renderButtonText(show);
      }

      document.addEventListener('change', function (e) {
        if (e.target.closest && e.target.closest('form[action*="/cart/add"]')) {
          setTimeout(update, 50);
        }
      });

      var input = document.querySelector('form[action*="/cart/add"] input[name="id"]');
      if (input) {
        new MutationObserver(update).observe(input, { attributes: true, attributeFilter: ['value'] });
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initCards();
    initPdp();
  });
})();