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
    if (courses.length > 0) {
      // Cross-reference with brief course listing to fill in missing codes
      const codeLookup = buildCodeLookup(text);
      for (const c of courses) {
        if (!c.code && codeLookup[c.name.toUpperCase()]) {
          c.code = codeLookup[c.name.toUpperCase()];
        }
      }
      return courses;
    }

    // Fallback: try generic line-by-line parsing
    courses = parseGenericFormat(text);
    return courses;
  }

  /** Build a name→code lookup from brief course listings like "20011\tAmerican Government CP" */
  function buildCodeLookup(text) {
    const lookup = {};
    const lines = text.split('\n');
    for (const line of lines) {
      // Match patterns like: 20011\tAmerican Government CP  or  21000/21001  English 9 CP
      const m = line.match(/^\s*([\d\/]+)\s+(.+?)$/);
      if (m) {
        const code = m[1].trim();
        const name = m[2].replace(/\s+/g, ' ').trim().toUpperCase();
        if (/^\d{4,}/.test(code) && name.length > 3) {
          lookup[name] = code;
        }
      }
    }
    return lookup;
  }

  /* ── Parser: TABLE marker format ──
     Matches: --- TABLE N --- ... --- END TABLE N --- */
  function parseTableMarkerFormat(text) {
    const courses = [];
    const tableRegex = /---\s*TABLE\s+(\d+)\s*---\s*\n([\s\S]*?)---\s*END\s+TABLE\s+\1\s*---/gi;
    let match;

    while ((match = tableRegex.exec(text)) !== null) {
      const block = match[2].trim();
      // Skip informational tables (no Grade/Credits/Course ID = not a course)
      if (!/Grade:|Credits?:|Course\s*ID:/i.test(block)) continue;
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

    // a-g area (handle smart/curly quotes: \u201c \u201d and straight quotes)
    const agMatch = fullText.match(/(?:requirement|requirements|area)\s*["\u201c\u201d]?([a-g])["\u201c\u201d]?/i) ||
                    fullText.match(/Area\s*["\u201c\u201d]([a-g])["\u201c\u201d]/i);
    if (agMatch) course.ag = agMatch[1].toLowerCase();

    // Department detection from name keywords
    course.dept = guessDepartment(course.name, fullText);

    // Description: look for long text in the block
    // In pipe-delimited formats, the description is often the last line, repeated across columns
    const descCandidates = [];
    for (const l of lines) {
      // Skip structured field lines
      if (/^(Grade|Credits?|Course\s*ID|Prerequisites?)/i.test(l)) continue;
      // Skip the title line (first line)
      if (l === lines[0]) continue;
      // For pipe-delimited lines, take the first column
      const col = l.includes('|') ? l.split('|')[0].trim() : l.trim();
      // Accept lines that look like descriptions (long enough, not a field label)
      if (col.length > 80 && !/^(Grade|Credits?|Course\s*ID|Prerequisites?|Meets\s|May\s|Course\s*(Page|Slide))/i.test(col)) {
        descCandidates.push(col);
      }
    }
    if (descCandidates.length) course.desc = descCandidates.join(' ').trim();

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
     AI PARSER — Claude API integration
  ═══════════════════════════════════════ */
  const API_KEY_LS = 'catalog_ai_api_key';
  const API_MODEL_LS = 'catalog_ai_model';

  const COURSE_SCHEMA_PROMPT = `You are a course catalog parser. Extract structured course data from the provided text.

Return ONLY a JSON array (no markdown fences, no explanation). Each object must have these fields:
- "name": string — course title in Title Case
- "dept": string — one of: social-science, english, mathematics, science, lote, vpa, cte, pe, electives, special-ed
- "grade": string — grade levels (e.g. "9-12", "10", "11-12")
- "credits": string — total credits (e.g. "10", "5")
- "ag": string — UC/CSU a-g area letter (a-g) or "" if none
- "type": string — one of: ap, cp, eld, sp
- "code": string — course ID/code if found, or ""
- "prereq": string — prerequisites text, or "None"
- "desc": string — course description (2-4 sentences). IMPORTANT: extract the FULL description from the text, do not abbreviate or summarize.

IMPORTANT extraction priorities:
1. Look for detailed course description sections (often in tables or repeated columns). These contain Course IDs, grade levels, credits, a-g areas, prerequisites, AND full descriptions. ALWAYS prefer these detailed sections over brief course listings.
2. Course codes/IDs are numeric identifiers like "20011", "21000/21001", "23100/23101". They are NOT optional — extract them when present.
3. Descriptions are the paragraph-length text explaining what students learn in the course. They are usually the longest text block for each course entry. Extract the FULL description, not just the first sentence.
4. If the same course appears in both a brief listing and a detailed description section, merge the data — use the code from the listing and the description from the detailed section.

Department mapping guide:
- social-science: history, government, economics, psychology, sociology
- english: English, literature, writing, journalism, ELD/ESL
- mathematics: math, algebra, geometry, calculus, statistics
- science: biology, chemistry, physics, anatomy, environmental science
- lote: Spanish, French, Filipino, Mandarin, other world languages
- vpa: art, music, band, choir, drama, theater, dance, ceramics
- cte: career/technical education, business, engineering, culinary, computer science
- pe: physical education, health, fitness, sports
- electives: interdisciplinary electives, film studies, robotics, data science
- special-ed: special education, IEP-based courses, study skills, tutorials

Type mapping: AP courses = "ap", ELD/ELA courses = "eld", Special Ed = "sp", everything else = "cp"

Parse ALL courses you can find. If a field is unclear, use your best judgment.`;

  function getApiKey() {
    return localStorage.getItem(API_KEY_LS) || '';
  }

  function setApiKey(key) {
    // Reject masked/non-ASCII values to prevent fetch header errors
    if (key && /^[\x20-\x7E]+$/.test(key)) localStorage.setItem(API_KEY_LS, key);
    else if (!key) localStorage.removeItem(API_KEY_LS);
  }

  function getApiModel() {
    return localStorage.getItem(API_MODEL_LS) || 'claude-sonnet-4-6';
  }

  function setApiModel(model) {
    localStorage.setItem(API_MODEL_LS, model);
  }

  async function aiParse(text, onProgress) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('No API key configured. Add your Anthropic API key first.');

    const model = getApiModel();

    // Truncate very long texts to stay within token limits
    const maxChars = 400000;
    let inputText = text;
    if (inputText.length > maxChars) {
      inputText = inputText.substring(0, maxChars);
      if (onProgress) onProgress('Text truncated to ' + maxChars.toLocaleString() + ' chars for API limits.');
    }

    if (onProgress) onProgress('Sending to Claude (' + model + ')... this may take 30-60 seconds for large catalogs.');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 64000,
        messages: [{
          role: 'user',
          content: COURSE_SCHEMA_PROMPT + '\n\n--- BEGIN CATALOG TEXT ---\n' + inputText + '\n--- END CATALOG TEXT ---'
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error('Invalid API key. Check your Anthropic API key.');
      if (response.status === 429) throw new Error('Rate limited. Wait a moment and try again.');
      throw new Error('API error (' + response.status + '): ' + (err.error?.message || 'Unknown error'));
    }

    const data = await response.json();

    // Debug: log entire response structure
    console.log('AI response structure:', {
      stop_reason: data.stop_reason,
      content_blocks: data.content?.length,
      types: data.content?.map(b => b.type),
      usage: data.usage
    });

    // Try all text content blocks, not just the first
    let content = '';
    if (Array.isArray(data.content)) {
      content = data.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
    const stopReason = data.stop_reason;

    if (!content) {
      console.error('AI response had no text content. Full response:', JSON.stringify(data).substring(0, 2000));
      throw new Error('AI returned an empty response (stop_reason: ' + stopReason +
        '). This may mean the input was too large or the model refused. Try a smaller file.');
    }

    if (onProgress) onProgress('Parsing ' + content.length + ' chars of response (stop: ' + stopReason + ')...');

    // Extract JSON array from response
    let jsonStr = content.trim();

    // Strip markdown fences — try multiple patterns
    // Pattern 1: standard ```json ... ``` block
    let fenceMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]+)\n\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    } else {
      // Pattern 2: fences without trailing newline (e.g. ```json[...]```)
      fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]+?)```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();
    }

    // Find the JSON array
    let arrStart = jsonStr.indexOf('[');
    if (arrStart === -1) {
      // Log full response for debugging
      console.error('AI response (no JSON array found):', content);
      throw new Error('AI response did not contain a JSON array (' + content.length +
        ' chars received, stop_reason: ' + stopReason +
        '). Check browser console for full response. Preview: "' +
        content.substring(0, 300).replace(/\n/g, ' ') + '"');
    }

    let arrEnd = jsonStr.lastIndexOf(']');
    let truncated = false;

    // If response was truncated (hit max_tokens), the JSON is incomplete
    if (arrEnd === -1 || (stopReason === 'max_tokens' && arrEnd < jsonStr.length - 5)) {
      truncated = true;
      // Try to recover: find the last complete object by finding the last "},"
      const lastComplete = jsonStr.lastIndexOf('},');
      if (lastComplete > arrStart) {
        jsonStr = jsonStr.substring(arrStart, lastComplete + 1) + ']';
      } else {
        const lastObj = jsonStr.lastIndexOf('}');
        if (lastObj > arrStart) {
          jsonStr = jsonStr.substring(arrStart, lastObj + 1) + ']';
        } else {
          throw new Error('AI response was truncated and could not be recovered. Try a smaller catalog or use Heuristic parsing.');
        }
      }
    } else {
      jsonStr = jsonStr.substring(arrStart, arrEnd + 1);
    }

    let courses;
    try {
      courses = JSON.parse(jsonStr);
    } catch (e) {
      // One more attempt: try to fix common trailing issues
      try {
        // Remove trailing comma before ]
        const fixed = jsonStr.replace(/,\s*\]$/, ']');
        courses = JSON.parse(fixed);
      } catch {
        throw new Error('Failed to parse AI response as JSON. ' +
          (truncated ? 'Response was truncated — try a smaller file or Heuristic parsing.' : e.message));
      }
    }

    if (!Array.isArray(courses)) throw new Error('AI response was not an array.');

    if (truncated && onProgress) {
      onProgress('Note: Response was truncated. Recovered ' + courses.length + ' courses — some may be missing.');
    }

    // Validate and normalize each course
    const validDepts = ['social-science','english','mathematics','science','lote','vpa','cte','pe','electives','special-ed'];
    const validTypes = ['ap','cp','eld','sp'];

    return courses.map((c, i) => ({
      id: 'ai' + (i + 1),
      name: String(c.name || '').trim(),
      dept: validDepts.includes(c.dept) ? c.dept : guessDepartment(c.name || '', c.desc || ''),
      grade: String(c.grade || '').trim(),
      credits: String(c.credits || '10').trim(),
      ag: String(c.ag || '').trim().toLowerCase(),
      type: validTypes.includes(c.type) ? c.type : 'cp',
      code: String(c.code || '').trim(),
      prereq: String(c.prereq || 'None').trim(),
      desc: String(c.desc || '').trim()
    })).filter(c => c.name);
  }

  /* ═══════════════════════════════════════
     INFO PAGE PARSER
     Extracts graduation requirements,
     four-year plan, a-g list, counselors,
     post-secondary, NCAA, scheduling
  ═══════════════════════════════════════ */
  function parseInfoPages(text) {
    const info = {};
    const tableRegex = /---\s*TABLE\s+(\d+)\s*---\s*\n([\s\S]*?)---\s*END\s+TABLE\s+\1\s*---/gi;
    let match;

    // Collect all non-course TABLE blocks (ones without Grade:/Credits:/Course ID:)
    const infoBlocks = [];
    while ((match = tableRegex.exec(text)) !== null) {
      const block = match[2].trim();
      if (!/Grade:|Credits?:|Course\s*ID:/i.test(block)) {
        infoBlocks.push({ num: parseInt(match[1]), block });
      }
    }

    // Classify and parse each info block
    for (const { block } of infoBlocks) {
      const firstLine = block.split('\n')[0].trim();

      // Graduation requirements table: starts with "a-g" header row
      if (/[""\u201c]?a-g[""\u201d]?/i.test(firstLine) && /Subject/i.test(firstLine)) {
        info.gradReqs = parseGradReqsBlock(block);
      }
      // Four-year plan: starts with "9th Grade"
      else if (/^9th\s*Grade/i.test(firstLine)) {
        info.fourYear = parseFourYearBlock(block);
      }
      // a-g list: starts with "History/Social Science" and has a-g area headers
      else if (/History.*Social\s*Science/i.test(firstLine) && /\b[b-g]\.\s/m.test(block)) {
        info.agList = parseAgListBlock(block);
      }
      // Counselors: lines with phone numbers and emails
      else if (/@/.test(block) && /\(\d{3}\)\s*\d{3}[\-\s]\d{4}|\d{3}-\d{3}-\d{4}/.test(block)) {
        info.counselors = parseCounselorsBlock(block);
      }
    }

    // Parse non-table text sections
    const postSec = parsePostSecondary(text);
    if (postSec.length) info.postSecondary = postSec;

    const ncaa = parseNCAA(text);
    if (ncaa) info.ncaa = ncaa;

    const sched = parseScheduling(text);
    if (sched) info.scheduling = sched;

    // Overview from header
    const overview = parseOverview(text);
    if (overview) info.overview = overview;

    return Object.keys(info).length > 0 ? info : null;
  }

  function parseGradReqsBlock(block) {
    const reqs = [];
    const lines = block.split('\n').slice(1); // skip header row
    for (const line of lines) {
      // Format: "a. | History/Social Science | 30 credits..." or "| Health Education | 5 credits | N/A"
      const parts = line.split('|').map(s => s.trim());
      if (parts.length < 3) continue;
      const areaRaw = parts[0].replace(/\./g, '').trim();
      const area = /^[a-g]$/i.test(areaRaw) ? areaRaw.toLowerCase() : '\u2014';
      const subject = parts[1];
      if (!subject || subject.length < 3) continue;
      const juhsd = parts[2] || '';
      const ucCsu = parts[3] || '';
      reqs.push({ area, subject, juhsd, note: '', ucCsu });
    }
    return reqs.length > 0 ? reqs : undefined;
  }

  function parseFourYearBlock(block) {
    const plan = { grade9: [], grade10: [], grade11: [], grade12: [] };
    let current = null;
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (/^9th\s*Grade/i.test(t)) current = 'grade9';
      else if (/^10th\s*Grade/i.test(t)) current = 'grade10';
      else if (/^11th\s*Grade/i.test(t)) current = 'grade11';
      else if (/^12th\s*Grade/i.test(t)) current = 'grade12';
      else if (current && /^\d+\.\s*(.+)/.test(t)) {
        plan[current].push(t.replace(/^\d+\.\s*/, '').trim());
      }
    }
    return plan;
  }

  function parseAgListBlock(block) {
    const agList = {};
    const areaLabels = {
      a: 'History / Social Science', b: 'English', c: 'Mathematics',
      d: 'Laboratory Science', e: 'Language Other Than English',
      f: 'Visual & Performing Arts', g: 'College Preparatory Electives'
    };
    let currentArea = null;
    let courses = [];

    const lines = block.split(/[\n|]/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      // Check for area header like "b. English" or "c.\tMathematics" (must have letter-dot prefix)
      // Also match standalone headers like "History/Social Science" (short lines, no CP/AP suffix)
      const letterArea = line.match(/^([a-g])[\.\s]+\s*(.+)/i);
      const labelArea = !letterArea && line.length < 40 &&
                        !/\b(CP|AP|ELD)\b/i.test(line) &&
                        line.match(/^(History.*Social\s*Science|English|Mathematics|Laboratory\s*Science|Language.*Other.*English|Visual.*Performing\s*Arts|College.*Prep.*Elective)/i);
      if (letterArea || labelArea) {
        // Save previous area
        if (currentArea && courses.length) {
          agList[currentArea] = { label: areaLabels[currentArea] || '', required: '', courses: [...courses] };
        }
        if (letterArea && /^[a-g]$/i.test(letterArea[1])) {
          currentArea = letterArea[1].toLowerCase();
        } else {
          const label = (labelArea ? labelArea[1] : (letterArea ? letterArea[2] : line)).toLowerCase();
          if (/history|social/i.test(label)) currentArea = 'a';
          else if (/^english$/i.test(label)) currentArea = 'b';
          else if (/math/i.test(label)) currentArea = 'c';
          else if (/lab|science/i.test(label)) currentArea = 'd';
          else if (/language|other/i.test(label)) currentArea = 'e';
          else if (/visual|performing/i.test(label)) currentArea = 'f';
          else if (/elective|prep/i.test(label)) currentArea = 'g';
        }
        courses = [];
        continue;
      }
      // Course line: text that looks like a course name
      if (currentArea && line.length > 3 && !/^\*|^Courses in|^This course|^Students may/i.test(line)) {
        courses.push(line);
      }
    }
    // Save last area
    if (currentArea && courses.length) {
      agList[currentArea] = { label: areaLabels[currentArea] || '', required: '', courses: [...courses] };
    }
    return Object.keys(agList).length > 0 ? agList : undefined;
  }

  function parseCounselorsBlock(block) {
    const counselors = [];
    const lines = block.split('\n').map(s => s.trim()).filter(Boolean);
    let i = 0;
    while (i < lines.length) {
      // Pattern: Name, then caseload (Last Names:...), phone, email
      const name = lines[i];
      if (!name || /^---/.test(name)) { i++; continue; }
      const caseload = (i + 1 < lines.length) ? lines[i + 1] : '';
      const phoneLine = (i + 2 < lines.length) ? lines[i + 2] : '';
      const emailLine = (i + 3 < lines.length) ? lines[i + 3] : '';

      const phoneMatch = phoneLine.match(/\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4}/);
      const emailMatch = emailLine.match(/[\w.]+@[\w.]+/);

      if (phoneMatch || emailMatch) {
        counselors.push({
          name: name,
          caseload: caseload.replace(/^Last\s*Names?:\s*/i, 'Last Names: '),
          phone: phoneMatch ? phoneMatch[0] : '',
          email: emailMatch ? emailMatch[0] : ''
        });
        i += 4;
      } else {
        i++;
      }
    }
    return counselors.length > 0 ? counselors : undefined;
  }

  function parsePostSecondary(text) {
    // Find the Post Secondary section (the one followed by actual UC/CSU content, not table of contents)
    const sectionMatch = text.match(/Post\s*Secondary\s*Opportunities\s*\n\s*\n\s*(University of California[\s\S]*?)(?=\n\n(?:2\d{3}-\d{4}|Tentative|Course Offerings|STUDENT ATHLETES|---\s*TABLE))/i);
    if (!sectionMatch) return [];

    const section = sectionMatch[1];
    const entries = [];
    const patterns = [
      { re: /University of California \(UC\)\s*\n([\s\S]*?)(?=\nCalifornia State University)/i, title: 'University of California (UC)' },
      { re: /California State University \(CSU\)\s*\n([\s\S]*?)(?=\nPrivate Colleges)/i, title: 'California State University (CSU)' },
      { re: /Private Colleges\s*\n([\s\S]*?)(?=\nCommunity Colleges)/i, title: 'Private Colleges' },
      { re: /Community Colleges\s*\n([\s\S]*?)(?=\nTechnical)/i, title: 'Community Colleges' },
      { re: /Technical, Trade,?\s*(?:and|&)\s*Business Schools\s*\n([\s\S]*?)(?=\nApprenticeship)/i, title: 'Technical, Trade & Business Schools' },
      { re: /Apprenticeship Programs\s*\n([\s\S]*?)$/i, title: 'Apprenticeship Programs' },
    ];
    for (const { re, title } of patterns) {
      const m = section.match(re);
      if (m) {
        const body = m[1].trim().split('\n').filter(l => l.trim()).join(' ').trim();
        if (body.length > 20) entries.push({ title, text: body });
      }
    }
    return entries;
  }

  function parseNCAA(text) {
    const d1Match = text.match(/DIVISION I\s*\n([\s\S]*?)(?=DIVISION II)/i);
    const d2Match = text.match(/DIVISION II\s*\n([\s\S]*?)(?=\n\n\n|\n(?:Jefferson|Scheduling|Counseling|---|\n\n))/i);
    if (!d1Match) return null;

    function parseDivision(block) {
      const reqs = [];
      const lines = block.split('\n');
      let gpa = '', notes = '';
      for (const line of lines) {
        const t = line.trim();
        const yrMatch = t.match(/^(\d+)\s*years?\s+(?:of\s+)?(.+)/i);
        if (yrMatch) reqs.push({ years: yrMatch[1], subject: yrMatch[2].trim() });
        const gpaMatch = t.match(/GPA[\-\s]*Earn at least a\s*([\d.]+)/i);
        if (gpaMatch) gpa = gpaMatch[1];
        if (/^(Complete|Test Scores)/i.test(t)) notes += (notes ? ' ' : '') + t;
      }
      return { reqs, gpa, notes };
    }

    const d1 = parseDivision(d1Match[1]);
    const d2 = d2Match ? parseDivision(d2Match[1]) : { reqs: [], gpa: '', notes: '' };
    return {
      d1GPA: d1.gpa, d1Notes: d1.notes, d1: d1.reqs,
      d2GPA: d2.gpa, d2Notes: d2.notes, d2: d2.reqs
    };
  }

  function parseScheduling(text) {
    const schedMatch = text.match(/Scheduling Procedures\s*\n\s*\nClass Changes\s*\n([\s\S]*?)(?=Advanced Placement|Counseling Contacts|Websites of Interest|---)/i);
    const apMatch = text.match(/Advanced Placement Commitment\s*\n([\s\S]*?)(?=\n\n\n|Counseling Contacts|Websites|---)/i);
    if (!schedMatch) return null;

    const block = schedMatch[1];
    // Extract deadline info
    const fallMatch = block.match(/within the (first[^,]+fall\s+(?:semester|quarter))/i);
    const springMatch = block.match(/(?:and\s+)?(first[^.]+spring\s+(?:semester|quarter))/i);
    const deadlineFall = fallMatch ? fallMatch[1].trim() : '';
    const deadlineSpring = springMatch ? springMatch[1].trim() : '';
    const reasonsMatch = block.match(/based on the following reasons?:\s*([^.]+)/i);
    const allowedReasons = reasonsMatch ? reasonsMatch[1].trim() : '';

    // Extract numbered steps — handle multi-line steps with tab/space indentation
    const steps = [];
    const stepRegex = /\t(\d+)\.\s*([\s\S]*?)(?=\t\d+\.|$)/g;
    let stepMatch;
    while ((stepMatch = stepRegex.exec(block)) !== null) {
      steps.push(stepMatch[2].replace(/\s+/g, ' ').trim());
    }

    const apPolicy = apMatch ? apMatch[1].replace(/\s+/g, ' ').trim() : '';

    return { deadlineFall, deadlineSpring, allowedReasons, conflictSteps: steps, apPolicy };
  }

  function parseOverview(text) {
    // Extract motto/tagline from header area
    const mottoMatch = text.match(/^(.+)\n\n-Go\s+/m);
    const tagline = mottoMatch ? mottoMatch[1].trim() : '';

    // Diploma credits
    const credMatch = text.match(/minimum of\s+(\d+)\s+credits/i);
    const diplomaCredits = credMatch ? parseInt(credMatch[1]) : 0;

    // a-g requirements
    const agMinMatch = text.match(/minimum of\s+(\d+)\s+[""\u201c]?a-g/i);
    const agMin = agMinMatch ? parseInt(agMinMatch[1]) : 0;

    const juniorMatch = text.match(/(\d+)\s+courses?\s+need\s+to\s+be\s+completed\s+by\s+the\s+end\s+of\s+junior/i);
    const agByJunior = juniorMatch ? parseInt(juniorMatch[1]) : 0;

    const ucGpaMatch = text.match(/Minimum GPA required for UC[\-:\s]*(\d+\.?\d*)/i);
    const csuGpaMatch = text.match(/Minimum GPA required for CSU[\-:\s]*(\d+\.?\d*)/i);

    if (!tagline && !diplomaCredits) return null;
    return {
      tagline: tagline || '',
      diplomaCredits: diplomaCredits || 225,
      agMin: agMin || 15,
      agByJunior: agByJunior || 11,
      ucGPA: ucGpaMatch ? ucGpaMatch[1] : '3.0',
      csuGPA: csuGpaMatch ? csuGpaMatch[1] : '2.5'
    };
  }

  /* ═══════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════ */
  window.CatalogImporter = {
    extractText,
    heuristicParse,
    parseInfoPages,
    aiParse,
    getApiKey,
    setApiKey,
    getApiModel,
    setApiModel,
    // Expose sub-parsers for testing
    _parseTableMarkerFormat: parseTableMarkerFormat,
    _parseGenericFormat: parseGenericFormat
  };
})();
