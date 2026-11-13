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
 *   5. publish the h1-h6 outline and scroll to a heading on request
 *   6. serialise the page for the screenshot feature (`capture`): the parent
 *      cannot read this document, so it gets HTML + CSS + geometry instead of
 *      a bitmap and rasterises it on its own side
 *
 * The outline conventions (heading selector, anchor attribute, depth rule,
 * item cap) mirror viewer/outline.ts; this file cannot import that module.
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

  /* ------------------------------------------------------------- outline */

  /* Mirrors viewer/outline.ts. Kept here because the bridge is a classic IIFE
     running inside the sandboxed iframe, with no way to import TS modules. */
  var OUTLINE_ATTR = 'data-dsh-zotero-outline';
  var OUTLINE_MAX_ITEMS = 800;
  var OUTLINE_MAX_DEPTH = 8;

  function publishOutline() {
    var nodes = [];
    try {
      nodes = document.body ? document.body.querySelectorAll('h1,h2,h3,h4,h5,h6') : [];
    } catch (error) {
      nodes = [];
    }
    var entries = [];
    var minLevel = 6;
    for (var i = 0; i < nodes.length && entries.length < OUTLINE_MAX_ITEMS; i++) {
      var node = nodes[i];
      var title = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (title === '') continue;
      /* Hidden headings (display:none, collapsed chrome) are not navigation. */
      try {
        if (node.getClientRects().length === 0) continue;
      } catch (error) {
        /* keep the heading if layout cannot be read */
      }
      var level = parseInt(node.tagName.charAt(1), 10);
      if (!(level >= 1 && level <= 6)) continue;
      if (level < minLevel) minLevel = level;
      entries.push({ node: node, title: title, level: level });
    }

    var items = [];
    for (var j = 0; j < entries.length; j++) {
      entries[j].node.setAttribute(OUTLINE_ATTR, String(j));
      items.push({
        title: entries[j].title,
        depth: Math.max(0, Math.min(OUTLINE_MAX_DEPTH - 1, entries[j].level - minLevel)),
        id: String(j)
      });
    }
    post({ type: 'outline', items: items });
  }

  function scrollToOutline(rawId) {
    /* Our own ids are decimal indices; refuse anything else before it reaches
       a selector. No CSS.escape here: it escapes leading digits, which is wrong
       inside a quoted attribute value. */
    var id = String(rawId || '');
    if (!/^[0-9]+$/.test(id)) return;
    var selector = '[' + OUTLINE_ATTR + '="' + id + '"]';
    var target = null;
    try {
      target = document.querySelector(selector);
    } catch (error) {
      target = null;
    }
    if (target === null) {
      /* A snapshot script may have rewritten the DOM after we published. */
      publishOutline();
      try {
        target = document.querySelector(selector);
      } catch (error) {
        target = null;
      }
    }
    if (target === null) return;
    try {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (error) {
      target.scrollIntoView();
    }
    flash(target);
  }

  /* ------------------------------------------------------------- capture */

  /* The parent cannot touch this document (opaque origin), so the only way to
     screenshot a web snapshot is to hand the parent a self-contained copy and
     let it rasterise there. Cloning alone is not enough: the scroll position,
     the text-box geometry and the h1-h6 list have to travel with it, otherwise
     the crop lands somewhere else and the "which part did I capture" metadata
     is wrong.

     Why not rasterise here: `blob:` images taint a canvas in an opaque origin
     (measured: SecurityError on toDataURL), and doing it with `data:` SVG would
     mean shipping a second serialiser into this file. The parent already has a
     working one (html-to-image), so both paths keep the same fidelity. */
  var CAPTURE_MAX_HTML = 8 * 1024 * 1024;
  var CAPTURE_MAX_BOXES = 4000;
  var CAPTURE_MAX_TEXT = 400;

  /* Read the stylesheet source, not its CSSOM serialisation.

     `sheet.cssRules[i].cssText` re-emits every declaration through
     CSSStyleDeclaration, which quietly destroys shorthands that reference a
     custom property: `mask: var(--icon) no-repeat` cannot be substituted at
     parse time, so it comes back as eight empty longhands (`mask-image: ;`
     ...). The variable reference is gone, `mask-image` falls back to `none`,
     and every icon built as `background-color: currentColor` + mask renders
     as a solid block. `background`, `border`, `font`, `transition` and friends
     lose their shorthand values the same way.

     An inline <style> keeps the original text verbatim, so read that. Only
     external sheets (rare in a saved snapshot, and unreadable cross-origin
     anyway) fall back to the lossy path. */
  function collectCssText() {
    var chunks = [];
    var sheets = document.styleSheets || [];
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i];
      if (sheet.disabled) continue;
      var owner = sheet.ownerNode;
      if (owner && owner.tagName === 'STYLE' && typeof owner.textContent === 'string'
        && owner.textContent !== '') {
        chunks.push(owner.textContent);
        continue;
      }
      try {
        var rules = sheet.cssRules;
        if (!rules) continue;
        for (var j = 0; j < rules.length; j++) chunks.push(rules[j].cssText);
      } catch (error) {
        /* Cross-origin sheet: unreadable, and unreachable anyway under our CSP. */
      }
    }
    return chunks.join('\n');
  }

  /* Attributes of html/body, minus the inline style string.

     The parent rebuilds a fresh <html> and <body>; anything that lived as an
     attribute is lost otherwise. `class` is the one that matters most: sites
     park `mac` / `dark` / `home` there and drive whole branches of CSS off it,
     so a dropped class flips the theme or swaps the shortcut hint from Cmd to
     Ctrl. */
  function attrsOf(element) {
    var out = [];
    if (!element) return out;
    var list = element.attributes || [];
    for (var i = 0; i < list.length; i++) {
      var name = list[i].name;
      if (name === 'style') continue;
      out.push([name, list[i].value]);
    }
    return out;
  }

  /* Body-level typography has to be copied explicitly: the rules above are
     document-level selectors, and the parent rebuilds the body inside a div.

     `margin` is folded into `padding` on purpose. The parent container is a
     border-box div sized to the viewport, so a copied margin would push it out
     of the crop window, while the same number as padding insets the content
     exactly like the original body did. */
  function bodyInlineStyle() {
    var names = ['font-family', 'font-size', 'line-height', 'color',
      'background-color', 'text-align', 'text-indent', 'letter-spacing',
      'word-spacing', 'direction'];
    var computed = null;
    try {
      computed = getComputedStyle(document.body);
    } catch (error) {
      return '';
    }
    function px(name) {
      var value = parseFloat(computed.getPropertyValue(name));
      return isNaN(value) ? 0 : value;
    }
    var parts = [];
    for (var i = 0; i < names.length; i++) {
      var value = computed.getPropertyValue(names[i]);
      if (value) parts.push(names[i] + ':' + value);
    }
    parts.push('padding:' + (px('padding-top') + px('margin-top')) + 'px ' +
      px('padding-right') + 'px ' +
      (px('padding-bottom')) + 'px ' +
      (px('padding-left') + px('margin-left')) + 'px');
    return parts.join(';');
  }

  function captureHtml() {
    return cleanClone(document.body).innerHTML;
  }

  /* Strip everything that cannot run or load on the parent side. Scripts and
     styles would re-execute / double-apply there; non-inline images cannot load
     under the parent's CSP, so their src is dropped while width/height survive
     (an empty box beats a broken-image glyph). */
  function cleanClone(node) {
    var clone = node.cloneNode(true);
    var kill = clone.querySelectorAll('script, style, link, noscript, template');
    for (var i = 0; i < kill.length; i++) {
      if (kill[i].parentNode) kill[i].parentNode.removeChild(kill[i]);
    }
    var images = clone.querySelectorAll('img');
    for (var k = 0; k < images.length; k++) {
      var src = images[k].getAttribute('src') || '';
      if (src.indexOf('data:') !== 0) images[k].removeAttribute('src');
      images[k].removeAttribute('srcset');
      images[k].removeAttribute('loading');
    }
    return clone;
  }

  /* Not every snapshot scrolls `documentElement`: single-page articles usually
     do, but app-like pages scroll an inner container instead. Serialising
     `body` and shifting by `documentElement.scrollTop` (always 0 there) would
     capture the top of the page no matter where the user is. */
  function findScrollContainer() {
    var root = document.documentElement;
    if (root.scrollTop > 0 || root.scrollLeft > 0
      || root.scrollHeight > root.clientHeight + 1) return root;
    var body = document.body;
    if (body && (body.scrollTop > 0 || body.scrollLeft > 0
      || body.scrollHeight > body.clientHeight + 1)) return body;
    var all = body ? body.querySelectorAll('*') : [];
    for (var i = 0; i < all.length; i++) {
      var style = null;
      try {
        style = getComputedStyle(all[i]);
      } catch (error) {
        continue;
      }
      var oy = style.overflowY;
      var ox = style.overflowX;
      var scrollable = oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll';
      if (!scrollable) continue;
      if (all[i].scrollTop > 0 || all[i].scrollLeft > 0
        || all[i].scrollHeight > all[i].clientHeight + 1) return all[i];
    }
    return root;
  }

  function collectTextBoxes() {
    var boxes = [];
    if (!document.body) return boxes;
    var walker = null;
    try {
      walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    } catch (error) {
      return boxes;
    }
    /* Only boxes inside the viewport can ever intersect a selection (the user
       drags over what is visible), so the rest is not worth measuring or
       shipping - a long article would otherwise send tens of thousands of
       nodes down the message channel. */
    var viewportBottom = document.documentElement.clientHeight;
    var node = walker.nextNode();
    while (node !== null && boxes.length < CAPTURE_MAX_BOXES) {
      var text = node.nodeValue || '';
      if (text.replace(/\s+/g, '') !== '') {
        var parent = node.parentElement;
        var hidden = false;
        try {
          hidden = parent !== null && parent.closest('script,style,noscript,template') !== null;
        } catch (error) {
          hidden = false;
        }
        if (!hidden) {
          try {
            var range = document.createRange();
            range.selectNodeContents(node);
            var rect = range.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < viewportBottom) {
              boxes.push({
                text: text.length > CAPTURE_MAX_TEXT ? text.slice(0, CAPTURE_MAX_TEXT) : text,
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height
              });
            }
          } catch (error) {
            /* detached node: skip */
          }
        }
      }
      node = walker.nextNode();
    }
    return boxes;
  }

  function collectHeadingBoxes() {
    var items = [];
    var nodes = [];
    try {
      nodes = document.body ? document.body.querySelectorAll('h1,h2,h3,h4,h5,h6') : [];
    } catch (error) {
      return items;
    }
    for (var i = 0; i < nodes.length && items.length < OUTLINE_MAX_ITEMS; i++) {
      var title = (nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (title === '') continue;
      var box = null;
      try {
        if (nodes[i].getClientRects().length === 0) continue;
        box = nodes[i].getBoundingClientRect();
      } catch (error) {
        continue;
      }
      if (box.width <= 0 || box.height <= 0) continue;
      items.push({
        title: title,
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height
      });
    }
    return items;
  }

  function capturePage() {
    if (!document.body) {
      post({ type: 'capture-failed', message: 'no-body' });
      return;
    }
    var payload = null;
    try {
      payload = buildCapturePayload();
    } catch (error) {
      post({ type: 'capture-failed', message: 'serialize' });
      return;
    }
    if (payload === null) {
      post({ type: 'capture-failed', message: 'too-large' });
      return;
    }
    post({ type: 'capture-result', payload: payload });
  }

  function buildCapturePayload() {
    var scroller = findScrollContainer();
    var root = document.documentElement;
    /* `documentElement` / `body` scrolling means "the whole page moved": send
       the body subtree and let the parent shift it. An inner scroller keeps its
       own geometry, so send that element and remember where it sits. */
    var elementMode = scroller !== root && scroller !== document.body;
    var html = elementMode ? cleanClone(scroller).outerHTML : captureHtml();
    if (html.length > CAPTURE_MAX_HTML) return null;

    var offsetLeft = 0;
    var offsetTop = 0;
    var stageWidth = root.clientWidth;
    if (elementMode) {
      var rect = scroller.getBoundingClientRect();
      offsetLeft = rect.left;
      offsetTop = rect.top;
      stageWidth = scroller.clientWidth;
    }

    return {
      html: html,
      css: collectCssText(),
      bodyStyle: bodyInlineStyle(),
      htmlAttrs: attrsOf(document.documentElement),
      bodyAttrs: attrsOf(document.body),
      width: root.clientWidth,
      height: root.clientHeight,
      stageWidth: stageWidth,
      scrollLeft: scroller.scrollLeft || 0,
      scrollTop: scroller.scrollTop || 0,
      offsetLeft: offsetLeft,
      offsetTop: offsetTop,
      dpr: window.devicePixelRatio || 1,
      boxes: collectTextBoxes(),
      headings: collectHeadingBoxes()
    };
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
    publishOutline();
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
    if (data.type === 'scroll-to-outline') {
      scrollToOutline(data.id);
      return;
    }
    if (data.type === 'capture') {
      capturePage();
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
     final tree and refreshes the outline against that final tree. */
  window.addEventListener('load', function () {
    window.setTimeout(function () {
      if (annotations.length > 0) applyAll();
      publishOutline();
    }, 60);
  }, { once: true });

  installStorageShim('localStorage');
  installStorageShim('sessionStorage');

  post({ type: 'ready', bridge: 4 });
}());
