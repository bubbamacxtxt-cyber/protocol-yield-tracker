# Protocol Yield Tracker — Brand Kit

Single source of truth for all visual design decisions.
Reference this file when building new pages, components, or features.

---

## Typography

### Font Stack (3-font system)
| Font | Weight | Use For | Google Fonts |
|------|--------|---------|--------------|
| **Space Grotesk** | 500, 600, 700 | Headers, card labels, section titles, buttons, filter labels, table headers, subtitles | `family=Space+Grotesk:wght@500;600;700` |
| **JetBrains Mono** | 400, 500, 600 | All data: table cells, numbers, values, APYs, addresses, timestamps, token names, proto chips, filter inputs, card subtitles | `family=JetBrains+Mono:wght@400;500;600` |
| **Inter** | 400, 500, 600, 700 | Body text, paragraphs, descriptions (rarely used beyond body copy) | `family=Inter:wght@400;500;600;700` |

### Load string (copy-paste)
```
https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap
```

### Font Sizes
| Element | Size | Font |
|---------|------|------|
| Page title (h1) | 28px | Space Grotesk 700 |
| Section header (h2) | 20px | Space Grotesk 600 |
| Card header (h3) | 16-18px | Space Grotesk 600 |
| Card label | 12px uppercase | Space Grotesk 500 |
| Card value | 28px | JetBrains Mono 700 |
| Card subtitle | 12px | JetBrains Mono 400 |
| Table header (th) | 11px uppercase | Space Grotesk 500 |
| Table cell (td) | 13px | JetBrains Mono 400 |
| Body text | 14px | Inter 400 |
| Small/meta | 12px | JetBrains Mono 400 |

---

## Colors

### CSS Variables (`:root`)
```css
--bg-primary: #0d1117;
--bg-secondary: #161b22;
--bg-card: #1c2128;
--border: #30363d;
--text-primary: #ffffff;
--text-secondary: #c9d1d9;
--accent-blue: #58a6ff;
--accent-green: #4ade80;
--accent-purple: #a371f7;
--accent-orange: #d29922;
```

### Semantic Usage
| Purpose | Color |
|---------|-------|
| Positive value / money | `--accent-green` (#4ade80) |
| Negative value / loss | #f85149 |
| Links / interactive | `--accent-blue` (#58a6ff) |
| Hover accent border | `--accent-blue` |
| Warning | `--accent-orange` (#d29922) |
| Health factor safe | `--accent-green` |
| Health factor warning | `--accent-orange` |
| Health factor danger | #f85149 |
| Table header background | #0d2137 |
| Scrollbar track | #0d1117 |
| Scrollbar thumb | #30363d |
| Scrollbar thumb hover | #484f58 |

---

## Gradients

### CSS Variables
```css
--gradient-1: linear-gradient(135deg, #0D47A1 0%, #00E5FF 100%);  /* blue-cyan */
--gradient-2: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);  /* pink-red */
--gradient-3: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);  /* teal (primary) */
--gradient-4: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);  /* green-teal */
--gradient-blue: linear-gradient(175deg, #2a5a9a 0%, #1e4a8a 5%, #244888a0 50%, #0e2a4a 100%);
--gradient-teal: var(--gradient-3);
--gradient-btn: linear-gradient(135deg, #1e3a5f 0%, #0d2137 100%);
```

### Usage
| Purpose | Gradient |
|---------|----------|
| Card value numbers | `--gradient-3` (teal) with background-clip: text |
| Page title text | `--gradient-3` (teal) with background-clip: text |
| Summary card backgrounds | `--gradient-blue` |
| Chart card backgrounds | `--gradient-blue` (same) |
| Buttons | `--gradient-btn` |
| Body background | `linear-gradient(180deg, #0a0e1a 0%, #0d1a2e 25%, #102240 50%, #142a4a 75%, #183354 100%)` |
| Whale card header | `--gradient-1` |

### Gradient Text Pattern
```css
background: var(--gradient-3);
-webkit-background-clip: text;
-webkit-text-fill-color: transparent;
background-clip: text;
```

---

## Gradients & Cards

### Card Default State
```css
border: 1px solid var(--border);        /* #30363d */
border-radius: 12px;
transition: transform 0.2s, border-color 0.2s;
```

### Card Hover State
```css
transform: translateY(-4px);
border-color: var(--accent-blue);       /* #58a6ff */
```

### Summary Card (home page top row)
```css
background: linear-gradient(175deg, #2a5a9a 0%, #1e4a8a 5%, #244888a0 50%, #0e2a4a 100%);
box-shadow: inset 0 1px 0 rgba(200,220,255,0.25), ...;
```

---

## Spacing & Layout

### Card Grid
```css
display: grid;
grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
gap: 16px;
```

### Container
```css
max-width: 1200px;
margin: 0 auto;
padding: 32px 24px;
```

### Border Radius
| Element | Radius |
|---------|--------|
| Cards | 12px |
| Buttons | 8px |
| Chips/badges | 6px |
| Scrollbar thumb | 3px |

---

## Scrollbar (dark, matches home YBS list)
```css
scrollbar-width: thin;
scrollbar-color: #30363d #0d1117;

&::-webkit-scrollbar { width: 6px; }
&::-webkit-scrollbar-track { background: #0d1117; }
&::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
&::-webkit-scrollbar-thumb:hover { background: #484f58; }
```

---

## Animation

### Hover lift
```css
transition: transform 0.2s, border-color 0.2s;
/* hover: */ transform: translateY(-4px);
```

### Hover glow
```css
transition: transform 0.2s, border-color 0.2s;
/* hover: */ border-color: var(--accent-blue);
```

---

## File Locations
- Home page: `index.html` (inline styles)
- Whale pages: `whale-common.css` + `whale-common.js`
- Data export: `src/export.js` → `data.json`
- This file: `BRAND-KIT.md` (root of repo)

---

_Last updated: 2026-04-27_
