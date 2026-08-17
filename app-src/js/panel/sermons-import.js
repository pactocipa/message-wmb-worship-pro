// ===== SERMON PDF IMPORT (William Marrion Branham sermons, "Grenier du Message" style) =====
//
// A sermon is stored using the exact same shape as a Bible chapter record
// ({ title, content, version, book, chapter }, see parseBible() in render-and-selection.js)
// so it reuses the Bible search/pagination/projection engine unchanged:
//   - book    = sermon title (e.g. "Crois Seulement")
//   - chapter = fixed "1" (a sermon has no chapters)
//   - content = "[Book 1]\nN paragraph text\nN paragraph text..." (N = paragraph number)
//
// This file only produces that data structure from PDF text. It does not touch
// bibles[]/IndexedDB directly — the caller (handleImport) is responsible for that,
// same as it already is for parseBible() output.

(function (root) {

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  var FRENCH_MONTHS = 'Janvier|F[ée]vrier|Mars|Avril|Mai|Juin|Juillet|Ao[uû]t|Septembre|Octobre|Novembre|D[ée]cembre';
  // Day number is optional: some cover pages only show "Novembre 1947" (no day). Some
  // batches instead use a purely numeric "DD.MM.YYYY" date (e.g. multi-part series like
  // "Questions et réponses sur les Hébreux").
  var DATE_LINE_RE = new RegExp(
    '(?:(?:\\d{1,2}\\s+)?(?:' + FRENCH_MONTHS + ')\\s+\\d{4})|(?:\\d{1,2}\\.\\d{1,2}\\.\\d{4})',
    'i'
  );
  // Some batches use a generic running header instead of the specific sermon title —
  // e.g. the series/compilation name ("LA PAROLE PARLÉE", "CONDUITE, ORDRE ET DOCTRINE
  // DE L'ÉGLISE"...), sometimes with letters spaced out oddly by the source PDF (e.g.
  // "L A PA ROLE PA RLÉE", "CONDU I TE"). Rather than hardcode every such phrase, treat
  // any "page number + long all-caps stretch" line as a running header: spoken sermon
  // prose is never all-caps for more than a couple of words, so this is a safe signal.
  var GENERIC_ALLCAPS_HEADER_RE = /^\s*\d{1,4}\s+[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ'’ ,.-]{8,}$/;
  // "Ce texte est la/une version française du Message..." appears (with minor wording
  // variants) across every batch observed so far; matching on the stable middle portion
  // is more robust than the opening words. Likewise the publisher/site markers vary by
  // batch (branham.fr, branham.ru, Shekinah...).
  var COLOPHON_MARKERS = [
    'version française du message',
    'ont été prêchés en anglais',
    'traduction française de ces messages',
    'shekinah publications',
    'shekinahgospelmissions',
    'www.branham.',
    'tous droits r',
    'voice of god recording',
    'all rights reserved',
    'veuillez adresser toute correspondance'
  ];

  // The cover page (title/subtitle/date/location + "William Marrion Branham" + a
  // repeated title block) is never more than a few dozen lines. Bounding the initial
  // "1 text" search to this window avoids latching onto an unrelated coincidental match
  // deep in the body — e.g. a Bible citation like "1 Corinthiens 12" — on sermons whose
  // paragraph numbering doesn't actually start at 1 (multi-part series).
  var FRONT_MATTER_SEARCH_WINDOW = 60;

  // Matches a paragraph-start line: a number, then either whitespace + text, or (some
  // batches glue them together) the text directly with no space at all — e.g. "307J'ai
  // dit...". The two-alternative form deliberately does NOT match a number immediately
  // followed by more digits ("3071958"): that's genuinely ambiguous (is it paragraph 307
  // followed by "1958...", or paragraph 3071 followed by "958..."?) and greedy digit
  // matching would silently guess wrong, so such lines are correctly left unmatched.
  // The zero-space alternative also requires the very next character to look like the
  // start of a real word (a letter or an opening quote), not arbitrary punctuation —
  // otherwise a purely numeric date like "02.10.1957" would wrongly match as "paragraph
  // 02" followed by ".10.1957". A third batch style numbers paragraphs "1.", "2." (period
  // then whitespace) rather than just a space — the period only counts when followed by
  // whitespace, so a decimal-looking "1.5" still doesn't match.
  var PARAGRAPH_LINE_RE = /^(\d{1,4})(?:\.\s+(\S.*)|\s+(\S.*)|([A-Za-zÀ-ÖØ-öø-ÿ«“‘'"(].*))$/;

  function matchParagraphLine(trimmed) {
    var m = trimmed.match(PARAGRAPH_LINE_RE);
    if (!m) return null;
    var text = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
    return { num: Number(m[1]), text: text };
  }

  function findFrontMatter(lines) {
    var bodyStartIndex = -1;
    var nonEmpty = [];
    var searchLimit = Math.min(lines.length, FRONT_MATTER_SEARCH_WINDOW);
    for (var i = 0; i < searchLimit; i += 1) {
      var trimmed = lines[i].trim();
      if (trimmed) nonEmpty.push({ index: i, text: trimmed });
      var tierOneMatch = trimmed && matchParagraphLine(trimmed);
      if (tierOneMatch && tierOneMatch.num === 1) {
        bodyStartIndex = i;
        break;
      }
    }

    // Multi-part sermons (e.g. "Questions et réponses sur les Hébreux, partie 2")
    // continue paragraph numbering from a previous part instead of restarting at 1, so
    // the search above never finds a "1 text" line. Anchor on "William Marrion Branham"
    // (present on every standard cover page, right after the title/date/location block)
    // and take whichever number the first paragraph after it actually starts with.
    var startNumberOverride = null;
    if (bodyStartIndex === -1) {
      var wmbIndex = -1;
      for (var w = 0; w < searchLimit; w += 1) {
        if (lines[w].trim().toLowerCase() === 'william marrion branham') { wmbIndex = w; break; }
      }
      if (wmbIndex !== -1) {
        for (var j = wmbIndex + 1; j < lines.length; j += 1) {
          var t4 = lines[j].trim();
          if (!t4) continue;
          var startMatch = matchParagraphLine(t4);
          if (startMatch) {
            bodyStartIndex = j;
            startNumberOverride = startMatch.num;
            break;
          }
        }
      }
    }

    var frontLines = nonEmpty
      .filter(function (e) { return bodyStartIndex === -1 || e.index < bodyStartIndex; })
      .map(function (e) { return e.text; });
    var withoutMarker = frontLines.filter(function (t) { return t.toLowerCase() !== 'la parole parlée'; });

    var date = '';
    var location = '';
    var dateEntry = frontLines.filter(function (t) { return DATE_LINE_RE.test(t); })[0];
    if (dateEntry) {
      var m = dateEntry.match(DATE_LINE_RE);
      date = m ? m[0] : dateEntry;
      var dateLineIdx = frontLines.indexOf(dateEntry);
      location = frontLines[dateLineIdx + 1] || '';
    }

    // Title = everything before the subtitle line; subtitle = the line right before the
    // date line. This correctly joins titles that wrap across 2+ physical lines (long
    // titles like "QUESTIONS ET RÉPONSES SUR LES" / "HÉBREUX, PARTIE 2"), while producing
    // the exact same result as the old "first line / second line" heuristic whenever the
    // title happens to fit on a single line.
    var title, subtitle;
    var dateIdxInWithoutMarker = dateEntry ? withoutMarker.indexOf(dateEntry) : -1;
    if (dateIdxInWithoutMarker >= 2) {
      subtitle = withoutMarker[dateIdxInWithoutMarker - 1];
      title = withoutMarker.slice(0, dateIdxInWithoutMarker - 1).join(' ');
    } else {
      title = withoutMarker[0] || '';
      subtitle = withoutMarker[1] || '';
    }

    return {
      title: title,
      subtitle: subtitle,
      date: date,
      location: location,
      bodyStartIndex: bodyStartIndex,
      startNumberOverride: startNumberOverride
    };
  }

  // Some sermons have no structured cover page at all (no "1 text", no "William Marrion
  // Branham" marker to anchor on) — e.g. the first paragraph is left unnumbered, or
  // numbering continues from an earlier part with no reliable anchor nearby. General
  // fix: scan the whole document for numbered-line candidates and find the LONGEST run
  // of numbers that only ever increase (allowing small forward gaps — some source PDFs
  // skip a number here and there, e.g. "...1. ...3. ...4. ...6...", apparently an
  // artifact of the original transcript/editing, not our extraction). A long run is
  // still an extremely strong signal of genuine paragraph markers — a coincidental
  // number in body text (a citation, an age, a date) essentially never happens to be
  // followed by several more lines each starting with an increasing integer, so this
  // avoids false positives without needing to special-case every cover-page template.
  var MIN_SEQUENCE_RUN_LENGTH = 5;
  var MAX_FORWARD_GAP = 10;

  function findLongestConsecutiveRun(lines, fromIndex) {
    var candidates = [];
    for (var i = fromIndex; i < lines.length; i += 1) {
      var t = lines[i].trim();
      if (!t) continue;
      // A running page header ("198 L'ÉPÎTRE AUX HÉBREUX") also starts with a number —
      // without skipping it here, it interrupts the real sequence on every single page
      // (num+1 fails against the header's page number), fragmenting one long run of
      // genuine paragraph markers into many short, spurious ones.
      if (GENERIC_ALLCAPS_HEADER_RE.test(t)) continue;
      var match = matchParagraphLine(t);
      if (match) candidates.push({ index: i, num: match.num });
    }
    var best = null;
    var p = 0;
    while (p < candidates.length) {
      var start = p;
      var end = p;
      while (
        end + 1 < candidates.length &&
        candidates[end + 1].num > candidates[end].num &&
        candidates[end + 1].num - candidates[end].num <= MAX_FORWARD_GAP
      ) {
        end += 1;
      }
      var length = end - start + 1;
      if (!best || length > best.length) best = { start: start, end: end, length: length };
      p = end + 1;
    }
    if (!best || best.length < MIN_SEQUENCE_RUN_LENGTH) return null;
    return { index: candidates[best.start].index, num: candidates[best.start].num };
  }

  function findBodyStartFallback(lines) {
    var titleLineIndex = -1;
    for (var i = 0; i < lines.length; i += 1) {
      if (lines[i].trim()) { titleLineIndex = i; break; }
    }
    if (titleLineIndex === -1) return null;
    var run = findLongestConsecutiveRun(lines, titleLineIndex + 1);
    if (!run) return null;
    return { titleLineIndex: titleLineIndex, firstNumberedIndex: run.index, firstNumber: run.num };
  }

  // pages: array of strings, one per PDF page, lines separated by '\n'.
  // opts.book: override the detected sermon title (used as the "book" name).
  // Some batches prepend a standalone copyright-notice page before the actual sermon
  // cover page ("Avis de droit d'auteur... Voice Of God Recordings... www.branham.org").
  // If present, that block's own opening line would otherwise get mistaken for the
  // sermon title. Detect it near the very start and skip past it (up to and including
  // its closing website line) before any front-matter/title detection runs.
  var COPYRIGHT_PREAMBLE_START_RE = /droit d.auteur|tous droits r[ée]serv[ée]s|copyright notice/i;
  var COPYRIGHT_PREAMBLE_END_RE = /^\s*www\.branham/i;

  function skipCopyrightPreamble(lines) {
    // Some source PDFs have a run of entirely empty leading pages (a known artifact of
    // at least one file seen so far) before any real content — search for the first
    // non-blank line without an arbitrary window limit, however far down it is.
    var firstNonEmpty = -1;
    for (var i = 0; i < lines.length; i += 1) {
      if (lines[i].trim()) { firstNonEmpty = i; break; }
    }
    if (firstNonEmpty === -1 || !COPYRIGHT_PREAMBLE_START_RE.test(lines[firstNonEmpty])) return lines;
    for (var j = firstNonEmpty + 1; j < Math.min(lines.length, firstNonEmpty + 40); j += 1) {
      if (COPYRIGHT_PREAMBLE_END_RE.test(lines[j])) {
        return lines.slice(j + 1);
      }
    }
    return lines;
  }

  function parseSermonPdfPages(pages, opts) {
    opts = opts || {};
    var lines = [];
    (pages || []).forEach(function (p) {
      Array.prototype.push.apply(lines, String(p || '').split('\n'));
    });
    lines = skipCopyrightPreamble(lines);

    var front = findFrontMatter(lines);
    var synthesizedFirstParagraphText = '';
    var synthesizedFirstParagraphNumber = 1;
    var usedFallback = false;

    var usedWholeTextFallback = false;
    if (front.bodyStartIndex === -1) {
      var fallback = findBodyStartFallback(lines);
      if (!fallback) {
        // Last resort: no paragraph numbering detected at all (e.g. a running
        // commentary series transcribed without numbered paragraphs). Keep the
        // whole sermon as a single unnumbered paragraph rather than dropping it.
        var titleLineIdx = lines.findIndex(function (l) { return l.trim(); });
        if (titleLineIdx === -1) {
          var bookNoBody = (opts.book || front.title || 'Sermon').trim();
          return {
            book: bookNoBody, chapter: '1', content: '', title: bookNoBody + ' 1',
            meta: front, paragraphCount: 0, warning: 'no_paragraph_1_found'
          };
        }
        usedWholeTextFallback = true;
        var wholeTextLines = [];
        for (var w = titleLineIdx + 1; w < lines.length; w += 1) {
          var wt = lines[w].trim();
          if (!wt) continue;
          var wLower = wt.toLowerCase();
          if (COLOPHON_MARKERS.some(function (marker) { return wLower.indexOf(marker) !== -1; })) break;
          wholeTextLines.push(wt);
        }
        front = { title: lines[titleLineIdx].trim(), subtitle: '', date: '', location: '', bodyStartIndex: lines.length };
        synthesizedFirstParagraphText = wholeTextLines.join(' ');
        usedFallback = true;
      } else {
      usedFallback = true;
      var firstParaLines = [];
      for (var k = fallback.titleLineIndex + 1; k < fallback.firstNumberedIndex; k += 1) {
        var t = lines[k].trim();
        if (t) firstParaLines.push(t);
      }
      synthesizedFirstParagraphText = firstParaLines.join(' ');
      synthesizedFirstParagraphNumber = fallback.firstNumber - 1;
      front = {
        title: lines[fallback.titleLineIndex].trim(),
        subtitle: '',
        date: '',
        location: '',
        bodyStartIndex: fallback.firstNumberedIndex
      };
      }
    }

    var book = (opts.book || front.title || 'Sermon').trim();

    var headerNoiseRe = front.title
      ? new RegExp('^\\s*\\d{1,4}\\s+' + escapeRegExp(front.title.toUpperCase()) + '\\s*$', 'i')
      : null;
    // The date/location running footer sometimes has "à" between the two ("...1961 à
    // Chicago...") and sometimes just juxtaposes them with no connector at all
    // ("13.08.1961 JEFFERSONVILLE, IN, USA 5") — make the connector optional.
    var footerNoiseRe = (front.date && front.location)
      ? new RegExp('^\\s*' + escapeRegExp(front.date) + '\\s+(?:\\u00e0\\s+)?' + escapeRegExp(front.location) + '\\s*\\d*\\s*$', 'i')
      : null;
    // The back cover repeats the title/subtitle centered, with no leading page number.
    // Allows trailing stray characters glued onto the end (\S*) because some batches
    // append junk to this repeated line (e.g. "...On Hebrews #2TT"), and allows the
    // whole thing to be wrapped in parentheses ("(Faith)"), which some batches use for
    // the repeated subtitle specifically.
    var bareTitleRe = front.title
      ? new RegExp('^\\s*\\(?' + escapeRegExp(front.title) + '\\)?\\S*\\s*$', 'i')
      : null;
    var bareSubtitleRe = front.subtitle
      ? new RegExp('^\\s*\\(?' + escapeRegExp(front.subtitle) + '\\)?\\S*\\s*$', 'i')
      : null;

    var paragraphs = [];
    var current = null;
    var expected = (front.startNumberOverride != null) ? front.startNumberOverride : 1;
    var stopped = false;

    if (usedFallback && synthesizedFirstParagraphText) {
      current = { num: synthesizedFirstParagraphNumber, text: synthesizedFirstParagraphText };
      expected = synthesizedFirstParagraphNumber + 1;
    }

    for (var i = front.bodyStartIndex; i < lines.length; i += 1) {
      var trimmed = lines[i].trim();
      if (!trimmed) continue;

      var lower = trimmed.toLowerCase();
      if (COLOPHON_MARKERS.some(function (marker) { return lower.indexOf(marker) !== -1; })) {
        stopped = true;
        break;
      }
      if (headerNoiseRe && headerNoiseRe.test(trimmed)) continue;
      if (GENERIC_ALLCAPS_HEADER_RE.test(trimmed)) continue;
      if (footerNoiseRe && footerNoiseRe.test(trimmed)) continue;
      if (bareTitleRe && bareTitleRe.test(trimmed)) continue;
      if (bareSubtitleRe && bareSubtitleRe.test(trimmed)) continue;

      // Accept small forward gaps (the source itself sometimes skips a number, e.g.
      // "...1. ...3. ...4. ...6..."), but never a repeat or a backward/out-of-range
      // number — that's what actually protects against false positives like a stray
      // "1 Corinthiens 12" citation mid-paragraph.
      var m = matchParagraphLine(trimmed);
      if (m && m.num >= expected && m.num - expected <= MAX_FORWARD_GAP) {
        if (current) paragraphs.push(current);
        current = { num: m.num, text: m.text };
        expected = m.num + 1;
      } else if (current) {
        current.text += ' ' + trimmed;
      }
    }
    if (current) paragraphs.push(current);

    var content = '[' + book + ' 1]\n' +
      paragraphs.map(function (p) { return p.num + ' ' + p.text; }).join('\n') + '\n';

    return {
      title: book + ' 1',
      book: book,
      chapter: '1',
      content: content,
      meta: front,
      paragraphCount: paragraphs.length,
      firstParagraph: paragraphs[0] || null,
      lastParagraph: paragraphs[paragraphs.length - 1] || null,
      stoppedAtColophon: stopped,
      usedFallback: usedFallback,
      usedWholeTextFallback: usedWholeTextFallback
    };
  }

  // Extracts per-page text (line-broken) from a PDF ArrayBuffer using pdf.js.
  // Requires assets/vendor/pdfjs/pdf.min.js + pdf.worker.min.js to be loaded
  // (see Bible Song Pro panel.html), which exposes the global `pdfjsLib`.
  async function extractPdfPageTexts(arrayBuffer) {
    if (!root.pdfjsLib) throw new Error('pdfjsLib is not loaded (assets/vendor/pdfjs/pdf.min.js missing?)');
    var loadingTask = root.pdfjsLib.getDocument({ data: arrayBuffer });
    var pdf = await loadingTask.promise;
    var pages = [];
    for (var i = 1; i <= pdf.numPages; i += 1) {
      var page = await pdf.getPage(i);
      var textContent = await page.getTextContent();
      var lineText = '';
      var lines = [];
      textContent.items.forEach(function (item) {
        lineText += item.str;
        if (item.hasEOL) {
          lines.push(lineText);
          lineText = '';
        }
      });
      if (lineText) lines.push(lineText);
      pages.push(lines.join('\n'));
    }
    return pages;
  }

  // High-level helper used by handleImport(): PDF File -> parsed sermon record.
  async function parseSermonPdfFile(file, opts) {
    var arrayBuffer = await file.arrayBuffer();
    var pages = await extractPdfPageTexts(arrayBuffer);
    return parseSermonPdfPages(pages, opts);
  }

  root.parseSermonPdfPages = parseSermonPdfPages;
  root.extractPdfPageTexts = extractPdfPageTexts;
  root.parseSermonPdfFile = parseSermonPdfFile;

  // Allow Node-based testing of the pure text parser without touching pdf.js/DOM.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseSermonPdfPages: parseSermonPdfPages, findFrontMatter: findFrontMatter };
  }

})(typeof window !== 'undefined' ? window : this);
