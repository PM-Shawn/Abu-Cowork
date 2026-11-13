# Attribution

`scripts/remove_chroma_key.py` is adapted from the `imagegen` skill of OpenAI
Codex (`scripts/remove_chroma_key.py`), licensed under the Apache License,
Version 2.0 (see `LICENSE.txt`). The prompt-structure guidance in `SKILL.md`
(purpose / subject / scene / style / composition / exact text / keep / avoid,
"change only X, keep everything else", one image per call, generate on a flat
key color for transparency) follows the ideas of the same skill.

Modifications: vectorised with numpy; Seedream-oriented guidance; border-only
mode; edge band un-mixing against locally estimated subject and background
colors; auto key limited to green or magenta; tolerant input modes; EXIF and
ICC handling; refuses to replace an existing output unless --force;
Windows-safe output.
