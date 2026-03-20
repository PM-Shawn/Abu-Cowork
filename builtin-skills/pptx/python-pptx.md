# python-pptx Tutorial

## Setup & Basic Structure

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

prs = Presentation()
prs.slide_width = Inches(13.333)  # 16:9 widescreen
prs.slide_height = Inches(7.5)

slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank layout

prs.save("output.pptx")
```

## Layout Dimensions

Slide dimensions (16:9 widescreen):
- Width: 13.333" (Inches(13.333))
- Height: 7.5" (Inches(7.5))

Margins: keep ≥ 0.5" from edges.

---

## Text

```python
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

# Basic text box
txBox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(1.5))
tf = txBox.text_frame
tf.word_wrap = True

p = tf.paragraphs[0]
p.text = "Title Text"
p.font.size = Pt(36)
p.font.bold = True
p.font.color.rgb = RGBColor(0x1E, 0x27, 0x61)
p.alignment = PP_ALIGN.LEFT

# Add another paragraph
p2 = tf.add_paragraph()
p2.text = "Subtitle or body text"
p2.font.size = Pt(16)
p2.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
p2.space_before = Pt(12)
```

### Rich text (mixed formatting in one paragraph)

```python
p = tf.add_paragraph()
run1 = p.add_run()
run1.text = "Bold part "
run1.font.bold = True
run1.font.size = Pt(14)

run2 = p.add_run()
run2.text = "normal part"
run2.font.size = Pt(14)
```

### Bullets

```python
# Simple bullet approach
for item in items:
    p = tf.add_paragraph()
    p.text = f"• {item}"
    p.font.size = Pt(14)
    p.space_before = Pt(4)
```

---

## Shapes

```python
from pptx.enum.shapes import MSO_SHAPE

# Rectangle
shape = slide.shapes.add_shape(
    MSO_SHAPE.RECTANGLE, Inches(0.5), Inches(0.5), Inches(3), Inches(2)
)
shape.fill.solid()
shape.fill.fore_color.rgb = RGBColor(0x1E, 0x27, 0x61)
shape.line.fill.background()  # no border

# Rounded rectangle
shape = slide.shapes.add_shape(
    MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1), Inches(1), Inches(3), Inches(2)
)
shape.fill.solid()
shape.fill.fore_color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

# Oval / circle
shape = slide.shapes.add_shape(
    MSO_SHAPE.OVAL, Inches(1), Inches(1), Inches(1), Inches(1)
)
shape.fill.solid()
shape.fill.fore_color.rgb = RGBColor(0x00, 0x88, 0xCC)

# Line (thin rectangle)
shape = slide.shapes.add_shape(
    MSO_SHAPE.RECTANGLE, Inches(0.5), Inches(3), Inches(12), Pt(2)
)
shape.fill.solid()
shape.fill.fore_color.rgb = RGBColor(0xCC, 0xCC, 0xCC)
shape.line.fill.background()

# Shape with text
shape = slide.shapes.add_shape(
    MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1), Inches(1), Inches(2.5), Inches(1.5)
)
shape.fill.solid()
shape.fill.fore_color.rgb = RGBColor(0x1E, 0x27, 0x61)
tf = shape.text_frame
tf.word_wrap = True
p = tf.paragraphs[0]
p.text = "Card Title"
p.font.size = Pt(16)
p.font.bold = True
p.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
p.alignment = PP_ALIGN.CENTER
```

---

## Images

```python
# From file
slide.shapes.add_picture("chart.png", Inches(1), Inches(1), width=Inches(5))

# Preserve aspect ratio — specify only width OR height, not both
pic = slide.shapes.add_picture("photo.jpg", Inches(1), Inches(1), width=Inches(4))
```

---

## Tables

```python
rows, cols = 4, 3
table_shape = slide.shapes.add_table(rows, cols, Inches(1), Inches(2), Inches(10), Inches(3))
table = table_shape.table

# Header row
for i, header in enumerate(["Category", "Description", "Status"]):
    cell = table.cell(0, i)
    cell.text = header
    p = cell.text_frame.paragraphs[0]
    p.font.bold = True
    p.font.size = Pt(14)
    p.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    cell.fill.solid()
    cell.fill.fore_color.rgb = RGBColor(0x1E, 0x27, 0x61)

# Data rows
data = [["Item 1", "Description", "Done"], ...]
for row_idx, row_data in enumerate(data, start=1):
    for col_idx, value in enumerate(row_data):
        cell = table.cell(row_idx, col_idx)
        cell.text = value
        cell.text_frame.paragraphs[0].font.size = Pt(12)
```

---

## Charts

```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE

chart_data = CategoryChartData()
chart_data.categories = ['Q1', 'Q2', 'Q3', 'Q4']
chart_data.add_series('Revenue', (120, 150, 180, 200))

chart_frame = slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED,
    Inches(1), Inches(2), Inches(8), Inches(4),
    chart_data
)
```

---

## Slide Background

```python
background = slide.background
fill = background.fill
fill.solid()
fill.fore_color.rgb = RGBColor(0x1E, 0x27, 0x61)
```

---

## Common Patterns

### Title Slide

```python
slide = prs.slides.add_slide(prs.slide_layouts[6])
bg = slide.background.fill
bg.solid()
bg.fore_color.rgb = RGBColor(0x1E, 0x27, 0x61)

txBox = slide.shapes.add_textbox(Inches(1), Inches(2.5), Inches(11), Inches(1.5))
p = txBox.text_frame.paragraphs[0]
p.text = "Presentation Title"
p.font.size = Pt(44)
p.font.bold = True
p.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
p.alignment = PP_ALIGN.CENTER
```

### Two-Column Layout

```python
left_box = slide.shapes.add_textbox(Inches(0.8), Inches(1.5), Inches(5.5), Inches(5))
right_box = slide.shapes.add_textbox(Inches(7), Inches(1.5), Inches(5.5), Inches(5))
```

### Card Grid (2x2)

```python
positions = [
    (Inches(0.8), Inches(1.5)),  (Inches(6.8), Inches(1.5)),
    (Inches(0.8), Inches(4.2)),  (Inches(6.8), Inches(4.2)),
]
card_w, card_h = Inches(5.5), Inches(2.3)
for x, y in positions:
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, card_w, card_h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = RGBColor(0xF8, 0xF8, 0xF8)
```

---

## Color Palettes

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | `1E2761` | `CADCFC` | `FFFFFF` |
| **Forest & Moss** | `2C5F2D` | `97BC62` | `F5F5F5` |
| **Coral Energy** | `F96167` | `F9E795` | `2F3C7E` |
| **Ocean Gradient** | `065A82` | `1C7293` | `21295C` |
| **Charcoal Minimal** | `36454F` | `F2F2F2` | `212121` |

---

## Common Pitfalls

1. **Use `RGBColor(0xRR, 0xGG, 0xBB)`** — python-pptx uses int tuples, not string hex
2. **Always use `Inches()` or `Pt()`** — raw numbers are EMUs
3. **`prs.slide_layouts[6]`** = blank layout (safest)
4. **Set `word_wrap = True`** on text frames or text will overflow
5. **Save to `/tmp/`** or the user's workspace directory
6. **Import `MSO_SHAPE`** from `pptx.enum.shapes` for shape types
