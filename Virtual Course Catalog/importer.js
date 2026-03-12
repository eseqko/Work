/* ═══════════════════════════════════════════
   CatalogImporter — file parsing module
   Extracts text from .docx/.pdf/.md/.txt
   and heuristically parses course data.
═══════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── CDN URLs for lazy-loaded libs ── */
  const MAMMOTH_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js';
  const PDFJS_CDN   = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';

  let mammothLoaded = false;
  let pdfjsLoaded   = false;

  /* ── Lazy-load helper ── */
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = url;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + url));
      document.head.appendChild(s);
    });
  }

  async function loadESModule(url) {
    return await import(url);
  }

  /* ═══════════════════════════════════════
     TEXT EXTRACTION
  ═══════════════════════════════════════ */
  async function extractText(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    switch (ext) {
      case 'txt': case 'text': case 'md':
        return await readAsText(file);
      case 'docx':
        return await extractDocx(file);
      case 'pdf':
        return await extractPdf(file);
      default:
        throw new Error('Unsupported file type: .' + ext);
    }
  }

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsText(file);
    });
  }

  async function extractDocx(file) {
    if (!mammothLoaded) {
      await loadScript(MAMMOTH_CDN);
      mammothLoaded = true;
    }
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }

  async function extractPdf(file) {
    if (!pdfjsLoaded) {
      try {
        const pdfjs = await loadESModule(PDFJS_CDN);
        window.pdfjsLib = pdfjs;
        // Set worker to use bundled worker
        if (pdfjs.GlobalWorkerOptions) {
          pdfjs.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
        }
        pdfjsLoaded = true;
      } catch {
        // Fallback: try loading as regular script
        await loadScript(
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
        );
        if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
        pdfjsLoaded = true;
      }
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str).join(' ');
      pages.push(text);
    }
    return pages.join('\n\n');
  }

  /* ═══════════════════════════════════════
     HEURISTIC PARSER
     Attempts to extract structured course
     data from raw text.
  ═══════════════════════════════════════ */
  function heuristicParse(text) {
    // Try table-marker format first (like catalog_raw.txt)
    let courses = parseTableMarkerFormat(text);
    if (courses.length > 0) return courses;

    // Fallback: try generic line-by-line parsing
    courses = parseGenericFormat(text);
    return courses;
  }

  /* ── Parser: TABLE marker format ──
     Matches: --- TABLE N --- ... --- END TABLE N --- */
  function parseTableMarkerFormat(text) {
    const courses = [];
    const tableRegex = /---\s*TABLE\s+(\d+)\s*---\s*\n([\s\S]*?)---\s*END\s+TABLE\s+\1\s*---/gi;
    let match;

    while ((match = tableRegex.exec(text)) !== null) {
      const block = match[2].trim();
      const course = parseTableBlock(block);
      if (course && course.name) {
        course.id = 'tbl' + match[1];
        courses.push(course);
      }
    }
    return courses;
  }

  function parseTableBlock(block) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;

    const course = {
      name: '', dept: 'electives', grade: '', credits: '',
      ag: '', type: 'cp', code: '', prereq: '', desc: ''
    };

    // First line: typically course name (repeated in columns)
    const firstParts = lines[0].split('|').map(s => s.trim());
    course.name = firstParts[0] || '';

    // Determine type from name
    if (/\bAP\b/i.test(course.name)) course.type = 'ap';
    else if (/\bELD\b|\bELA\b/i.test(course.name)) course.type = 'eld';

    // Scan remaining lines for structured fields
    const fullText = block;

    // Grade
    const gradeMatch = fullText.match(/Grade:\s*([\d\-]+)/i);
    if (gradeMatch) course.grade = gradeMatch[1];

    // Credits
    const credMatch = fullText.match(/Credits?:\s*(\d+)\s*credits?\s*total/i) ||
                      fullText.match(/(\d+)\s*credits?\s*total/i);
    if (credMatch) course.credits = credMatch[1];

    // Course ID
    const idMatch = fullText.match(/Course\s*ID:\s*([\d\/\-]+)/i);
    if (idMatch) course.code = idMatch[1];

    // Prerequisites
    const preMatch = fullText.match(/Prerequisites?:\s*([^\n|]+)/i);
    if (preMatch) course.prereq = preMatch[1].trim();

    // a-g area
    const agMatch = fullText.match(/(?:requirement|requirements|area)\s*"?([a-g])"?/i) ||
                    fullText.match(/Area\s*"([a-g])"/i);
    if (agMatch) course.ag = agMatch[1].toLowerCase();

    // Department detection from name keywords
    course.dept = guessDepartment(course.name, fullText);

    // Description: grab the last long block of text
    const descLines = lines.filter(l =>
      !l.includes('|') && l.length > 60 && !/^(Grade|Credits?|Course\s*ID|Prerequisites?)/i.test(l)
    );
    if (descLines.length) course.desc = descLines.join(' ').trim();

    return course;
  }

  /* ── Parser: Generic line-by-line format ──
     Looks for course-like patterns in plain text */
  function parseGenericFormat(text) {
    const courses = [];
    const lines = text.split('\n');
    let currentDept = 'electives';
    let i = 0;

    // Detect department headers
    const deptPatterns = [
      { re: /social\s*science|history/i, dept: 'social-science' },
      { re: /^english\b|language\s*arts/i, dept: 'english' },
      { re: /math/i, dept: 'mathematics' },
      { re: /science|biology|chemistry|physics/i, dept: 'science' },
      { re: /world\s*language|lote|spanish|french|filipino/i, dept: 'lote' },
      { re: /visual|performing|arts|music|drama|theater/i, dept: 'vpa' },
      { re: /career|technical|cte/i, dept: 'cte' },
      { re: /physical\s*education|pe\s*&|health/i, dept: 'pe' },
      { re: /special\s*ed/i, dept: 'special-ed' },
    ];

    while (i < lines.length) {
      const line = lines[i].trim();

      // Check for department header
      for (const dp of deptPatterns) {
        if (dp.re.test(line) && line.length < 60 && /^[A-Z\s&\/]+$/.test(line.replace(/[^a-zA-Z\s&\/]/g, ''))) {
          currentDept = dp.dept;
        }
      }

      // Heuristic: a line that looks like a course title
      // (mostly uppercase, reasonable length, not a header/section)
      if (line.length >= 5 && line.length <= 100 &&
          /^[A-Z]/.test(line) &&
          (line === line.toUpperCase() || /\b(CP|AP|ELD|Honors)\b/i.test(line)) &&
          !/^(DEPARTMENT|TABLE|NOTE|PAGE|SECTION|CHAPTER)/i.test(line)) {

        // Check if next lines have grade/credit info
        const context = lines.slice(i, Math.min(i + 8, lines.length)).join('\n');
        const hasGrade = /Grade:\s*[\d\-]/i.test(context) || /grade\s*(?:level)?s?:\s*[\d\-]/i.test(context);
        const hasCredit = /credit/i.test(context);

        if (hasGrade || hasCredit) {
          const course = {
            id: 'gen' + (courses.length + 1),
            name: toTitleCase(line.replace(/\|.*/g, '').trim()),
            dept: currentDept,
            grade: '', credits: '', ag: '', type: 'cp',
            code: '', prereq: '', desc: ''
          };

          // Extract from context
          const gradeM = context.match(/Grade:\s*([\d\-]+)/i);
          if (gradeM) course.grade = gradeM[1];

          const credM = context.match(/(\d+)\s*credits?\s*total/i);
          if (credM) course.credits = credM[1];

          const agM = context.match(/(?:requirement|area)\s*"?([a-g])"?/i);
          if (agM) course.ag = agM[1].toLowerCase();

          if (/\bAP\b/.test(line)) course.type = 'ap';
          else if (/\bELD\b|\bELA\b/i.test(line)) course.type = 'eld';

          course.dept = guessDepartment(course.name, context) || currentDept;

          courses.push(course);
          i += 4; // skip past the data lines
          continue;
        }
      }
      i++;
    }

    return courses;
  }

  /* ── Helpers ── */
  function guessDepartment(name, context) {
    const text = (name + ' ' + (context || '')).toLowerCase();
    if (/world\s*history|us\s*history|government|economics|sociology|political/i.test(text)) return 'social-science';
    if (/\benglish\b|literature|composition|creative\s*writing|journalism|esl\b/i.test(text)) return 'english';
    if (/\bmath\b|algebra|geometry|calculus|trigonometry|statistics|precalculus/i.test(text)) return 'mathematics';
    if (/biology|chemistry|physics|anatomy|physiology|environmental\s*sci|earth\s*sci/i.test(text)) return 'science';
    if (/spanish|french|filipino|mandarin|japanese|german|italian|chinese|latin\b|lote/i.test(text)) return 'lote';
    if (/\bart\b|ceramics|sculpture|band|orchestra|choir|drama|theater|dance|guitar|piano|music|digital\s*art|fashion|photography/i.test(text)) return 'vpa';
    if (/cte\b|business|marketing|engineering|culinary|automotive|construction|medical|health\s*career|computer\s*science|web\s*design/i.test(text)) return 'cte';
    if (/physical\s*ed|weight|fitness|yoga|swim|team\s*sport|health\b/i.test(text)) return 'pe';
    if (/special\s*ed|iep\b|seminar|resource|sdc\b/i.test(text)) return 'special-ed';
    return 'electives';
  }

  function toTitleCase(s) {
    const lowers = ['a','an','and','as','at','but','by','for','in','of','on','or','the','to','with'];
    return s.toLowerCase().split(/\s+/).map((w, i) =>
      (i === 0 || !lowers.includes(w)) ? w.charAt(0).toUpperCase() + w.slice(1) : w
    ).join(' ');
  }

  /* ═══════════════════════════════════════
     PLUGGABLE AI PARSER SLOT
     For future Claude API integration
  ═══════════════════════════════════════ */
  let aiParserFn = null;

  function setAIParser(fn) {
    aiParserFn = fn;
  }

  async function aiParse(text) {
    if (!aiParserFn) throw new Error('No AI parser configured');
    return await aiParserFn(text);
  }

  /* ═══════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════ */
  window.CatalogImporter = {
    extractText,
    heuristicParse,
    setAIParser,
    aiParse,
    // Expose sub-parsers for testing
    _parseTableMarkerFormat: parseTableMarkerFormat,
    _parseGenericFormat: parseGenericFormat
  };
})();
