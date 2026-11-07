/*
 * Snapshot bridge runtime.
 *
 * Runs INSIDE the sandboxed iframe that shows a Zotero web snapshot. The host
 * injects this file inline (before the snapshot's own scripts), so it must be:
 *   - a classic IIFE (no modules, no imports, no build step)
 *   - pure ASCII (the host splices it into the HTML at byte level via latin1)
 *   - defensive: the iframe has an opaque origin, so localStorage, cookies and
 *     window.parent all throw on access. Everything is wrapped in try/catch.
 *
 * Responsibilities:
 *   1. shim the storages that throw in an opaque origin, so snapshot scripts
 *      do not die on the first `localStorage.getItem`
 *   2. rebuild highlights from Zotero's `CssSelector` + `TextPositionSelector`
 *   3. report the user's selection back to the parent (as plain data)
 *   4. scroll/flash on `locate`, forward link clicks out of the sandbox
 *
 * Message envelope: { s: 'dsh-zotero/snapshot', v: 1, type, ... }
 */
(function () {
  'use strict';

  var CHANNEL = 'dsh-zotero/snapshot';
  var VERSION = 1;
  var FLASH_CLASS = 'dsh-zotero-snapshot-flash';
  var FLASH_MS = 1300;

  /* Nodes whose text must never be wrapped: wrapping would break the script
     or produce invisible markup. Their characters still count towards offsets
     because `Range.toString()` and `textContent` both include them. */
  var NO_WRAP = { script: 1, style: 1, noscript: 1, template: 1 };

  var annotations = [];
  var applied = 0;
  var bodyReady = false;
  var pendingApply = false;

  /* ---------------------------------------------------------------- utils */

  function post(message) {
    message.s = CHANNEL;
    message.v = VERSION;
    try {
      parent.postMessage(message, '*');
    } catch (error) {
      /* opaque origin: nothing we can do, and nothing to report to */
    }
  }

  function escapeIdent(value) {
    try {
      if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
    } catch (error) {
      /* fall through */
    }
    return String(value).replace(/[^A-Za-z0-9_-]/g, function (char) {
      return '\\' + char;
    });
  }

  function isSpace(code) {
    return code === 32 || code === 9 || code === 10 || code === 13
      || code === 0xa0 || code === 0x3000;
  }

  function foldChar(code) {
    /* full-width ASCII -> half-width, so a full-width colon matches `:` */
    return code >= 0xff01 && code <= 0xff5e ? code - 0xfee0 : code;
  }

  function foldText(value) {
    var out = '';
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (isSpace(code)) continue;
      out += String.fromCharCode(foldChar(code));
    }
    return out;
  }

  /* ------------------------------------------------------- storage shims */

  function memoryStorage() {
    var data = {};
    return {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
      },
      setItem: function (key, value) {
        data[key] = String(value);
      },
      removeItem: function (key) {
        delete data[key];
      },
      clear: function () {
        data = {};
      },
      key: function (index) {
        var keys = Object.keys(data);
        return index >= 0 && index < keys.length ? keys[index] : null;
      },
      get length() {
        return Object.keys(data).length;
      }
    };
  }

  function installStorageShim(name) {
    var broken = false;
    try {
      /* Access throws a SecurityError on an opaque origin. */
      void window[name];
    } catch (error) {
      broken = true;
    }
    if (!broken) return;
    try {
      Object.defineProperty(window, name, {
        value: memoryStorage(),
        configurable: true,
        writable: false
      });
    } catch (error) {
      /* non-configurable: snapshot scripts will have to cope on their own */
    }
  }

  /* ------------------------------------------------------------ offsets */

  /* Character offset of (container, offset) measured from the start of `root`,
     matching `Element.textContent` semantics (so it lines up with the offsets
     Zotero writes into TextPositionSelector). */
  function offsetWithin(root, container, offset) {
    try {
      var probe = document.createRange();
      probe.setStart(root, 0);
      probe.setEnd(container, offset);
      return probe.toString().length;
    } catch (error) {
      return -1;
    }
  }

  /* Build one range per text node covered by [start, end) inside `root`. */
  function partsWithin(root, start, end) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var parts = [];
    var consumed = 0;
    var node = walker.nextNode();
    while (node !== null) {
      var length = node.nodeValue.length;
      var from = Math.max(start - consumed, 0);
      var to = Math.min(end - consumed, length);
      if (from < to) parts.push({ node: node, from: from, to: to });
      consumed += length;
      if (consumed >= end) break;
      node = walker.nextNode();
    }
    return parts;
  }

  /* -------------------------------------------------- global text fallback */

  var globalIndex = null;
  var foldedIndex = null;

  function getGlobalIndex() {
    if (globalIndex !== null) return globalIndex;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var texts = [];
    var starts = [];
    var total = 0;
    var node = walker.nextNode();
    while (node !== null) {
      nodes.push(node);
      texts.push(node.nodeValue);
      starts.push(total);
      total += node.nodeValue.length;
      node = walker.nextNode();
    }
    globalIndex = { nodes: nodes, texts: texts, starts: starts };
    return globalIndex;
  }

  function getFoldedIndex() {
    if (foldedIndex !== null) return foldedIndex;
    var index = getGlobalIndex();
    var chars = [];
    var mapNode = [];
    var mapOffset = [];
    for (var i = 0; i < index.texts.length; i++) {
      var text = index.texts[i];
      for (var j = 0; j < text.length; j++) {
        var code = text.charCodeAt(j);
        if (isSpace(code)) continue;
        chars.push(String.fromCharCode(foldChar(code)));
        mapNode.push(i);
        mapOffset.push(j);
      }
    }
    foldedIndex = { text: chars.join(''), mapNode: mapNode, mapOffset: mapOffset };
    return foldedIndex;
  }

  /* Locate `text` by scanning the whole document. Used when the CSS selector
     no longer matches (snapshot JS rewrote the DOM after the annotation was
     created). Only the first hit is used; the caller flags it as uncertain. */
  function partsByText(text) {
    var query = foldText(text);
    if (query === '') return null;
    var folded = getFoldedIndex();
    var hit = folded.text.indexOf(query);
    if (hit < 0) return null;
    var index = getGlobalIndex();
    var firstNode = folded.mapNode[hit];
    var lastNode = folded.mapNode[hit + query.length - 1];
    var firstOffset = folded.mapOffset[hit];
    var lastOffset = folded.mapOffset[hit + query.length - 1];
    var parts = [];
    for (var i = firstNode; i <= lastNode; i++) {
      var from = i === firstNode ? firstOffset : 0;
      var to = i === lastNode ? lastOffset + 1 : index.texts[i].length;
      if (from < to) parts.push({ node: index.nodes[i], from: from, to: to });
    }
    return parts.length === 0 ? null : parts;
  }

  /* -------------------------------------------------------- highlighting */

  function canWrap(node) {
    var parent = node.parentNode;
    if (parent === null || parent.nodeType !== 1) return false;
    if (parent.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
    return NO_WRAP[parent.localName] !== 1;
  }

  function makeWrapper(owners, text) {
    var first = owners[0];
    var element;
    if (first.type === 'underline') {
      element = document.createElement('span');
      element.style.textDecoration = 'underline';
      element.style.textDecorationColor = first.color || '#aaaaaa';
      element.style.textDecorationThickness = '2px';
      element.style.textUnderlineOffset = '2px';
    } else {
      element = document.createElement('mark');
      /* 8-digit hex = base colour + 0x55 alpha, readable on light and dark */
      element.style.background = (first.color || '#ffd400') + '55';
      element.style.color = 'inherit';
      element.style.padding = '0';
      element.style.borderRadius = '2px';
    }
    element.style.cursor = 'pointer';
    element.setAttribute('data-dsh-ann', owners.map(function (owner) {
      return owner.key;
    }).join(' '));
    element.appendChild(document.createTextNode(text));
    return element;
  }

  function wrapParts(byNode) {
    var nodes = [];
    byNode.forEach(function (_list, node) {
      nodes.push(node);
    });
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      if (!canWrap(node)) continue;
      var list = byNode.get(node);
      list.sort(function (a, b) { return a.from - b.from; });

      var cuts = [0, node.nodeValue.length];
      for (var i = 0; i < list.length; i++) {
        cuts.push(list[i].from, list[i].to);
      }
      cuts.sort(function (a, b) { return a - b; });

      var fragment = document.createDocumentFragment();
      for (var k = 0; k < cuts.length - 1; k++) {
        var from = cuts[k];
        var to = cuts[k + 1];
        if (from >= to) continue;
        var segment = node.nodeValue.slice(from, to);
        var owners = [];
        for (var j = 0; j < list.length; j++) {
          if (list[j].from <= from && to <= list[j].to) owners.push(list[j].annotation);
        }
        fragment.appendChild(owners.length === 0
          ? document.createTextNode(segment)
          : makeWrapper(owners, segment));
      }

      var parent = node.parentNode;
      if (parent === null) continue;
      parent.replaceChild(fragment, node);
    }
  }

  function unwrapAll() {
    var holders = document.querySelectorAll('[data-dsh-ann]');
    var parents = [];
    for (var i = 0; i < holders.length; i++) {
      var holder = holders[i];
      var parent = holder.parentNode;
      if (parent === null) continue;
      parent.replaceChild(document.createTextNode(holder.textContent || ''), holder);
      if (parents.indexOf(parent) < 0) parents.push(parent);
    }
    for (var p = 0; p < parents.length; p++) {
      if (typeof parents[p].normalize === 'function') parents[p].normalize();
    }
  }

  function partsFor(annotation) {
    var position = annotation.webPosition;
    if (!position) return null;

    var element = null;
    try {
      element = document.querySelector(position.selector);
    } catch (error) {
      element = null;
    }
    if (element !== null && element !== document.body && document.body.contains(element)) {
      /* The offsets are relative to the element's own textContent. Walking the
         subtree is both faster and correct for selections spanning children. */
      var parts = partsWithin(element, position.start, position.end);
      if (parts.length > 0) return parts;
    }

    return partsByText(annotation.text);
  }

  function applyAll() {
    if (!bodyReady) {
      pendingApply = true;
      return;
    }
    pendingApply = false;
    unwrapAll();

    var byNode = new Map();
    var resolved = 0;
    var failure = null;
    try {
      for (var i = 0; i < annotations.length; i++) {
        var annotation = annotations[i];
        if (annotation.type !== 'highlight' && annotation.type !== 'underline') {
          /* note / image / ink have no text anchor on a snapshot */
          resolved++;
          continue;
        }
        var parts = partsFor(annotation);
        if (parts === null) continue;
        resolved++;
        for (var p = 0; p < parts.length; p++) {
          var part = parts[p];
          if (!canWrap(part.node)) continue;
          var list = byNode.get(part.node);
          if (list === undefined) {
            list = [];
            byNode.set(part.node, list);
          }
          list.push({ from: part.from, to: part.to, annotation: annotation });
        }
      }
      wrapParts(byNode);
    } catch (error) {
      /* A page that mutates while we wrap is not worth breaking over - but the
         parent must still hear something, otherwise it waits for `applied`
         forever and shows a false "still loading" state. */
      failure = (error && error.message) || String(error);
      resolved = 0;
    }
    applied += 1;
    post({
      type: 'applied',
      total: annotations.length,
      resolved: resolved,
      rev: applied,
      error: failure
    });
  }

  function flash(element) {
    element.classList.remove(FLASH_CLASS);
    /* force a reflow so the animation restarts on repeat clicks */
    void element.offsetWidth;
    element.classList.add(FLASH_CLASS);
    window.setTimeout(function () {
      element.classList.remove(FLASH_CLASS);
    }, FLASH_MS);
  }

  function locate(key) {
    var selector = '[data-dsh-ann~="' + escapeIdent(key) + '"]';
    var holders;
    try {
      holders = document.querySelectorAll(selector);
    } catch (error) {
      holders = [];
    }
    if (holders.length === 0) {
      post({ type: 'locate-result', key: key, ok: false });
      return;
    }
    try {
      holders[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (error) {
      holders[0].scrollIntoView();
    }
    for (var i = 0; i < holders.length; i++) flash(holders[i]);
    post({ type: 'locate-result', key: key, ok: true });
  }

  /* ----------------------------------------------------------- selection */

  /* Shortest unique selector for `element`, in the same shape Zotero writes
     (`p:nth-child(6)`) rather than a full html>body>... chain: shorter paths
     survive more DOM churn. */
  function cssPath(element) {
    var segments = [];
    var current = element;
    while (current !== null && current.nodeType === 1 && current !== document.documentElement) {
      if (current.id) {
        segments.unshift('#' + escapeIdent(current.id));
        break;
      }
      var parent = current.parentElement;
      if (parent === null) break;
      var index = 1;
      var sibling = current.previousElementSibling;
      while (sibling !== null) {
        index += 1;
        sibling = sibling.previousElementSibling;
      }
      segments.unshift(current.localName + ':nth-child(' + index + ')');
      current = parent;
    }
    if (segments.length === 0) return null;

    for (var i = 0; i < segments.length; i++) {
      var candidate = segments.slice(i).join(' > ');
      try {
        var hits = document.querySelectorAll(candidate);
        if (hits.length === 1 && hits[0] === element) return candidate;
      } catch (error) {
        /* keep trying shorter forms */
      }
    }
    return segments.join(' > ');
  }

  function globalOffset(container, offset) {
    if (document.body === null) return 0;
    return Math.max(0, offsetWithin(document.body, container, offset));
  }

  function snapshotSelection() {
    var selection;
    try {
      selection = window.getSelection();
    } catch (error) {
      return null;
    }
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    var range = selection.getRangeAt(0);
    var text = selection.toString().replace(/\s+/g, ' ').trim();
    if (text === '') return null;
    if (document.body === null || !document.body.contains(range.commonAncestorContainer)) return null;

    var element = range.commonAncestorContainer;
    if (element.nodeType !== 1) element = element.parentElement;
    if (element === null || element === document.documentElement || element === document.body) {
      /* A selection over the whole page is not something we can anchor to a
         single element; ask the user to pick a narrower range. */
      return null;
    }

    var selector = cssPath(element);
    if (selector === null) return null;
    var start = offsetWithin(element, range.startContainer, range.startOffset);
    var end = offsetWithin(element, range.endContainer, range.endOffset);
    if (start < 0 || end <= start) return null;

    var rect = range.getBoundingClientRect();
    /* Zotero's web sortIndex is a 7-digit number; the exact formula is not
       public, so we use the document-order text offset. It only affects the
       ordering inside Zotero's annotation list, never where the highlight
       lands, so an approximation is acceptable. */
    var sortIndex = String(Math.min(9999999, globalOffset(range.startContainer, range.startOffset)));
    while (sortIndex.length < 7) sortIndex = '0' + sortIndex;

    return {
      text: text,
      selector: selector,
      start: start,
      end: end,
      sortIndex: sortIndex,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    };
  }

  function publishSelection() {
    post({ type: 'selection', selection: snapshotSelection() });
  }

  /* True while the user is holding a non-empty selection: used to tell a click
     on a highlight apart from a drag-select that happens to end on one. */
  function hasLiveSelection() {
    try {
      var selection = window.getSelection();
      return !!selection && !selection.isCollapsed && selection.toString().trim() !== '';
    } catch (error) {
      return false;
    }
  }

  var selectionFrame = 0;
  function scheduleSelection() {
    if (selectionFrame !== 0) return;
    selectionFrame = window.requestAnimationFrame(function () {
      selectionFrame = 0;
      publishSelection();
    });
  }

  /* -------------------------------------------------------------- wiring */

  function installStyle() {
    if (document.getElementById('dsh-zotero-snapshot-style') !== null) return;
    var style = document.createElement('style');
    style.id = 'dsh-zotero-snapshot-style';
    style.textContent =
      'mark[data-dsh-ann]{background:none;color:inherit;padding:0}' +
      'mark[data-dsh-ann],span[data-dsh-ann]{border-radius:2px}' +
      '.' + FLASH_CLASS + '{outline:2px solid rgba(80,140,255,.95);outline-offset:1px}';
    (document.head || document.documentElement).appendChild(style);
  }

  function onBodyReady() {
    if (bodyReady) return;
    bodyReady = true;
    try {
      installStyle();
    } catch (error) {
      /* cosmetic only */
    }
    if (pendingApply) {
      try {
        applyAll();
      } catch (error) {
        /* applyAll already reports its own failures */
      }
    }
    publishSelection();
  }

  window.addEventListener('message', function (event) {
    /* Deliberately no `event.source` check here: inside a sandboxed iframe the
       `window.parent` proxy is not reliably identity-equal to `event.source`,
       and getting it wrong silently kills every highlight. The parent is the
       side that must be strict (it compares against `iframe.contentWindow`);
       this side only ever applies visual changes, so a forged message cannot
       do more than draw a highlight. */
    var data = event.data;
    if (!data || data.s !== CHANNEL || data.v !== VERSION) return;
    if (data.type === 'annotations') {
      annotations = Array.isArray(data.items) ? data.items : [];
      applyAll();
      return;
    }
    if (data.type === 'locate') {
      locate(String(data.key || ''));
      return;
    }
    if (data.type === 'clear-selection') {
      try {
        window.getSelection().removeAllRanges();
      } catch (error) {
        /* nothing to clear */
      }
    }
  });

  /* Highlight clicks and outbound links are both forwarded to the parent.
     Sandbox has no allow-popups, so an un-intercepted <a> would navigate the
     iframe itself away from the snapshot - that must never happen. */
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    /* Ending a drag-select on top of an existing highlight also fires `click`.
       That is a selection, not a click on the highlight: the parent is about to
       show the selection bar and must not get an edit card on top of it. */
    var holder = target.closest('[data-dsh-ann]');
    if (holder !== null && !hasLiveSelection()) {
      var owners = (holder.getAttribute('data-dsh-ann') || '').split(' ');
      if (owners.length > 0 && owners[0] !== '') {
        /* The parent needs the click position to place the edit card; a plain
           `getBoundingClientRect` is enough, no hit-testing on this side. */
        var box = holder.getBoundingClientRect();
        post({
          type: 'annotation-click',
          key: owners[0],
          rect: { left: box.left, top: box.top, width: box.width, height: box.height }
        });
      }
    }

    var link = target.closest('a[href]');
    if (link === null) return;
    var href = link.getAttribute('href') || '';
    if (href === '' || href.charAt(0) === '#') return;
    event.preventDefault();
    post({ type: 'open-external', href: href });
  }, true);

  /* Pointer presses never reach the parent document, so an overlay opened in the
     panel (info menu, annotation card) would not close when the user clicks the
     page. Report only the fact of the press - the parent decides what to close.
     Capture phase: a page script stopping propagation must not swallow it. */
  document.addEventListener('pointerdown', function () {
    post({ type: 'pointerdown' });
  }, true);

  document.addEventListener('mouseup', function () {
    window.setTimeout(publishSelection, 0);
  });
  document.addEventListener('selectionchange', scheduleSelection);
  document.addEventListener('scroll', function () {
    post({ type: 'selection', selection: null });
  }, { passive: true, capture: true });

  if (document.body === null) {
    document.addEventListener('DOMContentLoaded', onBodyReady, { once: true });
  } else {
    onBodyReady();
  }

  /* Snapshot scripts (SingleFile's lazy-image pass) can rewrite the DOM after
     DOMContentLoaded. Re-applying once after `load` keeps highlights on the
     final tree; a second run is cheap because unwrap/apply is idempotent. */
  window.addEventListener('load', function () {
    window.setTimeout(function () {
      if (annotations.length > 0) applyAll();
    }, 60);
  }, { once: true });

  installStorageShim('localStorage');
  installStorageShim('sessionStorage');

  post({ type: 'ready', bridge: 2 });
}());
