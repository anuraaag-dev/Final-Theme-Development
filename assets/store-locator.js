/**
 * Store Locator
 * Vanilla JS controller for sections/store-locator.liquid
 *
 * Map stack: Leaflet.js + OpenStreetMap tiles. No API key, no signup.
 * Geocoding: OpenStreetMap's Nominatim search endpoint. Also no API key.
 *
 * Responsible-use note: Nominatim is a shared community service, not a
 * dedicated commercial endpoint. Its usage policy asks for reasonable,
 * human-triggered request volume (this file only geocodes on user input,
 * debounced, never on a timer) and requires attribution, which the map's
 * tile layer already displays. If a store gets meaningful search volume,
 * consider self-hosting Nominatim or switching to a commercial geocoder —
 * only geocodeQuery() below would need to change.
 *
 * No external dependencies beyond the Leaflet library itself, which this
 * file loads lazily from a CDN. No globals are created — Leaflet attaches
 * itself to window.L, which is Leaflet's own contract, not ours.
 */
(function () {
  'use strict';

  /**
   * Set to true while diagnosing store/marker mapping issues. Prints exactly
   * which store ID/coordinates are resolved for every hover and directions
   * request, straight from the DOM attribute through to the routing call —
   * so a mismatch (if one exists) is visible immediately in the console
   * instead of inferred from on-screen behavior. Flip to false once confirmed
   * working; it's deliberately loud, not meant to ship on permanently.
   */
  var DEBUG_STORE_LOCATOR = false;

  var DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var SEARCH_RADIUS_KM = 160;
  var LEAFLET_VERSION = '1.9.4';
  var ROUTING_MACHINE_VERSION = '3.2.12';
  var leafletPromise = null;
  var routingMachinePromise = null;

  // Registry of every live StoreLocatorInstance, keyed by root element.
  // Lets initAll() detect and fully tear down a stale instance before
  // creating a new one on the same (or a replaced) root — this is what
  // prevents duplicate maps/markers/listeners after a Shopify Theme Editor
  // section reload, per the earlier destroy() note.
  var activeInstances = [];

  /* ----------------------------- Utilities ------------------------------ */

  function loadLeaflet() {
    if (leafletPromise) return leafletPromise;

    leafletPromise = new Promise(function (resolve, reject) {
      if (window.L && window.L.map) {
        resolve(window.L);
        return;
      }

      if (!document.querySelector('link[data-store-locator-leaflet-css]')) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/' + LEAFLET_VERSION + '/leaflet.min.css';
        link.setAttribute('data-store-locator-leaflet-css', '');
        document.head.appendChild(link);
      }

      var script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/' + LEAFLET_VERSION + '/leaflet.min.js';
      script.async = true;
      script.onload = function () {
        if (window.L && window.L.map) {
          resolve(window.L);
        } else {
          reject(new Error('leaflet-load-incomplete'));
        }
      };
      script.onerror = function () {
        leafletPromise = null;
        reject(new Error('leaflet-script-failed'));
      };
      document.head.appendChild(script);
    });

    return leafletPromise;
  }

  /**
   * Loads Leaflet Routing Machine, which draws an actual road-following
   * route inside the map (rather than opening a separate maps app).
   * Loaded lazily — only the first time a customer actually asks for
   * directions — since most page views never need it.
   *
   * Responsible-use note: this uses OSRM's public demo routing server
   * (router.project-osrm.org), which is explicitly a demo/evaluation
   * endpoint, not a production SLA. It's free and keyless, same spirit
   * as the Nominatim search above, but with an even more explicit
   * "don't rely on this for production traffic" stance from the OSRM
   * project itself. For meaningful order volume, swap the `serviceUrl`
   * in drawRoute() below for a self-hosted OSRM instance or a commercial
   * directions API.
   */
  function loadRoutingMachine() {
    if (routingMachinePromise) return routingMachinePromise;

    routingMachinePromise = new Promise(function (resolve, reject) {
      if (window.L && window.L.Routing) {
        resolve(window.L);
        return;
      }

      if (!document.querySelector('link[data-store-locator-lrm-css]')) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://cdn.jsdelivr.net/npm/leaflet-routing-machine@' + ROUTING_MACHINE_VERSION + '/dist/leaflet-routing-machine.css';
        link.setAttribute('data-store-locator-lrm-css', '');
        document.head.appendChild(link);
      }

      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/leaflet-routing-machine@' + ROUTING_MACHINE_VERSION + '/dist/leaflet-routing-machine.min.js';
      script.async = true;
      script.onload = function () {
        if (window.L && window.L.Routing) {
          resolve(window.L);
        } else {
          reject(new Error('routing-machine-load-incomplete'));
        }
      };
      script.onerror = function () {
        routingMachinePromise = null;
        reject(new Error('routing-machine-script-failed'));
      };
      document.head.appendChild(script);
    });

    return routingMachinePromise;
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(ctx, args);
      }, wait);
    };
  }

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function formatDistance(km) {
    if (km < 1) {
      var meters = Math.round((km * 1000) / 10) * 10;
      return meters + ' m';
    }
    return km.toFixed(1) + ' km';
  }

  function parseTimeToMinutes(str) {
    if (!str || typeof str !== 'string' || str.indexOf(':') === -1) return null;
    var parts = str.split(':');
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }

  function formatClock(minutes) {
    var h = Math.floor(minutes / 60) % 24;
    var m = minutes % 60;
    var period = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    var mm = m < 10 ? '0' + m : String(m);
    return h12 + ':' + mm + ' ' + period;
  }

  function findNextOpen(hours, fromDayIndex) {
    for (var i = 1; i <= 7; i++) {
      var idx = (fromDayIndex + i) % 7;
      var day = hours[DAY_NAMES[idx]];
      if (day && day.closed === false) {
        var openMin = parseTimeToMinutes(day.open);
        if (openMin !== null) {
          var prefix = i === 1 ? '' : (DAY_NAMES[idx].charAt(0).toUpperCase() + DAY_NAMES[idx].slice(1) + ' ');
          return prefix + formatClock(openMin);
        }
      }
    }
    return null;
  }

  /**
   * Computes live open/closed status for a store.
   * `hours` follows this JSON shape (see Metaobject setup notes):
   * { "monday": { "open": "09:00", "close": "18:00", "closed": false }, ... }
   * `timezone` should be an IANA zone name (e.g. "America/Chicago").
   * Falls back to the visitor's browser timezone if none is provided,
   * which is a documented limitation for multi-timezone store lists.
   */
  function getStoreStatus(hours, timezone, now) {
    now = now || new Date();

    if (!hours || typeof hours !== 'object') {
      return { known: false, isOpen: false, label: 'Hours unavailable' };
    }

    var zone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    var dayIndex;
    var minutesNow;

    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
      }).formatToParts(now);

      var weekdayShort = '';
      var hourStr = '';
      var minuteStr = '';

      parts.forEach(function (p) {
        if (p.type === 'weekday') weekdayShort = p.value;
        if (p.type === 'hour') hourStr = p.value;
        if (p.type === 'minute') minuteStr = p.value;
      });

      var shortMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      dayIndex = shortMap[weekdayShort];
      var hourNum = parseInt(hourStr, 10);
      if (hourNum === 24) hourNum = 0;
      minutesNow = hourNum * 60 + parseInt(minuteStr, 10);
    } catch (err) {
      dayIndex = now.getDay();
      minutesNow = now.getHours() * 60 + now.getMinutes();
    }

    if (dayIndex === undefined || isNaN(minutesNow)) {
      return { known: false, isOpen: false, label: 'Hours unavailable' };
    }

    var todayKey = DAY_NAMES[dayIndex];
    var yesterdayKey = DAY_NAMES[(dayIndex + 6) % 7];
    var today = hours[todayKey];
    var yesterday = hours[yesterdayKey];

    if (yesterday && yesterday.closed === false) {
      var yOpen = parseTimeToMinutes(yesterday.open);
      var yClose = parseTimeToMinutes(yesterday.close);
      if (yOpen !== null && yClose !== null && yClose <= yOpen && minutesNow < yClose) {
        return { known: true, isOpen: true, label: 'Open · Closes ' + formatClock(yClose) };
      }
    }

    if (!today || today.closed === true) {
      var nextOpenLabel = findNextOpen(hours, dayIndex);
      return {
        known: true,
        isOpen: false,
        label: nextOpenLabel ? ('Closed · Opens ' + nextOpenLabel) : 'Closed today'
      };
    }

    var openMin = parseTimeToMinutes(today.open);
    var closeMin = parseTimeToMinutes(today.close);
    if (openMin === null || closeMin === null) {
      return { known: false, isOpen: false, label: 'Hours unavailable' };
    }

    var overnight = closeMin <= openMin;
    var isOpenNow = overnight
      ? (minutesNow >= openMin || minutesNow < closeMin)
      : (minutesNow >= openMin && minutesNow < closeMin);

    if (isOpenNow) {
      return { known: true, isOpen: true, label: 'Open · Closes ' + formatClock(closeMin) };
    }
    if (minutesNow < openMin) {
      return { known: true, isOpen: false, label: 'Closed · Opens ' + formatClock(openMin) };
    }
    var nextLabel = findNextOpen(hours, dayIndex);
    return { known: true, isOpen: false, label: nextLabel ? ('Closed · Opens ' + nextLabel) : 'Closed' };
  }

  function buildDirectionsUrl(lat, lng, fallbackAddress) {
    if (isFinite(lat) && isFinite(lng)) {
      return 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng;
    }
    if (fallbackAddress) {
      return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(fallbackAddress);
    }
    return 'https://www.google.com/maps';
  }

  function markerIconHtml() {
    return '<div class="store-locator__marker-icon" data-marker-icon>' +
      '<span class="store-locator__marker-pulse" data-marker-pulse hidden></span>' +
      '<svg class="store-locator__marker-pin" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 25 15 25s15-14.5 15-25C30 6.7 23.3 0 15 0z"/>' +
      '<circle cx="15" cy="15" r="6" fill="#ffffff"/>' +
      '</svg></div>';
  }

  /* --------------------------- Store Locator ----------------------------- */

  function StoreLocatorInstance(root) {
    this.root = root;
    this.defaultLat = parseFloat(root.getAttribute('data-default-lat'));
    this.defaultLng = parseFloat(root.getAttribute('data-default-lng'));
    this.defaultZoom = parseInt(root.getAttribute('data-default-zoom'), 10) || 11;

    this.listEl = root.querySelector('[data-store-list]');
    this.itemEls = Array.prototype.slice.call(root.querySelectorAll('[data-store-item]'));
    this.searchForm = root.querySelector('[data-search-form]');
    this.searchInput = root.querySelector('[data-search-input]');
    this.locateBtn = root.querySelector('[data-locate-btn]');
    this.typeFiltersEl = root.querySelector('[data-type-filters]');
    this.radiusFilterEl = root.querySelector('[data-radius-filter]');
    this.resultCountEl = root.querySelector('[data-result-count]');
    this.announcerEl = root.querySelector('[data-status-announcer]');
    this.emptyStateEl = root.querySelector('[data-empty-state]');
    this.emptyMessageEl = root.querySelector('[data-empty-message]');
    this.clearBtn = root.querySelector('[data-clear-search]');
    this.mapEl = root.querySelector('[data-map]');
    this.mapLoadingEl = root.querySelector('[data-map-loading]');
    this.mapFallbackEl = root.querySelector('[data-map-fallback]');
    this.resultsPanel = root.querySelector('[data-results-panel]');
    this.routeSummaryEl = root.querySelector('[data-route-summary]');
    this.routeSummaryTextEl = root.querySelector('[data-route-summary-text]');
    this.routeClearBtn = root.querySelector('[data-route-clear]');
    this.fullscreenBtn = root.querySelector('[data-fullscreen-btn]');
    this.mapTypeBtn = root.querySelector('[data-map-type-btn]');
    this.mapWrapEl = root.querySelector('[data-map-wrap]');

    this.prefersReducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    this.stores = [];
    this.map = null;
    this.L = null;
    this.streetLayer = null;
    this.satelliteLayer = null;
    this.markers = {};
    this.popup = null;
    this.routingControl = null;
    this.routeDestinationId = null;
    this.hoveredStoreId = null;
    this.userMarker = null;
    this.userLocation = null;
    this.searchLocation = null;
    this.lastLocationSource = null;
    this.activeTypeFilter = 'all';
    this.activeRadiusKm = null;
    this.radiusCircle = null;
    this.selectedStoreId = null;
    this.searchToken = 0;
    this.routeRequestToken = 0;
    this.currentQuery = '';
    this._statusInterval = null;
    this._boundHandlers = [];

    this.parseStoresFromDom();
    this.bindEvents();
    this.renderAllStatuses();
    this.applyFilters();
    this.initMap();

    var self = this;
    this._statusInterval = setInterval(function () {
      self.renderAllStatuses();
    }, 60000);
  }

  /**
   * IDENTITY RESOLUTION — this is the fix for "wrong marker responds to
   * hover" and "directions goes to the wrong store".
   *
   * `store.id` (a Shopify metaobject GID, rendered as data-store-id) is
   * *supposed* to be unique, and normally is. But this class previously
   * only warned when it wasn't — it kept using the raw (possibly blank or
   * duplicated) id as the key for both `this.markers` and `getStoreById()`
   * lookups. If two cards ever rendered with the same id (or a blank one),
   * every later card with that id would silently overwrite the earlier
   * marker in `this.markers`, and `getStoreById()` would always return the
   * FIRST store object with that id — so every hover/click on any of those
   * cards would resolve to one shared store (one marker, one set of
   * coordinates), exactly matching "always the same marker responds" and
   * "always the same directions destination".
   *
   * The fix: every card also renders a `data-marker-key`, which is the
   * store's fixed position in the server-rendered list (assigned once at
   * render time — never recomputed on filter/sort, so it stays stable).
   * We use `store.id` as the identity key only when it's present AND
   * unique across the current render; otherwise we fall back to the
   * guaranteed-unique marker-key. This keeps `store.id` as the canonical
   * identity (per the requirement to prefer it when trustworthy) while
   * making collisions structurally impossible.
   */
  StoreLocatorInstance.prototype.parseStoresFromDom = function () {
    var self = this;

    // First pass: count how many cards claim each raw data-store-id, so we
    // can tell a genuinely-unique id from a colliding one before assigning
    // any final keys.
    var idCounts = {};
    this.itemEls.forEach(function (item) {
      var card = item.querySelector('[data-store-card]');
      var rawId = card.getAttribute('data-store-id');
      if (rawId) idCounts[rawId] = (idCounts[rawId] || 0) + 1;
    });

    var usedKeys = {};

    this.stores = this.itemEls.map(function (item) {
      var card = item.querySelector('[data-store-card]');
      var statusEl = card.querySelector('[data-card-status]');
      var hoursRaw = statusEl ? statusEl.getAttribute('data-hours') : null;
      var hours = null;
      try {
        hours = hoursRaw ? JSON.parse(hoursRaw) : null;
      } catch (err) {
        hours = null;
      }

      var name = card.getAttribute('data-name') || '(unnamed store)';
      var rawId = card.getAttribute('data-store-id');
      var markerKey = card.getAttribute('data-marker-key');

      // Decide the final identity key for this card.
      var key;
      if (rawId && idCounts[rawId] === 1) {
        key = rawId;
      } else {
        // Blank or colliding id — fall back to the guaranteed-unique,
        // render-time-stable marker key instead of silently sharing an
        // identity with another card.
        key = 'mk:' + (markerKey !== null ? markerKey : Math.random().toString(36).slice(2));
        if (window.console) {
          if (!rawId) {
            console.warn('[Store Locator] Missing store identifier for "' + name + '" — using a positional fallback key so this card still gets its own marker.');
          } else {
            console.warn('[Store Locator] Duplicate store identifier detected: "' + rawId + '" is used by more than one card (including "' + name + '"). Using a positional fallback key for these cards so each still gets its own marker. Fix the underlying metaobject data when possible.');
          }
        }
      }

      if (usedKeys[key] && window.console) {
        console.warn('[Store Locator] Fallback key collision for "' + name + '" (' + key + ') — this should not happen; please report.');
        key = key + ':' + Object.keys(usedKeys).length;
      }
      usedKeys[key] = true;

      var rawLat = card.getAttribute('data-lat');
      var rawLng = card.getAttribute('data-lng');
      var lat = parseFloat(rawLat);
      var lng = parseFloat(rawLng);
      var hasValidCoords = isFinite(lat) && isFinite(lng) &&
        Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
        !(lat === 0 && lng === 0); // (0,0) almost always means an empty/zero-defaulted field, not a real store

      if (!hasValidCoords && window.console) {
        console.warn(
          '[Store Locator] "' + name + '" has missing or invalid coordinates ' +
          '(latitude="' + rawLat + '", longitude="' + rawLng + '") and will not appear on the map, ' +
          'and Get Directions won\'t work for it. Check its Latitude/Longitude fields — they must be ' +
          'plain decimal numbers like 26.8467, not 26,8467 or blank.'
        );
      }

      return {
        id: key,
        shopifyId: rawId,
        itemEl: item,
        cardEl: card,
        triggerEl: card.querySelector('[data-card-trigger]'),
        distanceEl: card.querySelector('[data-card-distance]'),
        statusTextEl: card.querySelector('[data-status-text]'),
        directionsEl: card.querySelector('[data-directions-link]'),
        name: name,
        city: card.getAttribute('data-city') || '',
        state: card.getAttribute('data-state') || '',
        postalCode: card.getAttribute('data-postal') || '',
        address: card.getAttribute('data-address') || '',
        type: (card.getAttribute('data-type') || '').toLowerCase(),
        timezone: card.getAttribute('data-timezone') || '',
        lat: hasValidCoords ? lat : null,
        lng: hasValidCoords ? lng : null,
        hours: hours,
        distanceKm: null
      };
    });

    // The resolved key is what hover/click/directions actually key off of,
    // so write it back onto the DOM node as the canonical data-store-id.
    // This keeps every downstream lookup (querySelector, closest(),
    // getAttribute) automatically correct without special-casing the
    // fallback path anywhere else in the file.
    this.stores.forEach(function (s) {
      s.cardEl.setAttribute('data-store-id', s.id);
    });

    if (DEBUG_STORE_LOCATOR && window.console) {
      console.log('[Store Locator] Parsed ' + this.stores.length + ' store(s):',
        this.stores.map(function (s) { return { key: s.id, shopifyId: s.shopifyId, name: s.name, lat: s.lat, lng: s.lng }; }));
    }
  };

  StoreLocatorInstance.prototype.bindEvents = function () {
    var self = this;

    if (this.searchForm) {
      this.searchForm.addEventListener('submit', function (e) {
        e.preventDefault();
        self.handleSearchChange(true);
      });
    }

    if (this.searchInput) {
      var debounced = debounce(function () {
        self.handleSearchChange(false);
      }, 400);
      this.searchInput.addEventListener('input', debounced);
    }

    if (this.locateBtn) {
      this.locateBtn.addEventListener('click', function () {
        self.locateUser();
      });
    }

    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', function () {
        self.clearSearch();
      });
    }

    if (this.typeFiltersEl) {
      this.typeFiltersEl.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-type-filter]');
        if (!btn) return;
        self.setTypeFilter(btn.getAttribute('data-type-filter'));
      });
    }
    if (this.radiusFilterEl) {
      this.radiusFilterEl.addEventListener('change', function () {
        var raw = self.radiusFilterEl.value;
        var km = raw ? parseFloat(raw) : null;
        self.setRadiusFilter(isFinite(km) ? km : null);
      });
    }

    if (this.listEl) {
      this.listEl.addEventListener('click', function (e) {
        var showRouteBtn = e.target.closest('[data-show-route]');
        if (showRouteBtn) {
          var routeCard = showRouteBtn.closest('[data-store-card]');
          if (routeCard) {
            var routeStoreId = routeCard.getAttribute('data-store-id');
            var routeStore = self.getStoreById(routeStoreId);
            if (routeStore) {
              self.requestDirectionsTo(routeStore);
            } else if (window.console) {
              console.warn('[Store Locator] Get Directions: no store data found for id', routeStoreId);
            }
          }
          return;
        }
        var trigger = e.target.closest('[data-card-trigger]');
        if (!trigger) return;
        var card = trigger.closest('[data-store-card]');
        if (!card) return;
        self.selectStore(card.getAttribute('data-store-id'), { fromMarker: false });
      });

      // Hovering a card gives its map marker a brief hop then a smooth,
      // continuous glow that runs for as long as the mouse stays there —
      // no pan/zoom/popup/selection change, so browsing the list never
      // yanks the map around or steals the current selection.
      // pointerover/pointerout (not mouseover/mouseout) unify mouse, touch,
      // and pen under one event model and avoid synthetic-event quirks.
      // Each event is re-resolved against e.target.closest() on every
      // firing, so a card can never end up borrowing another card's id.
      this.listEl.addEventListener('pointerover', function (e) {
        var card = e.target.closest('[data-store-card]');
        if (!card) return;
        var id = card.getAttribute('data-store-id');
        if (id === self.hoveredStoreId) return;
        if (self.hoveredStoreId) self.setMarkerHovering(self.hoveredStoreId, false);
        self.hoveredStoreId = id;
        self.setMarkerHovering(id, true);
        if (DEBUG_STORE_LOCATOR && window.console) {
          console.log('[Store Locator] Hover -> id:', id, 'name:', card.getAttribute('data-name'));
        }
      });

      this.listEl.addEventListener('pointerout', function (e) {
        var card = e.target.closest('[data-store-card]');
        if (!card) return;
        var related = e.relatedTarget;
        if (related && card.contains(related)) return;
        var id = card.getAttribute('data-store-id');
        if (id === self.hoveredStoreId) {
          self.setMarkerHovering(id, false);
          self.hoveredStoreId = null;
        }
      });
    }

    if (this.routeClearBtn) {
      this.routeClearBtn.addEventListener('click', function () {
        self.clearRoute();
      });
    }

    if (this.fullscreenBtn) {
      this.fullscreenBtn.addEventListener('click', function () {
        self.toggleFullscreen();
      });
    }

    if (this.mapTypeBtn) {
      this.mapTypeBtn.addEventListener('click', function () {
        self.toggleMapType();
      });
    }

    this._onFullscreenChange = function () { self.onFullscreenChange(); };
    document.addEventListener('fullscreenchange', this._onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this._onFullscreenChange);

    this._onResize = debounce(function () {
      if (self.map) self.map.invalidateSize();
    }, 200);
    window.addEventListener('resize', this._onResize);
  };

  StoreLocatorInstance.prototype.setTypeFilter = function (type) {
    this.activeTypeFilter = type;
    if (this.typeFiltersEl) {
      Array.prototype.forEach.call(this.typeFiltersEl.querySelectorAll('[data-type-filter]'), function (btn) {
        var active = btn.getAttribute('data-type-filter') === type;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
    this.applyFilters();
  };

  StoreLocatorInstance.prototype.handleSearchChange = function (isSubmit) {
    var query = (this.searchInput && this.searchInput.value || '').trim();
    var queryChanged = query !== this.currentQuery;
    this.currentQuery = query;

    // A changed query invalidates any previously geocoded location so we
    // never sort/filter against a location that no longer matches the text box.
    if (queryChanged) {
      this.searchLocation = null;
    }

    if (!query) {
      this.searchLocation = null;
      this.applyFilters();
      return;
    }

    this.applyFilters();

    var visibleCount = this.stores.filter(function (s) { return !s.itemEl.hidden; }).length;

    if (visibleCount === 0 || isSubmit) {
      this.geocodeQuery(query);
    }
  };

  StoreLocatorInstance.prototype.geocodeQuery = function (query) {
    var self = this;
    if (!this.map || typeof fetch !== 'function') return;

    this.searchToken += 1;
    var token = this.searchToken;
    this.setSearchLoading(true);

    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query);

    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('nominatim-http-' + res.status);
        return res.json();
      })
      .then(function (results) {
        if (token !== self.searchToken) return;
        self.setSearchLoading(false);
        if (results && results.length) {
          var lat = parseFloat(results[0].lat);
          var lon = parseFloat(results[0].lon);
          if (isFinite(lat) && isFinite(lon)) {
            self.searchLocation = { lat: lat, lng: lon };
            self.lastLocationSource = 'search';
            self.applyFilters();
            self.centerMapOnSearchLocation();
            self.announce('Showing stores near ' + query + '.');
          }
        }
      })
      .catch(function () {
        if (token !== self.searchToken) return;
        self.setSearchLoading(false);
      });
  };

  StoreLocatorInstance.prototype.setSearchLoading = function (isLoading) {
    if (this.searchForm) {
      this.searchForm.classList.toggle('is-loading', isLoading);
    }
  };

  StoreLocatorInstance.prototype.centerMapOnSearchLocation = function () {
    if (!this.map || !this.searchLocation) return;
    var targetZoom = Math.max(this.map.getZoom(), 11);
    if (this.prefersReducedMotion) {
      this.map.setView([this.searchLocation.lat, this.searchLocation.lng], targetZoom);
    } else {
      this.map.flyTo([this.searchLocation.lat, this.searchLocation.lng], targetZoom, { duration: 0.6 });
    }
  };

  StoreLocatorInstance.prototype.clearSearch = function () {
    if (this.searchInput) this.searchInput.value = '';
    this.currentQuery = '';
    this.searchLocation = null;
    this.activeRadiusKm = null;
    if (this.radiusFilterEl) this.radiusFilterEl.value = '';
    this.clearRoute();
    this.setTypeFilter('all');
  };
  /**
   * A radius filter is only meaningful relative to a known origin (either a
   * searched location or the customer's own position). If neither is known
   * yet when a distance is picked, this asks for geolocation on the spot —
   * same pattern as requestDirectionsTo() — rather than silently doing
   * nothing or showing an empty list with no explanation.
   */
  StoreLocatorInstance.prototype.setRadiusFilter = function (km) {
    var self = this;
    this.activeRadiusKm = km;

    if (km && !this.getCurrentOrigin()) {
      if (!('geolocation' in navigator)) {
        this.announce('Search a city or postcode, or allow location access, to filter by distance.');
        this.applyFilters();
        return;
      }
      this.announce('Getting your location to filter by distance…');
      navigator.geolocation.getCurrentPosition(
        function (position) {
          self.userLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
          };
          self.lastLocationSource = 'user';
          self.showUserMarker();
          self.applyFilters();
        },
        function () {
          self.announce('We could not access your location. Try searching a city or postcode, then choose a distance again.');
          self.applyFilters();
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
      );
      return;
    }

    this.applyFilters();
  };

  /**
   * Single source of truth for "where is the customer, right now" — used by
   * both list-distance sorting and Get Directions, so they can never disagree.
   * Whichever the customer did more recently (search a place, or share their
   * live location) wins; falls back to whichever is set if neither is "most
   * recent" (e.g. right after a page reload where nothing has been cleared).
   */
  StoreLocatorInstance.prototype.getCurrentOrigin = function () {
    if (this.lastLocationSource === 'search' && this.searchLocation) return this.searchLocation;
    if (this.lastLocationSource === 'user' && this.userLocation) return this.userLocation;
    return this.searchLocation || this.userLocation || null;
  };

  StoreLocatorInstance.prototype.applyFilters = function () {
    var self = this;
    var query = (this.currentQuery || '').toLowerCase().trim();

    var typeFiltered = this.stores.filter(function (s) {
      return self.activeTypeFilter === 'all' || s.type === self.activeTypeFilter;
    });

    var textMatched = null;
    if (query) {
      textMatched = typeFiltered.filter(function (s) {
        var haystack = (s.name + ' ' + s.city + ' ' + s.state + ' ' + s.postalCode + ' ' + s.address).toLowerCase();
        return haystack.indexOf(query) !== -1;
      });
    }

    var visible;

    if (textMatched && textMatched.length) {
      visible = textMatched;
    } else if (query && this.searchLocation) {
      visible = typeFiltered
        .filter(function (s) { return s.lat !== null && s.lng !== null; })
        .map(function (s) {
          s.distanceKm = haversineKm(self.searchLocation.lat, self.searchLocation.lng, s.lat, s.lng);
          return s;
        })
        .filter(function (s) { return s.distanceKm <= SEARCH_RADIUS_KM; });
    } else if (query && !this.searchLocation) {
      visible = [];
    } else {
      visible = typeFiltered;
    }

    var origin = this.getCurrentOrigin();

    if (origin) {
      visible.forEach(function (s) {
        s.distanceKm = (s.lat !== null && s.lng !== null)
          ? haversineKm(origin.lat, origin.lng, s.lat, s.lng)
          : null;
      });
      if (this.activeRadiusKm) {
        visible = visible.filter(function (s) {
          return s.distanceKm !== null && s.distanceKm !== undefined && s.distanceKm <= self.activeRadiusKm;
        });
      }
      visible = visible.slice().sort(function (a, b) {
        if (a.distanceKm === null || a.distanceKm === undefined) return 1;
        if (b.distanceKm === null || b.distanceKm === undefined) return -1;
        return a.distanceKm - b.distanceKm;
      });
    } else {
      visible = visible.slice().sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });
    }

    // Must run before renderVisible(): fitMapToVisible() (called from within
    // it) checks this.radiusCircle to decide whether to frame the search
    // radius instead of just the visible markers.
    this.updateRadiusCircle();

    this.renderVisible(visible);
  };

  StoreLocatorInstance.prototype.renderVisible = function (visible) {
    var visibleIds = {};

    visible.forEach(function (s, index) {
      visibleIds[s.id] = true;
      s.itemEl.hidden = false;
      s.itemEl.style.order = String(index);
      if (typeof s.distanceKm === 'number') {
        s.distanceEl.hidden = false;
        s.distanceEl.textContent = formatDistance(s.distanceKm);
      } else if (s.distanceEl) {
        s.distanceEl.hidden = true;
        s.distanceEl.textContent = '';
      }
    });

    this.stores.forEach(function (s) {
      if (!visibleIds[s.id]) {
        s.itemEl.hidden = true;
      }
    });

    if (this.routeDestinationId && !visibleIds[this.routeDestinationId]) {
      this.clearRoute();
    }

    this.updateMarkerVisibility(visibleIds);
    // Leaflet rebuilds a marker's DOM when it's re-added after being removed
    // (see updateMarkerVisibility), which would otherwise silently drop the
    // "selected" look from a marker that gets filtered out and back in.
    this.updateSelectedMarkerIcons();
    this.updateResultCount(visible.length);
    this.updateEmptyState(visible.length);
    this.fitMapToVisible(visible);
  };

  StoreLocatorInstance.prototype.updateResultCount = function (count) {
    if (!this.resultCountEl) return;
    if (count === 0) {
      this.resultCountEl.textContent = '';
      return;
    }
    this.resultCountEl.textContent = count + (count === 1 ? ' store found' : ' stores found');
  };

  StoreLocatorInstance.prototype.updateEmptyState = function (visibleCount) {
    if (!this.emptyStateEl) return;
    if (visibleCount > 0) {
      this.emptyStateEl.hidden = true;
      return;
    }
    this.emptyStateEl.hidden = false;

    var filtersActive = this.activeTypeFilter !== 'all';
    var searchActive = !!this.currentQuery;
    var radiusActive = !!this.activeRadiusKm;
    var activeCount = (filtersActive ? 1 : 0) + (searchActive ? 1 : 0) + (radiusActive ? 1 : 0);

    var message = 'No stores found near this location.';
    var buttonLabel = 'Clear Search';

    if (activeCount > 1) {
      message = 'No stores match your current search and filters.';
      buttonLabel = 'Clear All';
    } else if (radiusActive) {
      message = 'No stores within ' + this.activeRadiusKm + ' km. Try a wider distance.';
      buttonLabel = 'Clear Distance Filter';
    } else if (filtersActive) {
      message = 'Try changing your filters.';
      buttonLabel = 'Clear Filters';
    }

    if (this.emptyMessageEl) this.emptyMessageEl.textContent = message;
    if (this.clearBtn) this.clearBtn.textContent = buttonLabel;
  };

  StoreLocatorInstance.prototype.announce = function (message) {
    if (this.announcerEl) this.announcerEl.textContent = message;
  };

  StoreLocatorInstance.prototype.renderAllStatuses = function () {
    var self = this;
    this.stores.forEach(function (s) {
      self.renderStatus(s);
    });
  };

  StoreLocatorInstance.prototype.renderStatus = function (store) {
    var status = getStoreStatus(store.hours, store.timezone);
    if (store.statusTextEl) store.statusTextEl.textContent = status.label;
    if (store.cardEl) {
      store.cardEl.classList.toggle('is-open', !!status.isOpen);
      store.cardEl.classList.toggle('is-closed', status.known && !status.isOpen);
    }
  };

  StoreLocatorInstance.prototype.locateUser = function () {
    var self = this;
    if (!('geolocation' in navigator)) {
      this.announce('Location services are not supported by your browser.');
      return;
    }

    this.locateBtn.classList.add('is-loading');
    this.locateBtn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      function (position) {
        self.locateBtn.classList.remove('is-loading');
        self.locateBtn.disabled = false;
        self.userLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        self.lastLocationSource = 'user';
        self.searchLocation = null;
        if (self.searchInput) self.searchInput.value = '';
        self.currentQuery = '';
        self.applyFilters();
        self.showUserMarker();
        self.announce('Your location has been detected. Showing nearest stores first.');
      },
      function (error) {
        self.locateBtn.classList.remove('is-loading');
        self.locateBtn.disabled = false;
        var message = 'We could not access your location.';
        if (error) {
          if (error.code === error.PERMISSION_DENIED) {
            message = 'Location access was denied. You can search by city or postcode instead.';
          } else if (error.code === error.TIMEOUT) {
            message = 'Locating you took too long. Please try again.';
          } else if (error.code === error.POSITION_UNAVAILABLE) {
            message = 'Your location is currently unavailable.';
          }
        }
        self.announce(message);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  };

  StoreLocatorInstance.prototype.showUserMarker = function () {
    if (!this.map || !this.L) return;
    var L = this.L;
    if (this.userMarker) {
      this.userMarker.setLatLng([this.userLocation.lat, this.userLocation.lng]);
      if (!this.map.hasLayer(this.userMarker)) this.userMarker.addTo(this.map);
      return;
    }
    this.userMarker = L.marker([this.userLocation.lat, this.userLocation.lng], {
      icon: L.divIcon({
        className: 'store-locator__user-marker-wrap',
        html: '<span class="store-locator__user-marker-dot"></span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      }),
      zIndexOffset: -1000,
      interactive: false,
      keyboard: false
    }).addTo(this.map);
  };

  /* ------------------------------- Map ----------------------------------- */

  StoreLocatorInstance.prototype.initMap = function () {
    var self = this;
    if (!this.mapEl) return;
    loadLeaflet().then(function (L) {
      self.L = L;
      self.createMap(L);
    }).catch(function () {
      self.showMapFallback();
    });
  };

  StoreLocatorInstance.prototype.showMapFallback = function () {
    if (this.mapLoadingEl) this.mapLoadingEl.hidden = true;
    if (this.mapFallbackEl) this.mapFallbackEl.hidden = false;
    if (this.mapEl) this.mapEl.hidden = true;
  };

  StoreLocatorInstance.prototype.computeInitialCenter = function () {
    if (isFinite(this.defaultLat) && isFinite(this.defaultLng)) {
      return { lat: this.defaultLat, lng: this.defaultLng };
    }
    var withCoords = this.stores.filter(function (s) { return s.lat !== null && s.lng !== null; });
    if (withCoords.length) {
      return { lat: withCoords[0].lat, lng: withCoords[0].lng };
    }
    return { lat: 20, lng: 0 };
  };

  StoreLocatorInstance.prototype.createMap = function (L) {
    var self = this;
    var center = this.computeInitialCenter();

    try {
      this.map = L.map(this.mapEl, {
        center: [center.lat, center.lng],
        zoom: this.defaultZoom,
        scrollWheelZoom: false,
        zoomControl: true
      });
    } catch (err) {
      // Leaflet throws if this exact element was already turned into a map
      // by another instance. Fail safely rather than crash the whole page.
      if (window.console) console.warn('[Store Locator] Map failed to initialize on this element:', err);
      this.showMapFallback();
      return;
    }

    this.streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
    });

    // Esri's public World Imagery service — free, keyless satellite tiles.
    // Same responsible-use spirit as Nominatim/OSRM above: fine for normal
    // storefront traffic, not a guaranteed-unlimited commercial SLA.
    this.satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    });

    this.streetLayer.addTo(this.map);

    // Click-to-enable scroll zoom keeps the page scrollable by default —
    // a map that hijacks the mouse wheel on page load is a common annoyance.
    this._onMapClick = function () { self.map.scrollWheelZoom.enable(); };
    this._onMapLeave = function () { self.map.scrollWheelZoom.disable(); };
    this.mapEl.addEventListener('click', this._onMapClick);
    this.mapEl.addEventListener('mouseleave', this._onMapLeave);
    this.popup = L.popup({
      closeButton: true,
      closeOnClick: false,
      autoClose: true,
      className: 'store-locator__popup-wrap'
    });
    this.popup.on('remove', function () {
      self.deselectStore();
    });

    this.createMarkers(L);
    this.applyFilters();

    if (this.mapLoadingEl) this.mapLoadingEl.hidden = true;

    // Defensive re-measure: theme fonts/webfont swaps can shift layout
    // after Leaflet has already measured its container once.
    setTimeout(function () {
      if (self.map) self.map.invalidateSize();
    }, 300);
  };

  StoreLocatorInstance.prototype.toggleMapType = function () {
    if (!this.map || !this.streetLayer || !this.satelliteLayer) return;
    var showingSatellite = this.map.hasLayer(this.satelliteLayer);
    if (showingSatellite) {
      this.map.removeLayer(this.satelliteLayer);
      this.streetLayer.addTo(this.map);
      if (this.mapTypeBtn) this.mapTypeBtn.textContent = 'Satellite';
    } else {
      this.map.removeLayer(this.streetLayer);
      this.satelliteLayer.addTo(this.map);
      if (this.mapTypeBtn) this.mapTypeBtn.textContent = 'Map';
    }
  };

  StoreLocatorInstance.prototype.toggleFullscreen = function () {
    if (!this.mapWrapEl) return;
    var isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFullscreen) {
      var request = this.mapWrapEl.requestFullscreen || this.mapWrapEl.webkitRequestFullscreen;
      if (request) request.call(this.mapWrapEl);
    } else {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    }
  };

  StoreLocatorInstance.prototype.onFullscreenChange = function () {
    var self = this;
    var isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (this.fullscreenBtn) {
      this.fullscreenBtn.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'View fullscreen');
      this.fullscreenBtn.classList.toggle('is-active', isFullscreen);
    }
    // The map container's size just changed drastically; Leaflet needs a
    // beat to notice, or tiles render into the old (wrong) dimensions.
    setTimeout(function () {
      if (self.map) self.map.invalidateSize();
    }, 100);
  };

  StoreLocatorInstance.prototype.createMarkers = function (L) {
    var self = this;
    this.stores.forEach(function (s) {
      if (s.lat === null || s.lng === null) return;
      var icon = L.divIcon({
        className: 'store-locator__marker-wrap',
        html: markerIconHtml(),
        iconSize: [30, 40],
        iconAnchor: [15, 40],
        popupAnchor: [0, -40]
      });
      var marker = L.marker([s.lat, s.lng], { icon: icon, title: s.name }).addTo(self.map);
      marker.on('click', function () {
        self.selectStore(s.id, { fromMarker: true });
      });
      if (self.markers[s.id] && window.console) {
        console.warn('[Store Locator] Marker key collision while creating markers for "' + s.name + '" (' + s.id + ') — this should not happen after identity resolution; please report.');
      }
      self.markers[s.id] = marker;
    });
  };

  StoreLocatorInstance.prototype.updateMarkerVisibility = function (visibleIds) {
    var self = this;
    if (!this.map) return;
    Object.keys(this.markers).forEach(function (id) {
      var marker = self.markers[id];
      var shouldShow = !!visibleIds[id];
      var isShown = self.map.hasLayer(marker);
      if (shouldShow && !isShown) {
        marker.addTo(self.map);
      } else if (!shouldShow && isShown) {
        self.map.removeLayer(marker);
      }
    });
  };

  StoreLocatorInstance.prototype.fitMapToVisible = function (visible) {
    if (!this.map || !this.L || this.selectedStoreId) return;
    var L = this.L;

    // When a distance filter is active, frame the search radius itself —
    // this stays correct even if the radius currently contains zero stores
    // (e.g. "5 km" with nothing that close), showing the customer exactly
    // what area was searched instead of leaving the map wherever it was.
    if (this.activeRadiusKm && this.radiusCircle) {
      this.map.fitBounds(this.radiusCircle.getBounds(), { padding: [24, 24], animate: !this.prefersReducedMotion });
      return;
    }

    var coords = visible.filter(function (s) { return s.lat !== null && s.lng !== null; });
    if (!coords.length) return;

    if (coords.length === 1) {
      var targetZoom = Math.max(this.map.getZoom(), 13);
      if (this.prefersReducedMotion) {
        this.map.setView([coords[0].lat, coords[0].lng], targetZoom);
      } else {
        this.map.flyTo([coords[0].lat, coords[0].lng], targetZoom, { duration: 0.6 });
      }
      return;
    }

    var latlngs = coords.map(function (s) { return [s.lat, s.lng]; });
    if (this.userLocation) latlngs.push([this.userLocation.lat, this.userLocation.lng]);
    if (this.searchLocation) latlngs.push([this.searchLocation.lat, this.searchLocation.lng]);

    var bounds = L.latLngBounds(latlngs);
    this.map.fitBounds(bounds, { padding: [48, 48], animate: !this.prefersReducedMotion });
  };

  /**
   * Draws (or removes) a translucent circle on the map showing the active
   * distance filter's radius around the current origin — this is the "also
   * visible on the map" half of the distance filter, not just a list cutoff.
   * Recreated on every applyFilters() call rather than resized in place,
   * since both the radius and the origin can change independently and a
   * plain L.circle has no cheap "move + resize" shortcut worth optimizing
   * for something that redraws at most once per user interaction.
   */
  StoreLocatorInstance.prototype.updateRadiusCircle = function () {
    if (this.radiusCircle && this.map) {
      this.map.removeLayer(this.radiusCircle);
      this.radiusCircle = null;
    }

    if (!this.map || !this.L || !this.activeRadiusKm) return;

    var origin = this.getCurrentOrigin();
    if (!origin) return;

    var accent = getComputedStyle(this.root).getPropertyValue('--slr-accent').trim() || '#1a1a1a';

    this.radiusCircle = this.L.circle([origin.lat, origin.lng], {
      radius: this.activeRadiusKm * 1000, // Leaflet circles are always in meters
      color: accent,
      weight: 1.5,
      opacity: 0.45,
      fillColor: accent,
      fillOpacity: 0.06,
      interactive: false
    }).addTo(this.map);
  };

  StoreLocatorInstance.prototype.getStoreById = function (id) {
    for (var i = 0; i < this.stores.length; i++) {
      if (this.stores[i].id === id) return this.stores[i];
    }
    return null;
  };

  StoreLocatorInstance.prototype.selectStore = function (storeId, options) {
    options = options || {};
    var store = this.getStoreById(storeId);
    if (!store) {
      if (window.console) console.warn('[Store Locator] selectStore: no store data found for id', storeId);
      return;
    }

    if (DEBUG_STORE_LOCATOR && window.console) {
      console.log('[Store Locator] Select -> id:', store.id, 'name:', store.name, 'lat/lng:', store.lat, store.lng);
    }

    if (this.routeDestinationId && this.routeDestinationId !== storeId) {
      this.clearRoute();
    }

    this.selectedStoreId = storeId;
    this.updateSelectedCardState();
    this.updateSelectedMarkerIcons();

    if (store.lat === null || store.lng === null) {
      this.announce(store.name + ' doesn\'t have map coordinates yet, so it can\'t be shown on the map.');
    } else if (this.map) {
      var targetZoom = Math.max(this.map.getZoom(), 15);
      if (this.prefersReducedMotion) {
        this.map.setView([store.lat, store.lng], targetZoom);
      } else {
        this.map.flyTo([store.lat, store.lng], targetZoom, { duration: 0.6 });
      }
      this.animateMarker(store);
      this.openPopup(store);
    }

    if (options.fromMarker) {
      this.scrollCardIntoView(store);
    }
  };

  StoreLocatorInstance.prototype.deselectStore = function () {
    this.selectedStoreId = null;
    this.updateSelectedCardState();
    this.updateSelectedMarkerIcons();
  };

  StoreLocatorInstance.prototype.updateSelectedCardState = function () {
    var self = this;
    this.stores.forEach(function (s) {
      var isSelected = s.id === self.selectedStoreId;
      s.cardEl.classList.toggle('is-selected', isSelected);
      if (s.triggerEl) s.triggerEl.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
  };

  StoreLocatorInstance.prototype.updateSelectedMarkerIcons = function () {
    var self = this;
    Object.keys(this.markers).forEach(function (id) {
      var marker = self.markers[id];
      var el = marker.getElement();
      var iconEl = el ? el.querySelector('[data-marker-icon]') : null;
      var isSelected = id === self.selectedStoreId;
      if (iconEl) iconEl.classList.toggle('is-selected', isSelected);
      marker.setZIndexOffset(isSelected ? 1000 : 0);
    });
  };

  StoreLocatorInstance.prototype.scrollCardIntoView = function (store) {
    if (!store.itemEl) return;
    store.itemEl.scrollIntoView({
      behavior: this.prefersReducedMotion ? 'auto' : 'smooth',
      block: 'nearest'
    });
  };

  StoreLocatorInstance.prototype.animateMarker = function (store) {
    var marker = this.markers[store.id];
    if (!marker) return;
    var el = marker.getElement();
    var iconEl = el ? el.querySelector('[data-marker-icon]') : null;
    var pulseEl = el ? el.querySelector('[data-marker-pulse]') : null;

    if (pulseEl) {
      pulseEl.hidden = true;
      pulseEl.classList.remove('is-active');
    }

    if (this.prefersReducedMotion || !iconEl) return;

    iconEl.classList.remove('is-bouncing');
    void iconEl.offsetWidth; // force reflow so re-selecting the same store restarts the animation
    iconEl.classList.add('is-bouncing');
    setTimeout(function () {
      iconEl.classList.remove('is-bouncing');
    }, 700);

    if (pulseEl) {
      pulseEl.hidden = false;
      pulseEl.classList.add('is-active');
      setTimeout(function () {
        pulseEl.hidden = true;
        pulseEl.classList.remove('is-active');
      }, 1400);
    }
  };

  /**
   * Hover cue: a brief one-shot hop when the pointer enters (a "greeting"),
   * then a smooth, continuous glow + expanding ring for as long as the card
   * stays hovered — distinct from the one-shot hop+pulse used for an actual
   * click/selection, which is stronger and persists until deselected.
   * Under reduced-motion, falls back to a static color + scale change only.
   */
  StoreLocatorInstance.prototype.setMarkerHovering = function (id, isHovering) {
    var marker = this.markers[id];
    if (!marker) {
      if (isHovering && window.console) {
        console.warn('[Store Locator] Hover: no map marker for this store id — likely missing/invalid coordinates:', id);
      }
      return;
    }
    var el = marker.getElement();
    var iconEl = el ? el.querySelector('[data-marker-icon]') : null;
    var pulseEl = el ? el.querySelector('[data-marker-pulse]') : null;

    if (iconEl) iconEl.classList.toggle('is-hover', isHovering);

    if (this.prefersReducedMotion) return;

    if (iconEl) {
      if (isHovering) {
        iconEl.classList.remove('is-hover-hopping');
        void iconEl.offsetWidth; // force reflow so re-entering quickly restarts the hop
        iconEl.classList.add('is-hover-hopping');
        setTimeout(function () {
          iconEl.classList.remove('is-hover-hopping');
        }, 420);
      }
      iconEl.classList.toggle('is-hover-pulsing', isHovering);
    }
    if (pulseEl) {
      if (isHovering) {
        pulseEl.hidden = false;
        pulseEl.classList.add('is-hover-active');
      } else {
        pulseEl.classList.remove('is-hover-active');
        pulseEl.hidden = true;
      }
    }
  };

  StoreLocatorInstance.prototype.openPopup = function (store) {
    if (!this.popup || !this.map) return;
    this.popup.setLatLng([store.lat, store.lng]);
    this.popup.setContent(this.buildPopupContent(store));
    if (!this.map.hasLayer(this.popup)) {
      this.popup.openOn(this.map);
    }
  };

  StoreLocatorInstance.prototype.buildPopupContent = function (store) {
    var self = this;
    var status = getStoreStatus(store.hours, store.timezone);
    var wrap = document.createElement('div');
    wrap.className = 'store-locator__popup';

    var name = document.createElement('h3');
    name.className = 'store-locator__popup-name';
    name.textContent = store.name;
    wrap.appendChild(name);

    if (store.type) {
      var type = document.createElement('p');
      type.className = 'store-locator__popup-type';
      type.textContent = store.type.charAt(0).toUpperCase() + store.type.slice(1);
      wrap.appendChild(type);
    }

    if (store.address) {
      var address = document.createElement('p');
      address.className = 'store-locator__popup-address';
      address.textContent = store.address;
      wrap.appendChild(address);
    }

    var statusRow = document.createElement('p');
    statusRow.className = 'store-locator__popup-status';
    statusRow.textContent = status.label;
    wrap.appendChild(statusRow);

    var phoneAttr = store.cardEl.getAttribute('data-phone');
    if (phoneAttr) {
      var phone = document.createElement('p');
      phone.className = 'store-locator__popup-phone';
      phone.textContent = phoneAttr;
      wrap.appendChild(phone);
    }

    var routeBtn = document.createElement('button');
    routeBtn.type = 'button';
    routeBtn.className = 'store-locator__popup-directions';
    routeBtn.innerHTML = '<span>Get Directions</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';
    routeBtn.addEventListener('click', function () {
      self.requestDirectionsTo(store);
    });
    wrap.appendChild(routeBtn);

    var link = document.createElement('a');
    link.className = 'store-locator__popup-external-link';
    link.href = store.directionsEl ? store.directionsEl.href : buildDirectionsUrl(store.lat, store.lng, store.address);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.innerHTML = '<span>Open in Google Maps</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
    wrap.appendChild(link);

    return wrap;
  };

  /* ------------------------------ Directions ------------------------------ */

  /**
   * Resolves a starting point (user's location, or a previously searched
   * location) and draws a route to `store` on the map itself. If neither
   * is known yet, this asks for geolocation on the spot rather than
   * failing silently.
   *
   * Every call gets a fresh routeRequestToken. If the user clicks a second
   * store before this one's async chain (geolocation → routing machine →
   * OSRM) finishes, the token check in drawRoute()'s callbacks throws away
   * the stale result instead of letting it overwrite the newer click.
   */
  StoreLocatorInstance.prototype.requestDirectionsTo = function (store) {
    var self = this;

    this.routeRequestToken += 1;
    var token = this.routeRequestToken;

    if (DEBUG_STORE_LOCATOR && window.console) {
      console.log('[Store Locator] Directions request');
      console.log('  Store ID:', store.id, store.shopifyId ? '(shopify id: ' + store.shopifyId + ')' : '');
      console.log('  Store Name:', store.name);
      console.log('  Card Latitude:', store.cardEl.getAttribute('data-lat'));
      console.log('  Card Longitude:', store.cardEl.getAttribute('data-lng'));
      console.log('  Resolved Store Latitude:', store.lat);
      console.log('  Resolved Store Longitude:', store.lng);
      console.log('  Final Destination:', (store.lat !== null && store.lng !== null) ? (store.lat + ',' + store.lng) : '(missing coordinates)');
    }

    if (store.lat === null || store.lng === null) {
      this.clearRoute();
      this.announce('Directions aren\'t available for ' + store.name + ' yet — it\'s missing map coordinates.');
      return;
    }

    var origin = this.getCurrentOrigin();

    if (origin) {
      this.drawRoute(origin, store, token);
      return;
    }

    if (!('geolocation' in navigator)) {
      this.announce('We need a starting point for directions — try searching a city or postcode first.');
      return;
    }

    this.announce('Getting your location to calculate directions…');
    navigator.geolocation.getCurrentPosition(
      function (position) {
        if (token !== self.routeRequestToken) return; // superseded by a newer click
        self.userLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        self.lastLocationSource = 'user';
        self.showUserMarker();
        self.applyFilters();
        self.drawRoute(self.userLocation, store, token);
      },
      function () {
        if (token !== self.routeRequestToken) return;
        self.announce('We could not access your location. Try searching a city or postcode instead, then tap Get Directions again.');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  };

  StoreLocatorInstance.prototype.drawRoute = function (origin, store, token) {
    var self = this;
    if (token === undefined) token = this.routeRequestToken;

    if (!this.map || store.lat === null || store.lng === null) {
      this.clearRoute();
      return;
    }

    loadRoutingMachine().then(function (L) {
      if (token !== self.routeRequestToken) return; // a later click already superseded this request

      self.clearRoute();

      var accent = getComputedStyle(self.root).getPropertyValue('--slr-accent').trim() || '#1a1a1a';

      self.routingControl = L.Routing.control({
        waypoints: [
          L.latLng(origin.lat, origin.lng),
          L.latLng(store.lat, store.lng)
        ],
        router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' }),
        routeWhileDragging: false,
        addWaypoints: false,
        draggableWaypoints: false,
        fitSelectedRoutes: true,
        show: false,
        createMarker: function () { return null; },
        lineOptions: {
          styles: [{ color: accent, weight: 5, opacity: 0.85 }]
        }
      }).addTo(self.map);

      self.routeDestinationId = store.id;

      self.routingControl.on('routesfound', function (e) {
        if (token !== self.routeRequestToken) return;
        var route = e.routes && e.routes[0];
        if (!route || !route.summary) return;
        var km = route.summary.totalDistance / 1000;
        var mins = Math.round(route.summary.totalTime / 60);
        self.showRouteSummary(store, km, mins);
      });

      self.routingControl.on('routingerror', function (e) {
        if (token !== self.routeRequestToken) return;
        var reason = (e && e.error && (e.error.message || e.error.status)) || '';
        var message = 'Could not calculate directions to ' + store.name + '.';
        if (/no.?route/i.test(reason)) {
          message = 'No drivable route was found to ' + store.name + ' — the starting point and this store may be too far apart to connect by road (e.g. different continents).';
        }
        self.announce(message);
        self.clearRoute();
      });
    }).catch(function () {
      if (token !== self.routeRequestToken) return;
      self.announce('Directions are unavailable right now. You can still open this in Google Maps.');
    });
  };

  StoreLocatorInstance.prototype.showRouteSummary = function (store, km, minutes) {
    if (!this.routeSummaryEl || !this.routeSummaryTextEl) return;
    var distanceLabel = formatDistance(km);
    this.routeSummaryTextEl.textContent = distanceLabel + ' · ' + minutes + ' min to ' + store.name;
    this.routeSummaryEl.hidden = false;
  };

  StoreLocatorInstance.prototype.hideRouteSummary = function () {
    if (this.routeSummaryEl) this.routeSummaryEl.hidden = true;
  };

  StoreLocatorInstance.prototype.clearRoute = function () {
    if (this.routingControl && this.map) {
      this.map.removeControl(this.routingControl);
    }
    this.routingControl = null;
    this.routeDestinationId = null;
    this.hideRouteSummary();
  };

  /**
   * Full teardown of this instance: stops the background status timer,
   * removes the global (document/window-level) listeners this instance
   * registered, and destroys the Leaflet map. Without this, a Shopify
   * Theme Editor section reload that replaces `root` with a fresh element
   * would leave the old instance's setInterval and document-level
   * listeners running forever in the background against a detached node —
   * harmless to correctness of the new instance (which has its own,
   * separately-keyed markers/listeners) but a real memory/CPU leak over
   * repeated edits in a long Theme Editor session.
   */
  StoreLocatorInstance.prototype.destroy = function () {
    if (this._statusInterval) clearInterval(this._statusInterval);
    if (this._onFullscreenChange) {
      document.removeEventListener('fullscreenchange', this._onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', this._onFullscreenChange);
    }
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this.clearRoute();
    if (this.map) {
      try { this.map.remove(); } catch (err) { /* already gone */ }
    }
    this.map = null;
    this.markers = {};
  };

  /* --------------------------------- Init --------------------------------- */

  function initAll(scope) {
    var roots = (scope || document).querySelectorAll('[data-store-locator]');
    Array.prototype.forEach.call(roots, function (el) {
      // Belt-and-braces: if this exact element already has a live instance
      // (duplicate script include, a re-fired init, etc.), never attach a
      // second one — two independent instances on the same DOM is exactly
      // what causes "sometimes the right marker responds, sometimes it
      // doesn't" symptoms, since both would be listening at once.
      if (el.getAttribute('data-store-locator-ready') === 'true') return;
      el.setAttribute('data-store-locator-ready', 'true');
      var instance = new StoreLocatorInstance(el);
      activeInstances.push(instance);
    });

    // Prune and destroy any tracked instances whose root element is no
    // longer attached to the document (e.g. the Theme Editor replaced the
    // whole section markup on save). This is what actually prevents
    // "duplicate map/markers/listeners after a Theme Editor reload":
    // rather than only guarding against re-initializing the SAME element,
    // it also stops orphaned instances from a REPLACED element from
    // lingering in memory with live timers and document-level listeners.
    activeInstances = activeInstances.filter(function (inst) {
      if (!document.body.contains(inst.root)) {
        inst.destroy();
        return false;
      }
      return true;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initAll(document); });
  } else {
    initAll(document);
  }

  document.addEventListener('shopify:section:load', function (event) {
    initAll(event.target);
    // A reload swaps in new section markup; sweep the whole document (not
    // just event.target) so instances from the OLD, now-detached section
    // element get pruned even though event.target only points at the new one.
    initAll(document);
  });

  document.addEventListener('shopify:section:unload', function (event) {
    activeInstances = activeInstances.filter(function (inst) {
      if (event.target && (event.target === inst.root || event.target.contains(inst.root))) {
        inst.destroy();
        return false;
      }
      return true;
    });
  });
})();