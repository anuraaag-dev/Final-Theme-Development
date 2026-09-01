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

  function formatMoney(cents) {
    var amount = (cents / 100).toFixed(2);
    return amount;
  }

  function positionSuffix() {
    var pos = config.badgePosition || 'top-left';
    var valid = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    if (valid.indexOf(pos) === -1) pos = 'top-left';
    return pos;
  }

  /* ---------- Card badges (collections/search) ---------- */

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
    return { show: tagged, restockDate: extractRestockDate(product.tags) };
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
    if (img.hasAttribute('data-pob-framed')) return img.parentElement;
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

  /* ---------- Pre-order modal (self-contained, no dependency on theme markup) ---------- */

  var modalOverlay = null;

  function buildModal() {
    if (modalOverlay) return modalOverlay;

    modalOverlay = document.createElement('div');
    modalOverlay.className = 'pob-modal-overlay';
    modalOverlay.setAttribute('data-pob-modal-overlay', '');

    modalOverlay.innerHTML =
      '<div class="pob-modal" role="dialog" aria-modal="true">' +
        '<button type="button" class="pob-modal__close" data-pob-modal-close aria-label="Close">\u2715</button>' +
        '<h3 class="pob-modal__title" data-pob-modal-title></h3>' +
        '<p class="pob-modal__restock" data-pob-modal-restock></p>' +
        '<div data-pob-modal-options></div>' +
        '<div class="pob-modal__field">' +
          '<label class="pob-modal__label">Quantity</label>' +
          '<input type="number" class="pob-modal__qty" data-pob-modal-qty min="1" value="1">' +
        '</div>' +
        '<p class="pob-modal__price" data-pob-modal-price></p>' +
        '<p class="pob-modal__error" data-pob-modal-error></p>' +
        '<button type="button" class="pob-modal__submit" data-pob-modal-submit>Place Pre-order</button>' +
      '</div>';

    document.body.appendChild(modalOverlay);

    modalOverlay.addEventListener('click', function (e) {
      if (e.target === modalOverlay) closeModal();
    });
    modalOverlay.querySelector('[data-pob-modal-close]').addEventListener('click', closeModal);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modalOverlay.hasAttribute('data-pob-open')) closeModal();
    });

    return modalOverlay;
  }

  function closeModal() {
    if (modalOverlay) modalOverlay.removeAttribute('data-pob-open');
  }

  function openModal(data) {
    var overlay = buildModal();
    overlay.querySelector('[data-pob-modal-title]').textContent = data.title;

    var restockEl = overlay.querySelector('[data-pob-modal-restock]');
    if (data.restockDate) {
      restockEl.textContent = (data.restockLabel || 'Expected restock:') + ' ' + formatDateForDisplay(data.restockDate);
      restockEl.style.display = '';
    } else {
      restockEl.style.display = 'none';
    }

    var optionsHost = overlay.querySelector('[data-pob-modal-options]');
    optionsHost.innerHTML = '';

    var selections = {};
    var currentVariant = data.variants.find(function (v) { return String(v.id) === String(data.currentVariantId); }) || data.variants[0];
    if (currentVariant) {
      selections.option1 = currentVariant.option1;
      selections.option2 = currentVariant.option2;
      selections.option3 = currentVariant.option3;
    }

    var optionKeys = ['option1', 'option2', 'option3'];

    (data.optionNames || []).forEach(function (name, idx) {
      var key = optionKeys[idx];
      var values = Array.from(new Set(data.variants.map(function (v) { return v[key]; }).filter(Boolean)));

      var field = document.createElement('div');
      field.className = 'pob-modal__field';
      var label = document.createElement('label');
      label.className = 'pob-modal__label';
      label.textContent = name;
      var select = document.createElement('select');
      select.className = 'pob-modal__select';
      select.setAttribute('data-pob-option-select', key);

      values.forEach(function (val) {
        var opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        if (val === selections[key]) opt.selected = true;
        select.appendChild(opt);
      });

      select.addEventListener('change', function () {
        selections[key] = select.value;
        refreshSelectedVariant();
      });

      field.appendChild(label);
      field.appendChild(select);
      optionsHost.appendChild(field);
    });

    var priceEl = overlay.querySelector('[data-pob-modal-price]');
    var errorEl = overlay.querySelector('[data-pob-modal-error]');
    var submitBtn = overlay.querySelector('[data-pob-modal-submit]');
    var qtyInput = overlay.querySelector('[data-pob-modal-qty]');

    var matchedVariant = null;

    function refreshSelectedVariant() {
      matchedVariant = data.variants.find(function (v) {
        return (!selections.option1 || v.option1 === selections.option1) &&
               (!selections.option2 || v.option2 === selections.option2) &&
               (!selections.option3 || v.option3 === selections.option3);
      });

      errorEl.removeAttribute('data-pob-show');

      if (!matchedVariant) {
        priceEl.textContent = '';
        submitBtn.disabled = true;
        return;
      }

      priceEl.textContent = formatMoney(matchedVariant.price);
      submitBtn.disabled = false;
    }

    refreshSelectedVariant();

    submitBtn.onclick = function () {
      if (!matchedVariant) return;
      var qty = parseInt(qtyInput.value, 10) || 1;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Placing order...';
      errorEl.removeAttribute('data-pob-show');

      fetch('/cart/add.js', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: matchedVariant.id, quantity: qty })
      })
        .then(function (res) {
          if (!res.ok) {
            return res.json().then(function (err) {
              throw new Error(err.description || 'This item could not be added to your order.');
            });
          }
          return res.json();
        })
        .then(function () {
          window.location.href = '/checkout';
        })
        .catch(function (err) {
          errorEl.textContent = err.message;
          errorEl.setAttribute('data-pob-show', '');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Place Pre-order';
        });
    };

    overlay.setAttribute('data-pob-open', '');
  }

  /* ---------- PDP: badge, native button replacement, modal trigger ---------- */

  function initPdp() {
    var dataEls = document.querySelectorAll('[data-pob-order-data]');
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
        return input ? input.value : data.currentVariantId;
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
        if (data.restockDate) host.appendChild(createDateEl(data.restockDate, false));
      }

      function findCartForm() {
        return document.querySelector('form[action*="/cart/add"]');
      }

      function ensurePreorderButton(show) {
        var form = findCartForm();
        if (!form) return;

        var nativeSubmit = form.querySelector('button[type="submit"]');
        var existingBtn = form.parentElement ? form.parentElement.querySelector('[data-pob-cta-button="' + data.handle + '"]') : null;

        if (!show) {
          if (nativeSubmit) nativeSubmit.style.removeProperty('display');
          if (existingBtn) existingBtn.remove();
          return;
        }

        if (nativeSubmit) nativeSubmit.style.display = 'none';

        if (!existingBtn) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'pob-cta-button';
          btn.setAttribute('data-pob-cta-button', data.handle);
          btn.textContent = data.buttonText || 'Pre-order';
          btn.addEventListener('click', function () {
            openModal(data);
          });
          if (nativeSubmit && nativeSubmit.parentNode) {
            nativeSubmit.parentNode.insertBefore(btn, nativeSubmit.nextSibling);
          } else {
            form.appendChild(btn);
          }
        }
      }

      function update() {
        var show = isPreorderForVariant(currentVariantId());
        renderBadge(show);
        ensurePreorderButton(show);
      }

      update();

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