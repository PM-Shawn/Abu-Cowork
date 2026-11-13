---
name: image-gen
description: Craft better prompts and deliver finished pictures with generate_image (Seedream) for office work - posters, covers, report and slide illustrations, product shots, icons, and transparent-background PNGs. Covers the prompt structure, sizes for slides/posters/social media, editing vs regenerating, and a green-screen workflow that turns a flat-color background into real transparency.
display-description:
  zh-CN: 把海报、封面、配图、产品图、图标生成得更准，并能输出透明底 PNG
  en-US: "Get posters, covers, illustrations, product shots and icons right, including transparent PNGs"
trigger: 用户要生成、画或改图片：海报、封面、汇报或 PPT 配图、插画、产品图、图标、头像、Logo 草图，或要透明底的新图
do-not-trigger: 用户只要 Word/PPT/PDF 文件、没要新图；图表流程图（show_widget、svg-diagram）；缩放裁剪转格式（process_image）；换自己照片的底色或抠图
tags:
  - 生成图片
  - 海报
  - 配图
  - 透明背景
  - image
  - poster
  - illustration
  - icon
license: Apache-2.0 for the adapted parts, see NOTICE.md
---

You make pictures with `generate_image` (Volcano Seedream) and finish them for office use. Generated pictures are for photos, illustrations, posters and icons; never for charts, tables or diagrams.

## Before you call the tool

1. Work out the purpose (slide, report cover, poster, social post, icon) and the shape it must fit. Ask one short question only if you cannot guess either.
2. If the request is already specific, tidy it into the structure below and add nothing of your own. If it is vague, fill in only purpose, composition and style.
3. One call per distinct picture. Make several variants only when the user asks for choices; each call costs money.
4. When the picture goes into a file you are building, pass `save_path` next to that file instead of the default Downloads folder.

## Prompt structure

Write the prompt in Chinese, as plain sentences, in this order, skipping what does not apply:

- Purpose and format: "PPT 封面配图，16:9"
- Subject: who or what, with the two or three details that matter
- Scene and background
- Style: photo, flat vector illustration, 3D render, watercolor, ink; one style, not five
- Composition and light: "主体居中，左侧留白放标题", "柔和侧光"
- Text in the picture: quote it exactly, say where it goes, keep it short: 标题为"2026 年度总结"，位于顶部居中，黑体
- Keep: what must not change (for edits)
- Avoid: "不要水印、不要多余文字、不要变形的手"

Seedream follows natural Chinese well and renders Chinese titles accurately when they are short (about 10 characters, one or two lines). For a long slogan, a price list or small print, generate the picture without text and add the words in the document or slide, where they stay editable and exact. Never use image generation for numbers the reader will check.

## Sizes

Pass an explicit `WxH` from the table: it is accepted by every Seedream 4.0 and later model. When unsure, pass `2K` (also accepted everywhere) and write the ratio in the prompt. Do not pass `1K` or `1.5K`; only the 5.0 pro and flash models take them. If the call fails on the size, retry once without `size`.

| Use | Ratio | size |
|---|---|---|
| Slide, cover, banner | 16:9 | 2560x1440 |
| Older 4:3 slides, 小红书 landscape | 4:3 | 2304x1728 |
| Social square, avatar, icon | 1:1 | 2048x2048 |
| 小红书, 朋友圈 portrait | 3:4 | 1728x2304 |
| Phone story, 短视频 cover | 9:16 | 1440x2560 |
| A4 poster or flyer (portrait) | 1:1.414 | 1696x2400 |
| WeChat article header | 7:3 | 3024x1296 |

Leave empty space where a title or logo will sit, and keep the subject away from the edges if the picture will be cropped. To shrink the file for a document, use `process_image` afterwards, not a smaller `size`.

## Edit or regenerate

- The composition, subject or mood is wrong: regenerate with a changed prompt.
- The picture is right except one thing (a color, an object, the background, the text): edit by passing the picture in `reference_images`, and say "只改X，其余保持不变" in every round. Change one thing per round; the model drifts when asked for several.
- To use the user's own photo, logo or product, pass it as a reference image and describe the new scene around it: "把图1的产品放到木桌上，窗边自然光".
- Two failed edits in a row, or the tool says reference images are not supported: regenerate from a fixed prompt instead.

## After generating

If you can view the picture, check it once against the request: subject, every piece of text (wrong characters are the common fault), the shape. Fix a flaw with one targeted edit. Then tell the user where the file is, in plain words, and offer the one next step that fits (put it in the slide, make a transparent version).

## Transparent background (icons, product cutouts, stickers)

Only for pictures you generate yourself. Do not redraw a user's own photo onto green to change its background; say that this is not something you can do well here.

Do not promise that the model draws transparency; it paints a background. Use a green screen:

1. Generate on a flat key color. Add to the prompt: "背景为纯色 #00FF00 绿幕，平整无渐变、无阴影、无地面倒影、无光晕；主体完整、边缘清晰，不贴近画面边缘；主体中不含绿色". If the subject is green or has green parts, use magenta `#FF00FF` instead.
2. Remove the key color (Windows and macOS, bundled Python). Use a new file name for `--out`; the script refuses to replace an existing file:

```
python "${ABU_SKILL_DIR}/scripts/remove_chroma_key.py" --input "<picture>.png" --out "<picture>-transparent.png"
```

   It finds the green or magenta screen on the border by itself and softens the edges. A big picture can take over a minute, so give the command a longer `timeout` (180). If a faint green or pink rim remains, add `--edge-contract 1`. Exit code 3 means the background is not a flat green or magenta screen: nothing is written, so regenerate on a pure screen. A warning that part of the picture is see-through away from its edge means a part of the subject has the screen color: regenerate on the other screen color. A warning that most of the picture is only partly transparent means the cutout is not clean: regenerate with a hard-edged subject.
3. Check the result by pasting it onto a white and a dark background with Pillow (look at both if you can view images; otherwise rely on the printed pixel counts); hair, glass and soft shadows are the hard cases. Soft shadows and glass do not survive a cutout; say so rather than hiding it, and regenerate with a hard-edged subject.

Deliver the PNG, not a JPG. Keep the original green-screen picture next to it in case the user wants another cutout.
