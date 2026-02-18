const urlInput = document.getElementById('urlInput');
const htmlInput = document.getElementById('htmlInput');
const fetchBtn = document.getElementById('fetchBtn');
const analyzeBtn = document.getElementById('analyzeBtn');
const clearBtn = document.getElementById('clearBtn');
const results = document.getElementById('results');
const filterInput = document.getElementById('filterInput');
const xpathMode = document.getElementById('xpathMode');
const proxyFallbackToggle = document.getElementById('proxyFallbackToggle');
const textOnlyToggle = document.getElementById('textOnlyToggle');
const elementCount = document.getElementById('elementCount');
const modeValue = document.getElementById('modeValue');
const statusValue = document.getElementById('statusValue');

let currentItems = [];

function setStatus(mode, status) {
  modeValue.textContent = mode;
  statusValue.textContent = status;
}

function setStatusError(mode, status) {
  modeValue.textContent = mode;
  statusValue.textContent = status;
  console.error(status);
}

function normalizeUrl(raw) {
  if (!raw) return '';
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url;
}

function stripScheme(url) {
  return url.replace(/^https?:\/\//i, '');
}

function buildProxyUrls(targetUrl) {
  const noScheme = stripScheme(targetUrl);
  return [
    `https://r.jina.ai/http://${targetUrl}`,
    `https://r.jina.ai/http://https://${noScheme}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
  ];
}

async function fetchViaBackend(targetUrl) {
  const response = await fetch('/api/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: targetUrl })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Backend error (${response.status})`);
  }

  return response.text();
}

function looksLikeHtml(text) {
  if (!text) return false;
  const snippet = text.slice(0, 2000).toLowerCase();
  return snippet.includes('<html') || snippet.includes('<body') || snippet.includes('<div');
}

async function fetchHtml() {
  const url = normalizeUrl(urlInput.value);
  if (!url) {
    setStatusError('URL', 'Please enter a URL.');
    return;
  }

  setStatus('URL', 'Fetching...');
  try {
    let text = '';
    let usedBackend = false;

    try {
      text = await fetchViaBackend(url);
      usedBackend = true;
    } catch (err) {
      if (!proxyFallbackToggle?.checked) {
        throw err;
      }

      const proxyUrls = buildProxyUrls(url);
      let lastError = err?.message || '';

      for (const proxyUrl of proxyUrls) {
        try {
          const response = await fetch(proxyUrl);
          if (!response.ok) {
            lastError = `Fetch failed (${response.status})`;
            continue;
          }
          text = await response.text();
          if (looksLikeHtml(text)) break;
        } catch (innerErr) {
          lastError = 'Network error';
        }
      }

      if (!text) {
        throw new Error(lastError || 'Fetch failed');
      }
    }

    htmlInput.value = text;
    if (!looksLikeHtml(text)) {
      const hint = usedBackend
        ? 'Fetched content is not full HTML (site may block bots). Paste page source for best results.'
        : 'Fetched text is not full HTML. Paste page source for best results.';
      setStatus('URL', hint);
    } else {
      setStatus('URL', usedBackend ? 'HTML loaded (Playwright).' : 'HTML loaded.');
    }
    analyzeHtml();
  } catch (err) {
    setStatusError('URL', `Fetch failed: ${err.message || 'Unknown error'}`);
  }
}

function getXPath(element, documentRoot) {
  if (!element || element.nodeType !== 1) return '';

  const id = element.getAttribute('id');
  if (id) {
    const match = documentRoot.querySelectorAll(`#${CSS.escape(id)}`);
    if (match.length === 1) {
      return `//*[@id="${id}"]`;
    }
  }

  const segments = [];
  let current = element;

  while (current && current.nodeType === 1) {
    const tag = current.tagName.toLowerCase();
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) {
        index += 1;
      }
      sibling = sibling.previousElementSibling;
    }
    segments.unshift(`/${tag}[${index}]`);
    if (current === documentRoot.documentElement) break;
    current = current.parentElement;
  }

  return segments.join('');
}

function xpathLiteral(text) {
  if (text.includes('"') && text.includes("'")) {
    const parts = text.split('"');
    return `concat("${parts.join('", \'"\', "')}")`;
  }
  if (text.includes('"')) return `'${text}'`;
  return `"${text}"`;
}

function countXPath(xpath, documentRoot) {
  const result = documentRoot.evaluate(
    xpath,
    documentRoot,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null
  );
  return result.snapshotLength;
}

