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

  /* ---------- Shared status logic ---------- */

  function extractRestockDate(tags) {
    if (!config.restockTagPrefix) return null;
    var prefix = config.restockTagPrefix.toLowerCase();
    var match = (tags || []).find(function (t) {
      return t.toLowerCase().indexOf(prefix) === 0;
    });
    return match ? match.slice(prefix.length) : null;
  }

  function computeStatus(product) {
    var tag = (config.tag || '').toLowerCase();
    var tagged = tag !== '' && (product.tags || []).some(function (t) {
      return t.toLowerCase() === tag;
    });
    var outOfStock = config.showOutOfStock && product.available === false;
    return {
      show: tagged || outOfStock,
      restockDate: extractRestockDate(product.tags)
    };
  }

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

  /* ---------- Card auto-detection ---------- */

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

  /**
   * Guarantees a badge-safe container sized to exactly the image, regardless
   * of the surrounding theme markup: if the image's direct parent is already
   * a tight, clipped/positioned wrapper, reuse it; otherwise wrap the image
   * itself in a purpose-built span. This replaces markup-guessing with
   * construction, so it can't misfire on any theme's card layout.
   */
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
      if (product) updateCard(anchor, computeStatus(product));
    });
  }

  var seen = new WeakSet();
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        processAnchor(entry.target, false);
      }
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
      cardState.forEach(function (_, anchor) {
        processAnchor(anchor, true);
      });
    }, interval);
  }

  /* ---------- PDP: instant variant switch + periodic live refresh ---------- */

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
      if (!host) return;

      function render(show, restockDate) {
        host.innerHTML = '';
        if (!show) return;
        var badge = document.createElement('span');
        badge.className = 'pob-badge pob-badge--pdp';
        badge.setAttribute('data-pob-badge', '');
        badge.textContent = data.badgeText || 'Pre-order';
        host.appendChild(badge);
        if (restockDate) {
          host.appendChild(createDateEl(restockDate, false));
        }
      }

      function currentVariantId() {
        var input = document.querySelector('form[action*="/cart/add"] input[name="id"]');
        return input ? input.value : null;
      }

      function shouldShowForVariant(variantId) {
        if (data.taggedComingSoon) return true;
        if (!data.showOutOfStock) return false;
        var v = data.variants.find(function (v) { return String(v.id) === String(variantId); });
        return v ? v.available === false : false;
      }

      var lastRestockDate = null;

      function updateOnVariantChange() {
        render(shouldShowForVariant(currentVariantId()), lastRestockDate);
      }

      document.addEventListener('change', function (e) {
        if (e.target.closest && e.target.closest('form[action*="/cart/add"]')) {
          setTimeout(updateOnVariantChange, 50);
        }
      });

      var input = document.querySelector('form[action*="/cart/add"] input[name="id"]');
      if (input) {
        new MutationObserver(updateOnVariantChange).observe(input, { attributes: true, attributeFilter: ['value'] });
      }

      if (!data.handle) return;

      function refreshFromServer() {
        fetchProduct(data.handle, true).then(function (product) {
          if (!product) return;
          data.taggedComingSoon = (config.tag || '').toLowerCase() !== '' &&
            (product.tags || []).some(function (t) { return t.toLowerCase() === config.tag.toLowerCase(); });
          data.variants = (product.variants || []).map(function (v) {
            return { id: v.id, available: v.available };
          });
          lastRestockDate = extractRestockDate(product.tags);
          updateOnVariantChange();
        });
      }

      var interval = (config.refreshSeconds || 45) * 1000;
      setInterval(function () {
        if (document.visibilityState === 'visible') refreshFromServer();
      }, interval);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initCards();
    initPdp();
  });
})();