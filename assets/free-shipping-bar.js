(function() {
  if (window.__fsbInitialized) return;
  window.__fsbInitialized = true;

  var fsbInternalMutationDepth = 0;

function fsbInstallFetchPatch() {
  if (window.fetch.__fsbPatched) return;

  var origFetch = window.fetch;
  var patched = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var isCartMutation = /\/cart\/(add|change|update)(\.js)?(\?|$)/.test(url);
    var isInternal = fsbInternalMutationDepth > 0;
    var p = origFetch.apply(this, arguments);
    if (isCartMutation && !isInternal) {
      p.then(function() { fsbTriggerCycle(); }).catch(function() {});
    }
    return p;
  };
  patched.__fsbPatched = true;
  window.fetch = patched;
}

fsbInstallFetchPatch();

// Defensive re-check: if some other script replaces window.fetch after
// us (common with third-party analytics/perf scripts), our patch would
// silently vanish with no error. Re-install it periodically so cart
// mutation detection can never be permanently lost.
setInterval(fsbInstallFetchPatch, 2000);

  function fsbInternalFetch(url, opts) {
    fsbInternalMutationDepth++;
    return fetch(url, opts)
      .then(function(res) {
        if (!res.ok) {
          return res.text().then(function(bodyText) {
            console.error('[FSB] Cart mutation failed:', url, res.status, bodyText);
            var err = new Error('FSB mutation failed: ' + res.status);
            err.status = res.status;
            err.body = bodyText;
            throw err;
          });
        }
        return res.json();
      })
      .finally(function() {
        fsbInternalMutationDepth--;
      });
  }

  var fsbQueue = Promise.resolve();
  function fsbEnqueue(fn) {
    fsbQueue = fsbQueue.then(fn, fn);
    return fsbQueue;
  }

  function fsbReadConfig() {
    var el = document.querySelector('[data-fsb-config]');
    if (!el) return null;
    try {
      var parsed = JSON.parse(el.textContent);
      parsed.giftTiers = (parsed.giftTiers || []).filter(Boolean);
      parsed.giftTitles = (parsed.giftTitles || []).filter(Boolean);
      parsed.discountTiers = (parsed.discountTiers || []).filter(Boolean);
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function fsbQualifyingTotal(cart) {
    var total = 0;
    cart.items.forEach(function(item) {
      var isGift = item.properties && item.properties['_fsb_tier'];
      if (!isGift) total += item.line_price;
    });
    return total;
  }

  // Matches by _fsb_tier property or variant ID first (authoritative).
  // Falls back to a "Free "-stripped title match only as a safety net,
  // per explicit request, in case a gift line ever lacks the property.
  function fsbFindGiftItem(cart, tier, giftTitles) {
    var byPropertyOrVariant = cart.items.find(function(item) {
      var isPropertyMatch = item.properties && String(item.properties['_fsb_tier']) === String(tier.tier);
      var isVariantMatch = item.variant_id === tier.variantId;
      return isPropertyMatch || isVariantMatch;
    });
    if (byPropertyOrVariant) return byPropertyOrVariant;

    if (giftTitles && giftTitles.length) {
      return cart.items.find(function(item) {
        return giftTitles.some(function(title) {
          if (!title) return false;
          var stripped = title.replace(/^free\s+/i, '').trim();
          return item.title.indexOf(stripped) !== -1 || item.title.indexOf(title) !== -1;
        });
      });
    }
    return undefined;
  }

  // function fsbApplyDiscountCodes(cart, qualifying, discountTiers) {
  //   if (!discountTiers || !discountTiers.length) return Promise.resolve();
  //   var desired = discountTiers
  //     .filter(function(t) { return qualifying >= t.thresholdCents; })
  //     .map(function(t) { return t.code; });
  //   if (!desired.length) return Promise.resolve();

  //   var current = (cart.discount_codes || []).map(function(d) { return d.code; });
  //   var merged = current.slice();
  //   var changed = false;
  //   desired.forEach(function(code) {
  //     if (merged.indexOf(code) === -1) { merged.push(code); changed = true; }
  //   });
  //   if (!changed) return Promise.resolve();

  //   return fsbInternalFetch('/cart/update.js', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ discount: merged.join(',') })
  //   }).catch(function(err) {
  //     console.error('[FSB] Discount application failed:', err);
  //   });
  // }

  function fsbComputeGiftActions(cart, giftTiers, giftTitles) {
    var qualifyingTotal = fsbQualifyingTotal(cart);
    var itemsToAdd = [];
    var updates = {};

    giftTiers.forEach(function(tier) {
      var existingItem = fsbFindGiftItem(cart, tier, giftTitles);

      if (qualifyingTotal >= tier.thresholdCents) {
        if (!existingItem) {
          itemsToAdd.push({
            id: tier.variantId,
            quantity: 1,
            properties: { '_fsb_tier': String(tier.tier) }
          });
        } else if (existingItem.quantity !== 1) {
          updates[existingItem.key] = 1;
        }
      } else {
        if (existingItem) {
          updates[existingItem.key] = 0;
        }
      }
    });

    return { itemsToAdd: itemsToAdd, updates: updates };
  }

  function fsbReconcileGifts(cart, giftTiers, giftTitles, attempt) {
    if (!giftTiers || giftTiers.length === 0) return Promise.resolve(cart);
    attempt = attempt || 1;

    var actions = fsbComputeGiftActions(cart, giftTiers, giftTitles);
    var hasWork = actions.itemsToAdd.length > 0 || Object.keys(actions.updates).length > 0;

    if (!hasWork) return Promise.resolve(cart);

    var sequence = Promise.resolve();

    if (actions.itemsToAdd.length > 0) {
      sequence = sequence.then(function() {
        return fsbInternalFetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: actions.itemsToAdd })
        }).catch(function(err) {
          console.error('[FSB] Gift add.js failed:', err);
          throw err;
        });
      });
    }

    if (Object.keys(actions.updates).length > 0) {
      sequence = sequence.then(function() {
        return fsbInternalFetch('/cart/update.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: actions.updates })
        }).catch(function(err) {
          console.error('[FSB] Gift update.js failed:', err);
          throw err;
        });
      });
    }

    return sequence
      .then(function() {
        return fetch('/cart.js', { cache: 'no-store' }).then(function(r) { return r.json(); });
      })
      .then(function(verifiedCart) {
        var qualifying = fsbQualifyingTotal(verifiedCart);
        var allCorrect = giftTiers.every(function(tier) {
          var item = fsbFindGiftItem(verifiedCart, tier, giftTitles);
          var shouldExist = qualifying >= tier.thresholdCents;
          if (shouldExist) return !!item && item.quantity === 1;
          return !item;
        });

        if (allCorrect) return verifiedCart;

        console.warn('[FSB] Gift state verification failed on attempt', attempt, '- retrying once.');
        if (attempt >= 2) {
          console.error('[FSB] Gift state still incorrect after retry. Giving up for this cycle.');
          return verifiedCart;
        }
        return fsbReconcileGifts(verifiedCart, giftTiers, giftTitles, attempt + 1);
      })
      .catch(function(err) {
        console.error('[FSB] Gift reconciliation aborted due to mutation failure:', err);
        return cart;
      });
  }

  // Hard-replaces the whole cart section - drawer header, rewards bar,
  // cart items (including quantity selectors), and summary - per
  // explicit request. Scoped to [data-hydration-key="cart-drawer-inner"]
  // rather than the full header section, so it at least doesn't touch
  // the menu/search/logo the way calling Shopify's native hydrate(this
  // sectionId) would. It DOES still touch the same cart-items /
  // quantity-selector markup that caused the 422 / "Quantity input not
  // found" errors earlier in this conversation - that risk hasn't been
  // engineered away here, it's been accepted per your last answer.
  function fsbHydrateCartSection(sectionId) {
    var url = window.location.pathname + '?sections=' + encodeURIComponent(sectionId);

    return fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, cache: 'no-store' })
      .then(function(res) {
        if (!res.ok) {
          throw new Error('[FSB] Section fetch failed for "' + sectionId + '": ' + res.status);
        }
        return res.json();
      })
      .then(function(data) {
        var html = data[sectionId];
        if (!html) {
          throw new Error('[FSB] No HTML returned for section "' + sectionId + '"');
        }

        var parser = new DOMParser();
        var freshDoc = parser.parseFromString(html, 'text/html');
        var freshInner = freshDoc.querySelector('[data-hydration-key="cart-drawer-inner"]');
        var liveInner = document.querySelector('[data-hydration-key="cart-drawer-inner"]');

        if (!freshInner || !liveInner) {
          throw new Error('[FSB] Could not find cart-drawer-inner in ' + (!freshInner ? 'fetched HTML' : 'live DOM'));
        }

        liveInner.innerHTML = freshInner.innerHTML;
      });
  }

  function fsbHydrateDrawer(sectionId) {
    return fsbHydrateCartSection(sectionId).catch(function(err) {
      console.error('[FSB] Cart section hydration failed:', err);
    });
  }

  // Hides the ENTIRE quantity-control block (not individual buttons)
  // on gift rows, so it's robust even if Horizon uses icon-only
  // buttons with no matching text/aria-label. Only remove/delete
  // controls (which typically live outside this block) stay visible.
  function fsbLockGiftRows(giftTitles) {
    if (!giftTitles || !giftTitles.length) return;
    var rows = document.querySelectorAll('.cart-items__table-row');
    rows.forEach(function(row) {
      var rowText = row.textContent || '';
      var isGiftRow = giftTitles.some(function(title) {
        if (!title) return false;
        var stripped = title.replace(/^free\s+/i, '').trim();
        return rowText.indexOf(stripped) !== -1 || rowText.indexOf(title) !== -1;
      });
      if (!isGiftRow) return;

      row.classList.add('rewards-bar__is-gift-row');

      var qtyContainers = row.querySelectorAll(
        'quantity-selector, [class*="quantity"], [data-quantity], [name*="quantity"]'
      );
      qtyContainers.forEach(function(el) {
        var label = (el.getAttribute && (el.getAttribute('aria-label') || '') || '').toLowerCase();
        var isRemove = label.indexOf('remove') !== -1 || label.indexOf('delete') !== -1;
        if (isRemove) return;
        el.style.display = 'none';
        if (typeof el.disabled !== 'undefined') el.disabled = true;
      });

      // Fallback: also individually disable/hide any remaining
      // +/- buttons or numeric inputs not caught by the container match.
      row.querySelectorAll('button, input').forEach(function(el) {
        var label = (el.getAttribute('aria-label') || '').toLowerCase();
        var isRemove = label.indexOf('remove') !== -1 || label.indexOf('delete') !== -1;
        if (isRemove) return;
        var isQtyControl =
          el.tagName === 'INPUT' ||
          label.indexOf('quantity') !== -1 ||
          label.indexOf('increase') !== -1 ||
          label.indexOf('decrease') !== -1 ||
          (el.tagName === 'BUTTON' && /^[+\-−]$/.test((el.textContent || '').trim()));
        if (isQtyControl) {
          el.disabled = true;
          el.style.display = 'none';
        }
      });
    });
  }

    function fsbStartGiftRowGuard(getGiftTitles) {
    var target = document.querySelector('cart-drawer-component') ||
                document.querySelector('.cart-drawer') ||
                document.body;

    var observer = new MutationObserver(function() {
        var titles = getGiftTitles();
        if (titles && titles.length) {
        fsbLockGiftRows(titles);
        }
    });

    observer.observe(target, { childList: true, subtree: true });
  }

  function fsbWaitForDomQuiet(maxFrames) {
    return new Promise(function(resolve) {
      var quietFrames = 0;
      var neededQuietFrames = 2;
      var framesChecked = 0;
      var mutated = false;
      var observer = new MutationObserver(function() { mutated = true; });

      function connectObserver() {
        var target =
          document.querySelector('cart-drawer-component') ||
          document.querySelector('.cart-drawer') ||
          document.body;
        observer.observe(target, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        });
      }
      connectObserver();

      function tick() {
        framesChecked++;
        if (mutated) {
          quietFrames = 0;
          mutated = false;
          observer.disconnect();
          connectObserver();
        } else {
          quietFrames++;
        }

        if (quietFrames >= neededQuietFrames || framesChecked >= maxFrames) {
          observer.disconnect();
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  // FIX for Issues 1 & 2: waits for BOTH a minimum time floor AND
  // DOM-quiet detection, whichever finishes later. This closes the
  // race where Horizon's own native quantity-stepper hydrate (which
  // has its own async network round-trip) was landing AFTER our
  // hydrate and silently overwriting our correct gift add/remove
  // with a stale pre-change snapshot — the actual cause of the
  // "one click late" symptom.
  function fsbWaitForSync(minFloorMs, maxFrames) {
    var domQuiet = fsbWaitForDomQuiet(maxFrames);
    var floor = new Promise(function(resolve) { setTimeout(resolve, minFloorMs); });
    return Promise.all([domQuiet, floor]);
  }

  // Verifies only what FSB is actually responsible for: that gift rows
  // match what's in the cart. Deliberately does NOT compare quantities
  // for regular line items — Horizon's component-quantity-selector
  // appears to encapsulate .quantity__input inside a Shadow DOM, which a
  // light-DOM querySelector can't see. That query was silently returning
  // null and falling back to a hardcoded quantity of 1 every time,
  // producing a permanent false mismatch on every regular item and
  // triggering unnecessary re-hydrates (and re-hydrate churn is exactly
  // what was racing against Horizon's own in-flight quantity update).
  function fsbDomReflectsCart(cart, giftTitles) {
    if (!giftTitles || !giftTitles.length) return true;

    var domRows = document.querySelectorAll('.cart-items__table-row');
    var domGiftTitles = [];

    domRows.forEach(function(row) {
      var titleEl = row.querySelector('.cart-items__title');
      if (!titleEl) return;
      var text = titleEl.textContent.trim();
      var isGiftRow = giftTitles.some(function(t) {
        return t && text.indexOf(t) !== -1;
      });
      if (isGiftRow) domGiftTitles.push(text);
    });

    var cartGiftItems = cart.items.filter(function(item) {
      return item.properties && item.properties['_fsb_tier'];
    });

    var isMatch = domGiftTitles.length === cartGiftItems.length;

    if (!isMatch) {
      console.warn(
        '[FSB] Gift row mismatch — dom gift rows:', domGiftTitles,
        'cart gift items:', cartGiftItems.map(function(i) { return i.product_title; })
      );
    }

    return isMatch;
  }

  function fsbRunCycle() {
    var config = fsbReadConfig();
    if (!config) return Promise.resolve();

    function fetchCart() {
      return fetch('/cart.js', { cache: 'no-store' }).then(function(r) { return r.json(); });
    }

    function hydrateAndVerify(attempt) {
      attempt = attempt || 1;
      return fsbWaitForSync(300, 40)
        .then(function() { return fsbHydrateDrawer(config.sectionId); })
        .then(function() {
          return fetchCart();
        })
        .then(function(finalCart) {
          var domCorrect = fsbDomReflectsCart(finalCart, config.giftTitles);
          if (domCorrect || attempt >= 3) {
            if (!domCorrect) {
              console.error('[FSB] DOM still out of sync with cart after', attempt, 'hydrate attempts.');
            }
            return;
          }
          console.warn('[FSB] DOM out of sync with cart (attempt', attempt, ') — re-hydrating.');
          return hydrateAndVerify(attempt + 1);
        });
    }

    return fetchCart()
      .then(function(cart) {
        return fsbReconcileGifts(cart, config.giftTiers, config.giftTitles);
      })
      .then(function() {
        return hydrateAndVerify();
      })
      .then(function() {
        fsbLockGiftRows(config.giftTitles);
      })
      .catch(function(err) {
        console.error('[FSB] Cycle failed:', err);
      });
  }
    var fsbDebounceTimer = null;
    // 600ms, not 80ms: a full cycle (400ms sync wait + hydrate + verify,
    // up to 3x on retry) takes far longer than 80ms. At 80ms, clicking the
    // stepper at a normal pace queued a separate full cycle per click,
    // each one checking against a cart snapshot that the next click had
    // already invalidated — permanent false "out of sync" churn, and each
    // extra hydrate was another chance to collide with Horizon's own
    // in-flight quantity update. 600ms lets rapid clicks collapse into
    // a single cycle instead.
    function fsbTriggerCycle() {
    clearTimeout(fsbDebounceTimer);
    fsbDebounceTimer = setTimeout(function() {
        fsbEnqueue(fsbRunCycle);
    }, 500);
    }

    fsbTriggerCycle();

    // Standing guard: re-applies gift row locking any time the drawer DOM
    // changes for ANY reason (our hydrate, Horizon's own native update,
    // or anything else) — self-healing instead of relying on a single
    // well-timed call after our own cycle.
    fsbStartGiftRowGuard(function() {
    var config = fsbReadConfig();
    return config ? config.giftTitles : null;
    });
})();