function buildAttrXPath(tag, attr, value) {
  return `//${tag}[@${attr}=${xpathLiteral(value)}]`;
}

function buildTextXPath(tag, text) {
  return `//${tag}[normalize-space(.)=${xpathLiteral(text)}]`;
}

function getStableXPath(element, documentRoot) {
  const tag = element.tagName.toLowerCase();

  const id = element.getAttribute('id');
  if (id) {
    const xpath = `//*[@id=${xpathLiteral(id)}]`;
    if (countXPath(xpath, documentRoot) === 1) return xpath;
  }

  const attrPriority = [
    'data-testid',
    'data-test',
    'data-qa',
    'name',
    'aria-label',
    'role',
    'title',
    'alt',
    'placeholder',
    'type',
    'href',
    'value'
  ];

  for (const attr of attrPriority) {
    const value = element.getAttribute(attr);
    if (!value) continue;
    const xpath = buildAttrXPath(tag, attr, value);
    if (countXPath(xpath, documentRoot) === 1) return xpath;
  }

  const text = element.textContent ? element.textContent.trim().replace(/\s+/g, ' ') : '';
  if (text && text.length <= 80) {
    const xpath = buildTextXPath(tag, text);
    if (countXPath(xpath, documentRoot) === 1) return xpath;
  }

  return getXPath(element, documentRoot);
}

function describeElement(element) {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const className = element.className && typeof element.className === 'string'
    ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  const text = element.textContent ? element.textContent.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  return {
    label: `${tag}${id}${className}`,
    text,
    attrs: element.attributes.length
  };
}

function analyzeHtml() {
  const source = htmlInput.value.trim();
  if (!source) {
    setStatusError('HTML', 'Paste HTML or fetch it first.');
    return;
  }

  setStatus('HTML', 'Analyzing...');
  const parser = new DOMParser();
  const doc = parser.parseFromString(source, 'text/html');
  const allElements = Array.from(doc.querySelectorAll('*'));

  currentItems = allElements.map((el) => {
    const meta = describeElement(el);
    const xpath = xpathMode?.value === 'absolute'
      ? getXPath(el, doc)
      : getStableXPath(el, doc);
    return {
      tag: el.tagName.toLowerCase(),
      label: meta.label,
      text: meta.text,
      attrs: meta.attrs,
      xpath
    };
  });

  elementCount.textContent = currentItems.length.toString();
  setStatus('HTML', `Found ${currentItems.length} elements.`);
  renderResults();
}

function matchesFilter(item, filterValue) {
  if (!filterValue) return true;
  const haystack = `${item.tag} ${item.label} ${item.text} ${item.xpath}`.toLowerCase();
  return haystack.includes(filterValue);
}

function renderResults() {
  const filterValue = filterInput.value.trim().toLowerCase();
  const textOnly = textOnlyToggle.checked;
  const filtered = currentItems.filter((item) => {
    if (textOnly && !item.text) return false;
    return matchesFilter(item, filterValue);
  });

  results.innerHTML = '';

  if (filtered.length === 0) {
    results.innerHTML = '<div class="empty">No matching results.</div>';
    return;
  }

  for (const item of filtered) {
    const card = document.createElement('div');
    card.className = 'result-card';

    const info = document.createElement('div');
    info.innerHTML = `<strong>${item.label}</strong><div class="meta">Text: ${item.text || '—'} · Attrs: ${item.attrs}</div>`;

    const xpath = document.createElement('div');
    xpath.className = 'xpath';
    xpath.textContent = item.xpath;

    const copy = document.createElement('button');
    copy.className = 'copy-btn';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(item.xpath);
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    });

    card.appendChild(info);
    card.appendChild(xpath);
    card.appendChild(copy);
    results.appendChild(card);
  }
}

if (fetchBtn) {
  fetchBtn.addEventListener('click', fetchHtml);
}
analyzeBtn.addEventListener('click', analyzeHtml);
clearBtn.addEventListener('click', () => {
  htmlInput.value = '';
  urlInput.value = '';
  currentItems = [];
  elementCount.textContent = '0';
  results.innerHTML = '<div class="empty">No results yet. Provide a URL or HTML and click Analyze.</div>';
  setStatus('Idle', 'Cleared.');
});
filterInput.addEventListener('input', renderResults);
textOnlyToggle.addEventListener('change', renderResults);
xpathMode?.addEventListener('change', analyzeHtml);
